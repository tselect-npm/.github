/**
 * The `plan` job — decide what would be released, and release nothing.
 *
 * This is deliberately a separate job from `publish`, and deliberately the one
 * that is *not* behind the environment. The whole point of gating publication on
 * a shortlist of reviewers is that the reviewer gets to look at something before
 * approving; a plan computed after the approval would be asking them to sign a
 * blank cheque. So this job runs first, unprivileged, and writes the version,
 * the tag and the commits behind them to the run summary. The approval prompt
 * then arrives with the answer already on screen.
 *
 * Every check that can fail cheaply fails here rather than in `publish`, for the
 * same reason: a release that is going to be rejected for an existing tag should
 * be rejected before someone is paged to approve it.
 *
 * Nothing here writes to the repository, the registry, or the workspace.
 */
import { readFileSync } from 'node:fs';
import * as core from './lib/core.ts';
import { tryCapture } from './lib/exec.ts';
import * as git from './lib/git.ts';
import { infer, type Level } from './lib/gitmoji.ts';
import { publishInputs as inputs } from './lib/inputs.ts';
import { formatVersion, increment, parseVersion, type Bump } from './lib/semver.ts';

interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
}

const prefix = inputs['tag-prefix'];

// ---------------------------------------------------------------------------
// 1. Refuse to release from anywhere but the release branch.
//
// A tag pushed from a feature branch would point at a commit that never went
// through review, and the npm trusted publisher's environment is the only other
// thing standing in the way. Checked here so the failure is a red plan job
// rather than a request for approval nobody should grant.
// ---------------------------------------------------------------------------
git.assertFullHistory();

const branch = git.currentBranch();
core.assert(
  branch === inputs['release-branch'],
  `releases run from '${inputs['release-branch']}', not '${branch}'`,
);

const sha = git.head();
core.info(`Releasing from ${branch} at ${sha}`);

// ---------------------------------------------------------------------------
// 2. The manifest is the base version, not the newest tag.
//
// This is the opposite of what a release tool usually assumes, and it is forced
// by these repositories' history: `url`'s tags run to `v3.0.0-beta.2` from its
// `@bluejay/url` days, while the registry serves `@tselect/url@1.0.0` and
// package.json says `1.0.0`. Inferring the base from `git describe` would
// propose `3.0.0` for a package whose latest published version is `1.0.0`.
//
// package.json is the version that was published, so package.json is the base.
// ---------------------------------------------------------------------------
const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as Manifest;

core.assert(manifest.name, 'package.json has no name');
core.assert(manifest.version, 'package.json has no version');
core.assert(!manifest.private, `${manifest.name} is marked private and cannot be published`);

const name = manifest.name;
const current = parseVersion(manifest.version);
core.assert(current, `package.json version '${manifest.version}' is not plain semver`);

/** Whether the registry already serves this exact version. */
function isPublished(version: string): boolean {
  // `pnpm view <pkg>@<missing> version` exits 0 and prints nothing when the
  // package exists but the version does not, and fails outright when the package
  // itself is unknown. Both mean "not published", so the test is on the output
  // rather than on the exit code.
  return (tryCapture('pnpm', ['view', `${name}@${version}`, 'version']) ?? '').trim() !== '';
}

// ---------------------------------------------------------------------------
// 3. If the manifest version was never published, finish that release.
//
// The release is not atomic — the tag is pushed before `pnpm publish` runs (see
// `publish.ts` for why) — so a failure in between leaves `main` carrying a
// version the registry has never seen. Bumping again from there would abandon
// the tagged version and publish a hole in the history.
//
// It also covers the ordinary case of a version bumped by hand in a pull
// request: whatever main says, that is what gets published.
// ---------------------------------------------------------------------------
const resume = !isPublished(manifest.version);

let version: string;
let bump: Bump | 'none';
let reason: string;

if (resume) {
  version = manifest.version;
  bump = 'none';
  reason = `package.json is already at ${version} and the registry does not have it`;

  core.warning(
    `${name}@${version} is on ${branch} but not on the registry — publishing it as-is rather than bumping. No version bump, no new commit.`,
  );
} else {
  // -------------------------------------------------------------------------
  // 4. The commit range: everything since the tag for the published version.
  // -------------------------------------------------------------------------
  const since = resolveSince(manifest.version);
  const commits = git.commitsSince(since);

  core.assert(
    commits.length > 0,
    `no commits since ${since ?? 'the root commit'} — there is nothing to release`,
  );

  core.info(`${commits.length} commit(s) since ${since ?? 'the root commit'}`);

  const inference = infer(commits);
  const override = inputs.bump;

  if (override && override !== 'auto') {
    core.assert(
      override === 'major' || override === 'minor' || override === 'patch',
      `bump must be auto, major, minor or patch — got '${override}'`,
    );

    bump = override;
    reason =
      inference.level === 'none'
        ? `${bump}, chosen explicitly (gitmoji implied no release)`
        : `${bump}, chosen explicitly (gitmoji implied ${inference.level})`;

    if (ranksBelow(inference.level, override)) {
      core.info(`Overriding the inferred ${inference.level} with ${override}.`);
    }
  } else {
    // A range of nothing but docs, tests and CI commits is not a release. It is
    // also not an error worth guessing about, so it asks rather than assumes.
    core.assert(
      inference.level !== 'none',
      'no commit in the range implies a release — every one is docs, tests, tooling or chores. ' +
        'Re-run with an explicit bump if you meant to publish anyway.',
    );

    bump = inference.level;
    reason = `${bump}, inferred from gitmoji`;
  }

  version = formatVersion(increment(current, bump));

  summarizeCommits(inference.classifications);
}

