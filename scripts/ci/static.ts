/**
 * The `typecheck + lint` job.
 *
 * Both checks share a runner because these packages are small enough that a
 * second one costs more in setup than it saves in wall-clock, and both always
 * run: a typecheck failure still reports the lint result, so one push surfaces
 * every problem instead of one per round-trip.
 *
 * Either check can be turned off by setting its script input to '' — six of the
 * seven repositories are still mid-migration and do not have both yet.
 */
import { pnpmRun } from './lib/exec.ts';
import { inputs } from './lib/inputs.ts';
import { Steps } from './lib/steps.ts';

const steps = new Steps();

const typecheckScript = inputs['typecheck-script'];
const lintScript = inputs['lint-script'];

if (typecheckScript) {
  steps.run(`Typecheck (pnpm run ${typecheckScript})`, () => {
    pnpmRun(typecheckScript);
  });
} else {
  steps.skip('Typecheck', 'typecheck-script is empty');
}

if (lintScript) {
  // Biome's `check` covers formatting as well as linting, which is why there is
  // no separate format step. The workflow stays tool-agnostic by naming a
  // package.json script rather than a subcommand.
  steps.run(`Lint (pnpm run ${lintScript})`, () => {
    pnpmRun(lintScript);
  });
} else {
  steps.skip('Lint', 'lint-script is empty');
}

steps.exit();
