/**
 * The slice of `@actions/core` these scripts actually use, reimplemented here.
 *
 * The point is to stay dependency-free: `pnpm dlx tsx <script>` then has exactly
 * one package to fetch, and this repository needs no lockfile of its own for
 * code that executes inside seven others. `@actions/core` would also drag in a
 * `node_modules` install step before every job could run its first line.
 *
 * Reference for the command syntax:
 * https://docs.github.com/actions/reference/workflow-commands-for-github-actions
 */
import { appendFileSync } from 'node:fs';

/**
 * Workflow commands are line-oriented, so anything that could contain a newline
 * has to be encoded or the runner reads only the first line — and silently drops
 * the rest of the annotation.
 */
function escape(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Plain log output. */
export function info(message: string): void {
  process.stdout.write(`${message}\n`);
}

/** A red annotation on the job, and on the file/line if one is in the message. */
export function error(message: string): void {
  process.stdout.write(`::error::${escape(message)}\n`);
}

/** A yellow annotation. Used for findings that are reported but not blocking. */
export function warning(message: string): void {
  process.stdout.write(`::warning::${escape(message)}\n`);
}

/**
 * A collapsible section in the log. Every step of every job runs inside one, so
 * a green run reads as a short list of headings rather than a wall of output —
 * which is most of the readability this refactor is after.
 */
export function group<T>(name: string, fn: () => T): T {
  process.stdout.write(`::group::${escape(name)}\n`);
  try {
    return fn();
  } finally {
    process.stdout.write('::endgroup::\n');
  }
}

/** Append Markdown to the job summary shown on the run's page. */
export function summary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) {
    return; // Running outside Actions (e.g. locally); nothing to write to.
  }
  appendFileSync(file, `${markdown}\n`);
}

/**
 * Publish a JSON blob as the wrapper action's `result` output.
 *
 * A composite action has to declare its outputs statically, so rather than grow
 * a named output per script, everything a job needs back from a script travels
 * in one object and the YAML reads it with `fromJSON(...)`. `JSON.stringify`
 * never emits a raw newline, so the single-line `key=value` form is safe here.
 */
export function setResult(value: Record<string, unknown>): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) {
    return;
  }
  appendFileSync(file, `result=${JSON.stringify(value)}\n`);
}

/** Throw with `message` unless `condition` holds. */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
