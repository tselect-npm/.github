/**
 * Repo-level settings: `PATCH /repos/{owner}/{repo}`, plus topics.
 *
 * The uniform half comes from `config/repo-settings.json`; description, homepage
 * and topics come from that repo's entry in `config/repos.json`, because they
 * describe the package rather than the toolchain and there is nothing to copy
 * from a reference repo.
 */
import { diffKeys, equal, type Change } from '../lib/diff.ts';
import type { Context, Provider, ProviderPlan } from './types.ts';

/**
 * Topics have their own endpoint (`PUT …/topics`) and are order-insensitive on
 * the way in but returned sorted, so they are compared as sets and excluded from
 * the PATCH body.
 */
function topicsDiffer(desired: string[], current: string[]): boolean {
  return !equal([...desired].sort(), [...current].sort());
}

export const settingsProvider: Provider = {
  name: 'settings',
  describe: 'repo description, topics, merge methods and feature toggles',

  async plan(context: Context): Promise<ProviderPlan> {
    const { octokit, owner, repo, settings } = context;

    const { data: live } = await octokit.rest.repos.get({ owner, repo: repo.name });

    // Groupings for endpoints of their own, not fields of the PATCH body.
    const { security: _security, actions: wantedActions, ...uniform } = settings;

    const desired: Record<string, unknown> = { ...uniform };
    if (repo.description !== undefined) {
      desired.description = repo.description;
    }
    if (repo.homepage !== undefined) {
      desired.homepage = repo.homepage;
    }

    const changes: Change[] = diffKeys(desired, live as unknown as Record<string, unknown>);

    const desiredTopics = repo.topics;
    const topicsChanged = desiredTopics !== undefined && topicsDiffer(desiredTopics, live.topics ?? []);
    if (topicsChanged && desiredTopics) {
      changes.push({
        key: 'topics',
        from: live.topics ?? [],
        to: desiredTopics,
        kind: 'update',
      });
    }

    // Actions permissions: a separate endpoint, and the one setting whose
    // absence fails silently — a repo with Actions off accepts workflow files,
    // shows no error, and simply never runs them.
    const { data: liveActions } = await octokit.request(
      'GET /repos/{owner}/{repo}/actions/permissions',
      { owner, repo: repo.name },
    );
    const actionsDiffer =
      liveActions.enabled !== wantedActions.enabled ||
      (wantedActions.enabled && liveActions.allowed_actions !== wantedActions.allowed_actions);

    if (actionsDiffer) {
      changes.push({
        key: 'actions',
        from: liveActions.enabled ? `enabled (${liveActions.allowed_actions})` : 'disabled',
        to: wantedActions.enabled ? `enabled (${wantedActions.allowed_actions})` : 'disabled',
        kind: 'update',
      });
    }

    const warnings: string[] = [];
    if (live.archived) {
      warnings.push('repository is archived; GitHub rejects every write until it is unarchived');
    }

    return {
      changes,
      warnings,
      async apply() {
        const patch = Object.fromEntries(
          changes.filter((change) => change.key !== 'topics').map((change) => [change.key, change.to]),
        );

        if (Object.keys(patch).length > 0) {
          await octokit.rest.repos.update({ owner, repo: repo.name, ...patch });
        }
        if (topicsChanged && desiredTopics) {
          await octokit.rest.repos.replaceAllTopics({
            owner,
            repo: repo.name,
            names: desiredTopics,
          });
        }
        if (actionsDiffer) {
          await octokit.request('PUT /repos/{owner}/{repo}/actions/permissions', {
            owner,
            repo: repo.name,
            enabled: wantedActions.enabled,
            // Rejected as an unknown field when disabling.
            ...(wantedActions.enabled
              ? { allowed_actions: wantedActions.allowed_actions as 'all' }
              : {}),
          });
        }
      },
    };
  },
};
