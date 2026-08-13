/**
 * The `ci` job — one stable check name for branch protection.
 *
 * Matrix job names (`test (node 26)`, …) change whenever `node-versions`
 * changes; this one does not, so the seven repositories can require `CI / ci`
 * and never touch their settings again.
 *
 * `needs` alone is not enough to express "everything passed": a skipped
 * dependency counts as satisfied, so each result is inspected explicitly.
 * `skipped` is allowed — it means the caller turned that job off — while
 * `failure` and `cancelled` are fatal.
 *
 * The shell version of this grepped the JSON for `"result": "failure"`. Parsing
 * it removes the class of bug where a match comes from somewhere other than the
 * field being tested, such as a job's own outputs.
 */
import * as core from './lib/core.ts';

interface JobResult {
  result: 'success' | 'failure' | 'cancelled' | 'skipped';
}

const raw = process.env.CI_NEEDS;
core.assert(raw, 'CI_NEEDS is not set — the workflow must pass toJSON(needs)');

const needs = JSON.parse(raw) as Record<string, JobResult>;
const entries = Object.entries(needs);

core.assert(entries.length > 0, 'no jobs were reported — check the `needs` list');

const ICONS: Record<string, string> = {
  success: '✅',
  skipped: '⊘',
  failure: '❌',
  cancelled: '⚠️',
};

core.summary('### CI jobs\n');
core.summary('| Job | Result |');
core.summary('| --- | --- |');

for (const [job, { result }] of entries) {
  core.info(`${ICONS[result] ?? '❓'} ${job}: ${result}`);
  core.summary(`| \`${job}\` | ${ICONS[result] ?? '❓'} ${result} |`);
}

// Anything that is not an explicit pass or an explicit skip is treated as a
// failure, so a result GitHub adds later cannot quietly become a green build.
const failed = entries.filter(([, { result }]) => result !== 'success' && result !== 'skipped');

if (failed.length > 0) {
  core.error(
    `one or more CI jobs did not succeed: ${failed
      .map(([job, { result }]) => `${job} (${result})`)
      .join(', ')}`,
  );
  process.exit(1);
}

core.info('All CI jobs succeeded or were skipped.');
