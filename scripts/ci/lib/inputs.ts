/**
 * A reusable workflow's inputs, as one typed object.
 *
 * The workflow hands the whole `inputs` context to the wrapper action as
 * `${{ toJSON(inputs) }}`, so a script reads whatever it needs without the
 * workflow having to thread a new `env:` entry down for each one. Adding an
 * input to `ci.yml` and a field here is the entire wiring.
 *
 * Keys stay kebab-case, matching `ci.yml` exactly — a script that reads
 * `inputs['dist-dir']` is greppable against the workflow that documents it.
 */
import * as core from './core.ts';

export interface CiInputs {
  // Matrix
  'node-versions': string;
  'primary-node-version': string;
  'runs-on': string;

  // Scripts — these name package.json scripts, not commands. '' skips the step.
  'typecheck-script': string;
  'lint-script': string;
  'coverage-script': string;
  'test-script': string;
  'build-script': string;

  // Install
  'install-command': string;
  cache: string;

  // Coverage
  'coverage-lcov': string;
  'upload-coverage': boolean;

  // Publishable-artifact gates
  'dist-dir': string;
  'es-check-target': string;
  'check-types-resolution': boolean;
  'attw-profile': string;
  'upload-package': boolean;

  // Audit
  audit: boolean;
  'audit-level': string;
  'audit-blocking': boolean;

  // Pinned tool versions
  'es-check-version': string;
  'attw-version': string;
}

/**
 * The publish workflow's inputs. Same contract as `CiInputs`, different
 * workflow: `.github/workflows/publish.yml` documents each one.
 */
export interface PublishInputs {
  // Release
  bump: string;
  'release-branch': string;
  'tag-prefix': string;
  'dist-tag': string;
  'since-ref': string;
  'dry-run': boolean;

  // Who may release
  environment: string;

  // Toolchain
  'node-version': string;
  'install-command': string;
  cache: string;
  'runs-on': string;
  'tsx-version': string;
}

function parse(): Record<string, unknown> {
  const raw = process.env.CI_INPUTS;

  core.assert(raw, 'CI_INPUTS is not set — the wrapper action must pass toJSON(inputs)');

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(`CI_INPUTS is not valid JSON: ${(cause as Error).message}`);
  }
}

/**
 * `CI_INPUTS` carries whichever workflow is running, so it is parsed once and
 * published under two names. A script imports the one belonging to its workflow;
 * nothing reads both, and a script that imported the wrong one would fail
 * immediately on an undefined input rather than misbehave quietly.
 */
const parsed = parse();

export const inputs = parsed as unknown as CiInputs;
export const publishInputs = parsed as unknown as PublishInputs;

/**
 * Read a boolean input.
 *
 * The `inputs` context preserves declared types, so a `type: boolean` input
 * arrives as a real boolean. This still accepts the string forms, because the
 * same value read through an action input (where everything is a string) should
 * not mean something different.
 */
export function bool(value: boolean | string): boolean {
  return value === true || value === 'true';
}
