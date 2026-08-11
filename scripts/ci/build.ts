/**
 * The `build + package` job.
 *
 * This job exists to distrust the build's exit code. A build tool can report
 * success and still drop declarations (which is why the pilot replaced tsup with
 * tsdown), and a packing mistake can ship a tarball with no JavaScript at all
 * (`@tselect/url@1.0.0` did exactly that). So: build, then assert what came out,
 * then assert what a consumer would actually receive.
 *
 * Every gate after the build runs even if an earlier one failed, so one push
 * reports every problem. The build itself is the exception — if it did not
 * produce output, asserting things about that output is only noise.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from './lib/core.ts';
import { capture, pnpmDlx, pnpmRun, run } from './lib/exec.ts';
import { hasFiles, nonEmptyFiles, walk } from './lib/files.ts';
import { bool, inputs } from './lib/inputs.ts';
import { Steps } from './lib/steps.ts';

const dist = inputs['dist-dir'];
const steps = new Steps();

/** Set once the tarball exists, so the workflow knows whether to upload it. */
let tarball = '';

const built = steps.run(`Build (pnpm run ${inputs['build-script']})`, () => {
  pnpmRun(inputs['build-script']);
});

if (!built) {
  core.error('the build failed; skipping the checks that inspect its output');
  steps.exit();
}

// ---------------------------------------------------------------------------
// 1. The build emitted both JavaScript and declarations, and neither is empty.
// ---------------------------------------------------------------------------
steps.run(`Assert ${dist} contains JavaScript and declarations`, () => {
  core.assert(walk(dist).length > 0, `${dist} does not exist or is empty`);

  const js = nonEmptyFiles(dist, ['.js', '.cjs', '.mjs']);
  const declarations = nonEmptyFiles(dist, ['.d.ts', '.d.cts', '.d.mts']);

  core.info(`${dist}: ${js.length} JavaScript file(s), ${declarations.length} declaration file(s)`);
  for (const file of [...js, ...declarations].sort()) {
    core.info(`  ${file}`);
  }

  core.assert(js.length > 0, `${dist} contains no non-empty JavaScript`);
  core.assert(declarations.length > 0, `${dist} contains no non-empty type declarations`);
});

// ---------------------------------------------------------------------------
// 2. The emitted syntax is no newer than the support policy allows.
//
// The policy is additive: the runtime floor may never rise. es-check parses the
// output with acorn at the target version, which is what makes this stronger
// than grepping for `?.` / `??` / private fields — a grep has to strip comments
// first (tsdown emits `//#region` markers) and can only find syntax it was told
// to look for.
// ---------------------------------------------------------------------------
const esCheckTarget = inputs['es-check-target'];

if (esCheckTarget) {
  steps.run(`Assert emitted syntax is no newer than ${esCheckTarget}`, () => {
    const esCheck = `es-check@${inputs['es-check-version']}`;

    // `.cjs` is always script and `.mjs` is always module; a bare `.js` follows
    // the package's `type` field.
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { type?: string };
    const isModule = manifest.type === 'module';

    core.info(`package.json declares type: ${manifest.type ?? 'commonjs'}`);

    if (hasFiles(dist, '.cjs')) {
      pnpmDlx(esCheck, [esCheckTarget, `${dist}/**/*.cjs`]);
    }
    if (hasFiles(dist, '.mjs')) {
      pnpmDlx(esCheck, [esCheckTarget, `${dist}/**/*.mjs`, '--module']);
    }
    if (hasFiles(dist, '.js')) {
      pnpmDlx(esCheck, [esCheckTarget, `${dist}/**/*.js`, ...(isModule ? ['--module'] : [])]);
    }
  });
} else {
  steps.skip('es-check', 'es-check-target is empty');
}

// ---------------------------------------------------------------------------
// 3. Pack for real and read the tarball back.
//
// `npm pack --dry-run` in a dirty tree once reported files a clean checkout
// would never produce, which is how a release shipped with zero JavaScript.
// Packing into an empty directory rather than parsing pnpm's stdout matters too,
// because `prepack` writes to stdout as well.
// ---------------------------------------------------------------------------
const packed = steps.run('Pack and inspect the tarball a consumer would download', () => {
  const destination = join(process.env.RUNNER_TEMP ?? tmpdir(), 'packed');
  mkdirSync(destination, { recursive: true });

  run('pnpm', ['pack', '--pack-destination', destination]);

  const [packedName] = walk(destination).filter((file) => file.endsWith('.tgz'));
  core.assert(packedName, 'pnpm pack produced no tarball');
  tarball = join(destination, packedName);

  const contents = capture('tar', ['-tzf', tarball]).split('\n').filter(Boolean).sort();

  core.info(contents.join('\n'));
  core.summary('### Published tarball contents\n');
  core.summary(['```', ...contents, '```'].join('\n'));

  const js = contents.filter((file) => /\.(js|cjs|mjs)$/.test(file));
  core.assert(js.length > 0, 'the packed tarball contains no JavaScript');
  core.info(`The tarball carries ${js.length} JavaScript file(s).`);
});

// ---------------------------------------------------------------------------
// 4. A consumer can actually resolve the types.
//
// This validates the `exports` map and dual-package type resolution — the check
// that would have caught the pilot's headline bug before consumers did.
// ---------------------------------------------------------------------------
if (!bool(inputs['check-types-resolution'])) {
  steps.skip('@arethetypeswrong/cli', 'check-types-resolution is false');
} else if (!packed) {
  steps.skip('@arethetypeswrong/cli', 'there is no tarball to check');
} else {
  steps.run('Check type resolution with @arethetypeswrong/cli', () => {
    pnpmDlx(`@arethetypeswrong/cli@${inputs['attw-version']}`, [
      tarball,
      '--profile',
      inputs['attw-profile'],
    ]);
  });
}

// Written unconditionally so the workflow can decide about the upload even when
// a later gate failed — a tarball is most useful to inspect when attw rejected it.
core.setResult({ packed, tarball });

steps.exit();
