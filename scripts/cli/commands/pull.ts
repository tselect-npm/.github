/**
 * `tselect pull` — snapshot the reference repo's live configuration into
 * `config/`.
 *
 * This is how the desired state stays honest: `url` was configured by hand in
 * the web UI, so the checked-in files are downstream of it rather than the other
 * way round. Change something in the UI, run `pull`, review the diff, commit —
 * and `sync` then carries it to the other six.
 *
 * Comments survive the round trip because they are `//`-prefixed *keys*: ordinary
 * JSON, preserved by parse-mutate-stringify along with key order. That is the
 * reason the config files are `.json` and not `.jsonc`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, RULESET_NAMES, loadRepos } from '../lib/config.ts';
import { style } from '../lib/diff.ts';
import { client, isStatus } from '../lib/github.ts';

export interface PullOptions {
  from?: string;
  /** Also rewrite `rulesets/*.json` from the reference repo's live rulesets. */
  rulesets: boolean;
  /** Also reseed each repo's description and topics in `config/repos.json`. */
  repos: boolean;
}

/** Parse without stripping `//` keys — `pull` has to write them back. */
function readRaw(...segments: string[]): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, ...segments), 'utf8')) as Record<string, unknown>;
}

function write(value: unknown, ...segments: string[]): void {
  writeFileSync(join(ROOT, ...segments), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  console.log(`  ${style.green('✓')} ${segments.join('/')}`);
}

/**
 * Overwrite the values of keys that already exist, and nothing else.
 *
 * A blind merge would import every field the API returns — ids, timestamps,
 * `permissions`, the whole owner object — into a file whose job is to say which
 * handful of settings this project has an opinion about. The existing key set
 * *is* that opinion, so it is what bounds the update.
 */
function updateExisting(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): string[] {
  const changed: string[] = [];

  for (const key of Object.keys(target)) {
    if (key.startsWith('//') || !(key in source)) {
      continue;
    }
    if (JSON.stringify(target[key]) !== JSON.stringify(source[key])) {
      changed.push(key);
      target[key] = source[key];
    }
  }

  return changed;
}

export async function pull(options: PullOptions): Promise<number> {
  const config = loadRepos();
  const reference = options.from ?? config.reference;
  const octokit = client();
  const params = { owner: config.owner, repo: reference };

  console.log(`Snapshotting ${style.bold(`${config.owner}/${reference}`)}\n`);

  // --- config/repo-settings.json -------------------------------------------
  const { data: live } = await octokit.rest.repos.get(params);
  const settings = readRaw('config', 'repo-settings.json');

  const changedSettings = updateExisting(settings, live as unknown as Record<string, unknown>);

  const security = settings.security as Record<string, unknown>;
  const analysis = (live.security_and_analysis ?? {}) as Record<string, { status?: string }>;
  for (const key of Object.keys(security)) {
    if (key.startsWith('//')) continue;
    if (analysis[key]?.status !== undefined && security[key] !== analysis[key].status) {
      changedSettings.push(`security.${key}`);
      security[key] = analysis[key].status;
    }
  }

  const flags: Array<[string, string]> = [
    ['vulnerability_alerts', '/repos/{owner}/{repo}/vulnerability-alerts'],
    ['private_vulnerability_reporting', '/repos/{owner}/{repo}/private-vulnerability-reporting'],
  ];
  for (const [key, route] of flags) {
    const enabled = await octokit
      .request(`GET ${route}`, params)
      .then(() => true)
      .catch((error: unknown) => {
        if (isStatus(error, 404)) return false;
        throw error;
      });
    if (security[key] !== enabled) {
      changedSettings.push(`security.${key}`);
      security[key] = enabled;
    }
  }

  const fixes = await octokit
    .request('GET /repos/{owner}/{repo}/automated-security-fixes', params)
    .then((response) => {
      const body = response.data as { enabled?: boolean; paused?: boolean };
      return body.enabled === true && body.paused !== true;
    })
    .catch(() => false);
  if (security.automated_security_fixes !== fixes) {
    changedSettings.push('security.automated_security_fixes');
    security.automated_security_fixes = fixes;
  }

  const scanning = await octokit
    .request('GET /repos/{owner}/{repo}/code-scanning/default-setup', params)
    .then((response) => response.data as { state: string; query_suite?: string; languages?: string[] })
    .catch(() => null);
  if (scanning) {
    const declared = security.code_scanning_default_setup as Record<string, unknown>;
    if (declared.state !== scanning.state) {
      changedSettings.push('security.code_scanning_default_setup.state');
      declared.state = scanning.state;
    }
    if (scanning.query_suite && declared.query_suite !== scanning.query_suite) {
      changedSettings.push('security.code_scanning_default_setup.query_suite');
      declared.query_suite = scanning.query_suite;
    }
    // Languages are intentionally *not* pulled: the API echoes back the expanded
    // set (`javascript-typescript` becomes three entries) and writing that back
    // would turn the declared input into something CodeQL will not accept.
  }

  write(settings, 'config', 'repo-settings.json');
  console.log(
    changedSettings.length > 0
      ? `    ${style.yellow('changed')}: ${changedSettings.join(', ')}`
      : `    ${style.dim('no change')}`,
  );

  // --- config/labels.json ---------------------------------------------------
  const liveLabels = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, {
    ...params,
    per_page: 100,
  });
  const labelsFile = readRaw('config', 'labels.json');
  labelsFile.labels = liveLabels
    .map((label) => ({
      name: label.name,
      color: label.color,
      description: label.description ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  write(labelsFile, 'config', 'labels.json');

  // --- rulesets/*.json (opt-in) --------------------------------------------
  const { data: liveRulesets } = await octokit.request('GET /repos/{owner}/{repo}/rulesets', params);
  const byName = new Map(
    (liveRulesets as Array<{ id: number; name: string }>).map((rule) => [rule.name, rule]),
  );

  for (const name of RULESET_NAMES) {
    const live = byName.get(name);
    if (!live) {
      console.log(`  ${style.yellow('!')} ${name} is absent from ${reference}`);
      continue;
    }
    if (!options.rulesets) {
      continue;
    }

    const { data: full } = await octokit.request('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}', {
      ...params,
      ruleset_id: live.id,
    });
    const body = full as Record<string, unknown>;

    write(
      {
        name: body.name,
        target: body.target,
        source_type: 'Repository',
        enforcement: body.enforcement,
        conditions: body.conditions,
        rules: body.rules,
        bypass_actors: body.bypass_actors,
      },
      'rulesets',
      `${name}.json`,
    );
  }

  if (!options.rulesets) {
    console.log(
      `  ${style.dim(`rulesets/ left alone; pass --rulesets to overwrite them from ${reference}`)}`,
    );
  }

  // --- config/repos.json (opt-in) ------------------------------------------
  if (options.repos) {
    const reposFile = readRaw('config', 'repos.json');
    const entries = reposFile.repos as Array<Record<string, unknown>>;

    for (const entry of entries) {
      const { data: repoLive } = await octokit.rest.repos.get({
        owner: config.owner,
        repo: entry.name as string,
      });
      entry.description = repoLive.description ?? '';
      entry.topics = (repoLive.topics ?? []).slice().sort();
    }

    write(reposFile, 'config', 'repos.json');
  }

  console.log(`\n${style.bold('Review the diff before committing.')}`);
  return 0;
}
