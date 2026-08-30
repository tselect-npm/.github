/**
 * The provider contract.
 *
 * `plan()` reads live state, compares it to the desired state, and returns both
 * the changes *and* the closure that performs them. Those two things travel
 * together on purpose: it makes it structurally impossible for `--apply` to do
 * something the dry-run did not print, which is the one property a tool like
 * this has to have to be worth trusting.
 */
import type { Octokit } from 'octokit';
import type { Change } from '../lib/diff.ts';
import type { LabelsConfig, RepoConfig, SettingsConfig } from '../lib/config.ts';

export interface Context {
  octokit: Octokit;
  owner: string;
  repo: RepoConfig;
  settings: SettingsConfig;
  labels: LabelsConfig;
  /** Absolute path of the sibling clone, e.g. `…/@tselect/status-code`. */
  clonePath: string;
}

export interface ProviderPlan {
  changes: Change[];
  /** Things the operator needs to know that are not changes: skips, caveats. */
  warnings: string[];
  /** Performs exactly the listed changes. Never called during a dry run. */
  apply(): Promise<void>;
}

export interface Provider {
  name: string;
  /** One line, shown by `tselect --help`. */
  describe: string;
  plan(context: Context): Promise<ProviderPlan>;
}

/** A plan with nothing to do. */
export function noChanges(warnings: string[] = []): ProviderPlan {
  return { changes: [], warnings, apply: async () => {} };
}
