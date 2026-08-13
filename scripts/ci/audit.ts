/**
 * The `audit` job.
 *
 * Zero vulnerabilities is a standing requirement; this is what makes it a gate
 * rather than something remembered. No install is needed — pnpm audits the
 * lockfile.
 *
 * Repositories still carrying the old mocha/nyc/TSLint tree have live advisories
 * today, so they adopt the workflow with `audit-blocking: false`: the findings
 * are reported as warnings and the rest of CI still gates. They flip it to true
 * in the same pull request that removes the advisories.
 *
 * Advisory mode is decided here rather than with a job-level `continue-on-error`
 * so that `needs.audit.result` stays unambiguous for the aggregate job.
 */
import * as core from './lib/core.ts';
import { run } from './lib/exec.ts';
import { bool, inputs } from './lib/inputs.ts';

const level = inputs['audit-level'];
const blocking = bool(inputs['audit-blocking']);

const code = run('pnpm', ['audit', '--audit-level', level], { check: false });

if (code === 0) {
  core.info(`✓ No vulnerabilities at or above '${level}'.`);
  process.exit(0);
}

const finding = `pnpm audit found vulnerabilities at or above '${level}'`;

if (blocking) {
  core.error(finding);
  process.exit(1);
}

core.warning(`${finding} (advisory: audit-blocking is false)`);
process.exit(0);
