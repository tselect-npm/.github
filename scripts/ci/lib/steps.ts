/**
 * Run a job's steps, reporting every failure instead of stopping at the first.
 *
 * This replaces the `if: ${{ !cancelled() && … }}` chain the YAML used to carry
 * on every step after the first. That idiom worked, but it put the control flow
 * in an expression on each step, where it had to be re-read and re-derived one
 * step at a time. Here the intent is a method name, and "did anything fail?" is
 * a single check at the end.
 *
 * The behaviour it preserves is the one that matters: one push surfaces every
 * problem, rather than one problem per round-trip.
 */
import * as core from './core.ts';

export class Steps {
  readonly #failures: string[] = [];
  readonly #skipped: string[] = [];

  /**
   * Run `fn` inside a collapsible log group. A thrown error is recorded and
   * annotated, and execution continues with the next step.
   *
   * Returns whether the step passed, so a caller can stop when continuing would
   * only produce noise — asserting a `dist` that was never built, say.
   */
  run(name: string, fn: () => void): boolean {
    return core.group(name, () => {
      try {
        fn();
        return true;
      } catch (thrown) {
        const message = thrown instanceof Error ? thrown.message : String(thrown);
        this.#failures.push(name);
        core.error(`${name}: ${message}`);
        return false;
      }
    });
  }

  /**
   * Record a step as deliberately not run. Reported at the end so a skipped gate
   * is visible in the log rather than being indistinguishable from a passing one.
   */
  skip(name: string, reason: string): void {
    this.#skipped.push(`${name} (${reason})`);
    core.info(`⊘ Skipped ${name} — ${reason}`);
  }

  get failed(): boolean {
    return this.#failures.length > 0;
  }

  /** Print the tally and exit with a status that matches it. */
  exit(): never {
    if (this.#skipped.length > 0) {
      core.info(`Skipped ${this.#skipped.length} step(s): ${this.#skipped.join(', ')}.`);
    }

    if (this.#failures.length === 0) {
      core.info('✓ All steps passed.');
      process.exit(0);
    }

    core.error(
      this.#failures.length === 1
        ? `${this.#failures.join('')} failed`
        : `${this.#failures.length} steps failed: ${this.#failures.join(', ')}`,
    );
    process.exit(1);
  }
}
