/**
 * The `publish` job — bump, tag, push, publish.
 *
 * Everything with a consequence happens here, behind the environment. By the
 * time this runs a reviewer from the shortlist has approved a plan they could
 * read, and this job's only job is to carry it out unchanged.
 *
 * ## Why the tag is pushed before `pnpm publish`
 *
 * There is no ordering that is atomic, so the question is which half-done state
 * is easier to live with:
 *
 *   * **Publish first, then tag.** A failure leaves a version on the registry
 *     that no commit is tagged with. npm does not allow republishing a version,
 *     so the only fix is to bump past it — the release is unrecoverable and the
 *     version number is burned.
 *   * **Tag first, then publish.** A failure leaves a tag and a `:bookmark:`
 *     commit on `main` for a version the registry does not have. Re-running the
 *     workflow fixes it: `publish-plan.ts` notices the manifest version is
 *     unpublished, proposes it again rather than bumping, and this job reuses the
 *     existing tag. Nothing is burned.
 *
 * The second is recoverable, so the tag goes first — which is also the order
 * asked for. What makes it tolerable is the dry run below: `pnpm publish
 * --dry-run` executes `prepublishOnly` (lint, coverage, build) and packs the
 * tarball, so the overwhelmingly likely reasons a publish fails have already
 * happened before anything is pushed.
 *
 * ## Why each step re-checks what it is about to do
 *
 * An environment approval can sit for hours. The plan is a claim about a commit,
 * and `assertPlanStillHolds` is what stops it being applied to a different one.
 * Beyond that, every mutation is skipped when it has already happened, which is
 * what makes re-running an interrupted release the recovery procedure rather
 * than a second problem.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as core from './lib/core.ts';
import { run, tryCapture } from './lib/exec.ts';
import * as git from './lib/git.ts';
import { bool, publishInputs as inputs } from './lib/inputs.ts';

interface Plan {
  name: string;
  version: string;
  tag: string;
  sha: string;
  resume: boolean;
  current: string;
}

const raw = process.env.CI_PLAN;
core.assert(raw, 'CI_PLAN is not set — the workflow must pass the plan job’s outputs');

const plan = JSON.parse(raw) as Plan;
const dryRun = bool(inputs['dry-run']);

core.info(`Publishing ${plan.name}@${plan.version} as ${plan.tag}${dryRun ? ' (dry run)' : ''}`);

// ---------------------------------------------------------------------------
// 1. The plan still describes this checkout.
// ---------------------------------------------------------------------------
assertPlanStillHolds();

// ---------------------------------------------------------------------------
// 2. Write the version.
//
// `npm version` is not used: it also creates a commit and a tag, with its own
// message format and its own opinion about a dirty tree, and there is no way to
// ask it for only the part wanted here. Editing the field keeps the commit and
// the tag under this script's control, where the gitmoji convention applies.
// ---------------------------------------------------------------------------
if (plan.resume) {
  core.info(`package.json is already at ${plan.version}; nothing to write.`);
} else {
  core.group(`Set version to ${plan.version}`, () => {
    writeVersion(plan.version);
  });
}

// ---------------------------------------------------------------------------
// 3. Rehearse the publish while nothing has been pushed yet.
//
// `--dry-run` runs the lifecycle scripts — `prepublishOnly` is lint + coverage +
// build in every modernized repo — and packs the tarball, doing everything a
// real publish does except the upload. It is the last point at which a failure
// costs nothing.
//
// `--no-git-checks` is required and only here: the tree is dirty at this point,
// because the version was just written and not yet committed.
// ---------------------------------------------------------------------------
core.group('Rehearse the publish', () => {
  run('pnpm', ['publish', '--dry-run', '--no-git-checks', '--tag', inputs['dist-tag']]);
});

if (dryRun) {
  core.warning('dry-run is set: stopping before any commit, tag, push or publish.');
  core.summary(`### Dry run\n\nWould have published \`${plan.name}@${plan.version}\` as \`${plan.tag}\`.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 4. Commit and tag.
// ---------------------------------------------------------------------------
git.configureBot();

if (!plan.resume) {
  core.group(`Commit :bookmark: ${plan.version}`, () => {
    // The subject follows the convention the rest of the history uses, so that a
    // release commit reads like every other commit and `publish-plan.ts` can
    // classify it — `:bookmark:` releases nothing, which is what stops a release
    // commit from implying the next release.
    git.commit(['package.json'], `:bookmark: ${plan.version}`);
  });
}

if (git.tagExists(plan.tag)) {
  core.info(`${plan.tag} already exists at HEAD; reusing it.`);
} else {
  core.group(`Tag ${plan.tag}`, () => {
    git.tag(plan.tag, `${plan.name}@${plan.version}`);
  });
}

// ---------------------------------------------------------------------------
// 5. Push both, or neither.
//
// This is the step that needs the GitHub Actions app listed as a bypass actor on
// the `pr-required` ruleset: `main` requires a pull request, and this pushes a
// commit straight to it. A push authenticated with GITHUB_TOKEN does not trigger
// workflows, so the release commit will not start a CI run of its own.
// ---------------------------------------------------------------------------
core.group(`Push ${inputs['release-branch']} and ${plan.tag}`, () => {
  git.pushAtomic(inputs['release-branch'], plan.tag);
});

// ---------------------------------------------------------------------------
// 6. Publish.
//
// No token and no `--provenance`: authentication is npm's trusted publishing,
// which the CLI negotiates over OIDC from `id-token: write`, and provenance
// attestations are produced automatically as a result. Nothing in this
// repository or the seven package repositories holds an npm credential.
//
// The git checks are left on this time. The tree is clean, the branch is the
// release branch, and the push above means it is level with the remote — so they
// pass, and they are worth having as one last assertion that this is publishing
// what was tagged.
// ---------------------------------------------------------------------------
if (isPublished()) {
  core.warning(`${plan.name}@${plan.version} is already on the registry; skipping the publish.`);
} else {
  core.group(`Publish ${plan.name}@${plan.version}`, () => {
    run('pnpm', ['publish', '--tag', inputs['dist-tag']]);
  });
}

// ---------------------------------------------------------------------------
// 7. Confirm from the registry, not from the exit code.
//
// The same rule the build job follows, for the same reason: a publish that
// reports success and did not land is a class of failure these packages have
// already met. This asks the registry what it has.
// ---------------------------------------------------------------------------
core.assert(
  isPublished(),
  `pnpm publish reported success but the registry does not serve ${plan.name}@${plan.version}`,
);

core.info(`✓ ${plan.name}@${plan.version} is live.`);

core.summary('## Published\n');
core.summary(`\`${plan.name}@${plan.version}\` — tagged \`${plan.tag}\`, dist-tag \`${inputs['dist-tag']}\`.\n`);
core.summary(`https://www.npmjs.com/package/${plan.name}/v/${plan.version}`);

/**
 * Fail unless the checkout is still the one the plan was computed against.
 *
 * The gap between the two jobs is however long the approval takes, and anything
 * merged in that window would otherwise be published under a version number
 * inferred without it — including, in the worst case, a commit added
 * specifically to ride along with an approval someone else requested.
 */
