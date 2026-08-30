/**
 * Branch protection, which on these repos is four repository rulesets.
 *
 * This replaces the procedure the README used to describe: Settings → Rules →
 * Rulesets → Import a ruleset, once per file per repo — *"With seven repos and
 * four files that is 28 imports"* — with nothing keeping an imported copy in step
 * with `rulesets/*.json` afterwards. Matching on the ruleset `name` is what makes
 * re-running safe: an existing ruleset is updated in place rather than duplicated.
 */
import type { Octokit } from 'octokit';
import { RULESET_NAMES, loadRuleset, type RulesetName } from '../lib/config.ts';
import { diffPaths, type Change } from '../lib/diff.ts';
import { isStatus } from '../lib/github.ts';
import type { Context, Provider, ProviderPlan } from './types.ts';

interface LiveRuleset {
  id: number;
  name: string;
}

/**
 * Reduce a ruleset to the fields we declare.
 *
 * GitHub returns a ruleset fatter than the one you sent: ids, timestamps,
 * `_links`, and — the one that actually bites — parameter defaults it filled in
 * for rules we only partially specified. Comparing the raw bodies would report a
 * difference on every run that applying could never settle, so both sides are
 * projected onto the declared shape before they meet.
 */
function project(ruleset: Record<string, unknown>, declared: Record<string, unknown>): unknown {
  const rules = (ruleset.rules ?? []) as Array<Record<string, unknown>>;
  const declaredRules = (declared.rules ?? []) as Array<Record<string, unknown>>;

  const byType = new Map(rules.map((rule) => [rule.type as string, rule]));

  const conditions = ruleset.conditions as { ref_name?: { include?: string[]; exclude?: string[] } };
  const refName = conditions?.ref_name ?? {};

  return {
    name: ruleset.name,
    target: ruleset.target,
    enforcement: ruleset.enforcement,
    conditions: {
      include: [...(refName.include ?? [])].sort(),
      exclude: [...(refName.exclude ?? [])].sort(),
    },
    rules: declaredRules.map((declaredRule) => {
      const type = declaredRule.type as string;
      const live = byType.get(type);
      if (!live) {
        return { type, missing: true };
      }

      const declaredParameters = (declaredRule.parameters ?? {}) as Record<string, unknown>;
      const liveParameters = (live.parameters ?? {}) as Record<string, unknown>;

      // Only the parameters we state an opinion about; the rest are GitHub's
      // defaults and are none of this tool's business.
      return {
        type,
        parameters: Object.fromEntries(
          Object.keys(declaredParameters).map((key) => [key, liveParameters[key]]),
        ),
      };
    }),
    bypass_actors: ((ruleset.bypass_actors ?? []) as Array<Record<string, unknown>>)
      .map((actor) => ({
        actor_id: actor.actor_id,
        actor_type: actor.actor_type,
        bypass_mode: actor.bypass_mode,
      }))
      .sort((a, b) => String(a.actor_id).localeCompare(String(b.actor_id))),
  };
}

type CreateParams = NonNullable<Parameters<Octokit['rest']['repos']['createRepoRuleset']>[0]>;
type UpdateParams = NonNullable<Parameters<Octokit['rest']['repos']['updateRepoRuleset']>[0]>;

/**
 * The POST/PUT body: everything in the file except the read-only `source_type`.
 *
 * The cast is unavoidable and narrow. These bodies come from JSON, so `target`
 * and `enforcement` arrive as `string` where the typed client wants the literal
 * unions — a shape no amount of parsing recovers. `self-check.yml` already
 * parses and validates `rulesets/*.json` on every push to this repository, so
 * the files are checked; just not by tsc.
 */
function payload<T>(declared: Record<string, unknown>): T {
  const { source_type: _sourceType, ...rest } = declared;
  return rest as T;
}

/**
 * Has this repo ever produced a `ci` check run?
 *
 * Reported, not enforced. `ci-required` names the context `ci / ci`, and on a
 * repo whose CI has not landed yet that makes PRs wait on a check that will not
 * report — but the CI is coming, and having the protection in place before the
 * first PR is worth more than avoiding a wait that resolves itself. So this only
 * decides whether to print a warning.
 */
async function hasRunCi(context: Context): Promise<boolean> {
  const { octokit, owner, repo } = context;

  try {
    const { data } = await octokit.request(
      'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs',
      { owner, repo: repo.name, workflow_id: 'ci.yml', per_page: 1 },
    );
    return (data as { total_count: number }).total_count > 0;
  } catch (error) {
    if (isStatus(error, 404)) {
      return false;
    }
    throw error;
  }
}

export const rulesetsProvider: Provider = {
  name: 'rulesets',
  describe: 'the four branch rulesets on the default branch',

  async plan(context: Context): Promise<ProviderPlan> {
    const { octokit, owner, repo } = context;
    const params = { owner, repo: repo.name };

    const { data: liveList } = await octokit.request('GET /repos/{owner}/{repo}/rulesets', params);
    const byName = new Map((liveList as LiveRuleset[]).map((rule) => [rule.name, rule]));

    const changes: Change[] = [];
    const warnings: string[] = [];
    const creates: Array<{ name: string; body: CreateParams }> = [];
    const updates: Array<{ name: string; body: UpdateParams }> = [];

    const ciHasRun = await hasRunCi(context);

    for (const name of RULESET_NAMES) {
      const declared = loadRuleset(name as RulesetName);
      const live = byName.get(name);

      if (name === 'ci-required' && !ciHasRun) {
        warnings.push(
          'ci-required applied without a ci.yml run on this repo yet: PRs will wait on `ci / ci` until the CI caller lands.',
        );
      }

      if (!live) {
        creates.push({ name, body: { ...params, ...payload<CreateParams>(declared) } });
        changes.push({ key: `ruleset ${name}`, from: undefined, to: 'active', kind: 'create' });
        continue;
      }

      const { data: full } = await octokit.request(
        'GET /repos/{owner}/{repo}/rulesets/{ruleset_id}',
        { ...params, ruleset_id: live.id },
      );

      const current = project(full as Record<string, unknown>, declared);
      const desired = project(declared, declared);

      const drift = diffPaths(desired, current, `ruleset ${name}`);
      if (drift.length > 0) {
        updates.push({
          name,
          body: { ...params, ...payload<UpdateParams>(declared), ruleset_id: live.id },
        });
        changes.push(...drift);
      }
    }

    return {
      changes,
      warnings,
      async apply() {
        // Each ruleset is applied on its own and its failure recorded rather
        // than thrown. They are independent protections, and letting a rejected
        // `pr-required` take `no-force-push` and `no-delete` down with it leaves
        // the repo less protected than if the tool had never run.
        const failures: string[] = [];

        for (const { name, body } of creates) {
          try {
            await octokit.rest.repos.createRepoRuleset(body);
          } catch (error) {
            failures.push(`${name}: ${(error as Error).message}`);
          }
        }
        for (const { name, body } of updates) {
          try {
            await octokit.rest.repos.updateRepoRuleset(body);
          } catch (error) {
            failures.push(`${name}: ${(error as Error).message}`);
          }
        }

        if (failures.length > 0) {
          throw new Error(failures.join('; '));
        }
      },
    };
  },
};