const tag = `${prefix}${version}`;

// ---------------------------------------------------------------------------
// 5. The two ways this release is already partly done.
// ---------------------------------------------------------------------------
if (git.tagExists(tag)) {
  const at = git.tagCommit(tag);

  // A tag on this exact commit is the interrupted-release case from step 3, and
  // `publish.ts` will leave it alone. Anywhere else means the version is taken.
  core.assert(
    resume && at === sha,
    `${tag} already exists${at ? ` at ${at}` : ''} — pick a different bump, or delete the tag if it was cut in error`,
  );

  core.info(`${tag} already exists at HEAD; it will be reused rather than recreated.`);
}

core.assert(
  !isPublished(version),
  `${name}@${version} is already on the registry — npm does not allow republishing a version`,
);

// ---------------------------------------------------------------------------
// 6. Report.
// ---------------------------------------------------------------------------
core.info(`${name}: ${manifest.version} → ${version} (${reason})`);

core.summary('## Release plan\n');
core.summary('| | |');
core.summary('| --- | --- |');
core.summary(`| Package | \`${name}\` |`);
core.summary(`| Current | \`${manifest.version}\` |`);
core.summary(`| Next | **\`${version}\`** |`);
core.summary(`| Bump | ${reason} |`);
core.summary(`| Tag | \`${tag}\` |`);
core.summary(`| Dist-tag | \`${inputs['dist-tag']}\` |`);
core.summary(`| Commit | \`${sha}\` on \`${branch}\` |`);
core.summary('');

core.setResult({ name, version, tag, sha, bump, resume, current: manifest.version });

/**
 * Where to start counting commits.
 *
 * In order of preference: an explicit `since-ref`; the tag naming the published
 * version, with and without the prefix (these repositories have both — `url` has
 * a bare `1.0.0` alongside `v2.0.1`); then the newest reachable semver tag; then
 * the root commit. Each fallback is louder than the last, because each one is a
 * weaker claim about what has already shipped.
 */
function resolveSince(published: string): string | null {
  const explicit = inputs['since-ref'];

  if (explicit) {
    core.assert(git.tagExists(explicit) || git.isReachable(explicit), `${explicit} is not a reachable ref`);
    core.info(`Counting commits since ${explicit} (given as since-ref).`);
    return explicit;
  }

  for (const candidate of [`${prefix}${published}`, published]) {
    if (git.tagExists(candidate) && git.isReachable(candidate)) {
      core.info(`Counting commits since ${candidate}, the tag for the published version.`);
      return candidate;
    }
  }

  const newest = git.tags().find((name) => parseVersion(name.replace(/^v/, '')) && git.isReachable(name));

  if (newest) {
    core.warning(
      `no tag matches the published version ${published}; counting commits since ${newest}, the newest reachable tag. Pass since-ref to override.`,
    );
    return newest;
  }

  core.warning(
    `no reachable semver tag at all; counting every commit in the history. Pass since-ref to narrow it.`,
  );
  return null;
}

function summarizeCommits(classifications: ReturnType<typeof infer>['classifications']): void {
  core.summary('### Commits considered\n');
  core.summary('| Commit | Bump | Subject |');
  core.summary('| --- | --- | --- |');

  for (const { commit, level, marker } of classifications) {
    const shown = level === 'none' ? '—' : level;
    core.summary(
      `| \`${commit.sha.slice(0, 7)}\` | ${shown} | ${marker ? '' : '⚠️ '}${escapeCell(commit.subject)} |`,
    );
  }

  core.summary('');
}

/** Keep a subject containing a pipe from breaking the Markdown table. */
function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

/** Whether `inferred` ranks below `chosen`, for the log line only. */
function ranksBelow(inferred: Level, chosen: Bump): boolean {
  const rank: Record<Level, number> = { none: 0, patch: 1, minor: 2, major: 3 };
  return rank[inferred] < rank[chosen];
}
