/**
 * The reusable workflow's inputs, as one typed object.
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

function parse(): CiInputs {
  const raw = process.env.CI_INPUTS;

  core.assert(raw, 'CI_INPUTS is not set — the wrapper action must pass toJSON(inputs)');

  try {
    return JSON.parse(raw) as CiInputs;
  } catch (cause) {
    throw new Error(`CI_INPUTS is not valid JSON: ${(cause as Error).message}`);
  }
}

export const inputs: CiInputs = parse();

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