function assertPlanStillHolds(): void {
  git.assertFullHistory();

  const branch = git.currentBranch();
  core.assert(
    branch === inputs['release-branch'],
    `releases run from '${inputs['release-branch']}', not '${branch}'`,
  );

  const sha = git.head();
  core.assert(
    sha === plan.sha,
    `${branch} moved from ${plan.sha} to ${sha} while the release was awaiting approval — re-run the workflow so the plan is recomputed`,
  );

  core.assert(git.isClean(), 'the working tree is dirty before anything has been changed');

  const version = currentVersion();
  const expected = plan.resume ? plan.version : plan.current;
  core.assert(
    version === expected,
    `package.json is at ${version}, but the plan was computed against ${expected}`,
  );
}

function currentVersion(): string {
  return (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
}

/**
 * Rewrite the `version` field textually rather than re-serializing the manifest.
 *
 * `JSON.parse` → `JSON.stringify` would reformat the whole file: key order
 * survives, but indentation, the trailing newline and any deliberate formatting
 * do not, turning a one-line release commit into a whole-file diff.
 *
 * The two literal spaces in the pattern are what keep it from matching a nested
 * `"version"` — every manifest in the organization is two-space indented, so a
 * top-level key is the only one at that depth. A manifest formatted some other
 * way fails the assertion below rather than editing the wrong field.
 */
function writeVersion(version: string): void {
  const path = 'package.json';
  const before = readFileSync(path, 'utf8');
  const pattern = /^ {2}"version"(\s*:\s*)"[^"]*"/m;

  core.assert(pattern.test(before), 'could not find the version field in package.json');

  const after = before.replace(pattern, `  "version"$1"${version}"`);
  writeFileSync(path, after);

  core.assert(currentVersion() === version, `package.json did not take version ${version}`);
  core.info(`package.json: ${plan.current} → ${version}`);
}

/** Whether the registry serves the version being released. See `publish-plan.ts`. */
function isPublished(): boolean {
  return (
    (tryCapture('pnpm', ['view', `${plan.name}@${plan.version}`, 'version']) ?? '').trim() !== ''
  );
}
