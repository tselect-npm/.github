/**
 * The `test` job.
 *
 * Runs the suite on one line of the Node matrix. Coverage runs on *every* entry
 * rather than just the primary one: the thresholds are part of the gate, and a
 * failure specific to one runtime should surface as a test failure on that
 * runtime. Only the primary version uploads the report, which the workflow
 * handles — Coveralls is a marketplace action, so it stays in YAML.
 */
import { pnpmRun } from './lib/exec.ts';
import { inputs } from './lib/inputs.ts';
import * as core from './lib/core.ts';

const coverageScript = inputs['coverage-script'];
const testScript = inputs['test-script'];

// `coverage-script` wins; `test-script` is the fallback for a repo that has
// tests but has not wired up an lcov report yet.
const script = coverageScript || testScript;

if (!script) {
  core.error('neither coverage-script nor test-script is set — nothing to run');
  process.exit(1);
}

core.info(
  coverageScript
    ? `Running tests with coverage via \`${script}\`.`
    : `Running tests without coverage via \`${script}\` (coverage-script is empty).`,
);

pnpmRun(script);
