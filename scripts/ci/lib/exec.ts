/**
 * Running child processes, with the command echoed the way `set -x` used to do
 * it in the shell steps this replaces.
 *
 * Everything is synchronous on purpose. CI steps are strictly sequential, and
 * `spawnSync` keeps the job scripts readable as straight-line code with no
 * `async` colouring.
 */
import { spawnSync } from 'node:child_process';
import * as core from './core.ts';

export interface RunOptions {
  /**
   * When false, a non-zero exit code is returned instead of thrown. Use it when
   * the exit code is the answer (`pnpm audit`) rather than a failure.
   */
  check?: boolean;
  /** Extra environment for the child, merged over `process.env`. */
  env?: Record<string, string>;
}

/**
 * Run a command with its output streamed to the log. Returns the exit code.
 *
 * Arguments are passed as an array and never through a shell, so a value
 * containing spaces or a `$` is an argument rather than something to re-parse —
 * this is the property the quoted `"$SCRIPT"` dance in the old YAML was after.
 */
export function run(command: string, args: string[], options: RunOptions = {}): number {
  const { check = true, env } = options;

  core.info(`$ ${command} ${args.join(' ')}`);

  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: env ? { ...process.env, ...env } : process.env,
  });

  if (result.error) {
    throw new Error(`could not run \`${command}\`: ${result.error.message}`);
  }

  // A process killed by a signal reports a null code; surface that rather than
  // letting `null` fall through as a success.
  const code = result.status ?? 1;
  if (result.signal) {
    throw new Error(`\`${command}\` was killed by ${result.signal}`);
  }

  if (check && code !== 0) {
    throw new Error(`\`${command} ${args.join(' ')}\` exited with code ${code}`);
  }

  return code;
}

/** Run a command and return its stdout. Throws if it fails. */
export function capture(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf8' });

  if (result.error) {
    throw new Error(`could not run \`${command}\`: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '');
    throw new Error(`\`${command} ${args.join(' ')}\` exited with code ${result.status}`);
  }

  return result.stdout;
}

/**
 * Run a command and return its stdout, or null if it exited non-zero.
 *
 * For the cases where "it failed" is an answer rather than a problem: whether a
 * tag exists, whether the registry already carries a version. `capture` throws
 * there, and a try/catch around an expected outcome reads as if something went
 * wrong. stderr is swallowed for the same reason — a `404` from `pnpm view` is
 * the result, not an error worth putting in the log.
 */
export function tryCapture(command: string, args: string[]): string | null {
  const result = spawnSync(command, args, { encoding: 'utf8' });

  if (result.error || result.status !== 0) {
    return null;
  }

  return result.stdout;
}

/** `pnpm run <script>` — the script name comes from a workflow input. */
export function pnpmRun(script: string, options: RunOptions = {}): number {
  return run('pnpm', ['run', script], options);
}

/**
 * `pnpm dlx <package>@<version> …`
 *
 * Tools used by only one step (es-check, attw) are fetched on demand rather than
 * added as a devDependency to seven repositories. The version is always pinned
 * by the caller — `dlx` with a floating version would make CI non-reproducible.
 */
export function pnpmDlx(pkg: string, args: string[], options: RunOptions = {}): number {
  return run('pnpm', ['dlx', pkg, ...args], options);
}
