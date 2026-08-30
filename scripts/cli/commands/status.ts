/**
 * `tselect status` — one row per repo, no writes, no config comparison.
 *
 * Deliberately not a diff. `sync` answers "what is wrong"; this answers "where is
 * each repo up to", which is the question actually asked while working through
 * CHECKLIST.md one package at a time.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadRepos, selectRepos } from '../lib/config.ts';
import { pad, style, visibleLength } from '../lib/diff.ts';
import { client, isStatus } from '../lib/github.ts';

interface Row {
  repo: string;
  branch: string;
  rulesets: string;
  labels: string;
  codeql: string;
  workflows: string;
  local: string;
}

const YES = style.green('yes');
const NO = style.dim('no');

export async function status(repoNames: string[]): Promise<number> {
  const config = loadRepos();
  const repos = selectRepos(config, repoNames);
  const octokit = client();

  const rows: Row[] = [];

  for (const repo of repos) {
    const params = { owner: config.owner, repo: repo.name };

    const [live, rulesets, labels, codeql] = await Promise.all([
      octokit.rest.repos.get(params),
      octokit
        .request('GET /repos/{owner}/{repo}/rulesets', params)
        .then((response) => (response.data as unknown[]).length),
      octokit
        .paginate(octokit.rest.issues.listLabelsForRepo, { ...params, per_page: 100 })
        .then((all) => all.length),
      octokit
        .request('GET /repos/{owner}/{repo}/code-scanning/default-setup', params)
        .then((response) => (response.data as { state: string }).state === 'configured')
        .catch((error: unknown) => {
          if (isStatus(error, 404) || isStatus(error, 403)) return false;
          throw error;
        }),
    ]);

    const clonePath = join(ROOT, '..', repo.name);
    const hasClone = existsSync(clonePath);
    const modernized =
      hasClone &&
      existsSync(join(clonePath, 'pnpm-lock.yaml')) &&
      existsSync(join(clonePath, 'biome.json'));

    const workflowDir = join(clonePath, '.github', 'workflows');
    const present = ['ci.yml', 'publish.yml'].filter((file) =>
      existsSync(join(workflowDir, file)),
    );

    rows.push({
      repo: repo.name,
      branch: live.data.default_branch === 'main' ? 'main' : style.yellow(live.data.default_branch),
      rulesets: rulesets === 4 ? style.green('4/4') : style.yellow(`${rulesets}/4`),
      labels: String(labels),
      codeql: codeql ? YES : NO,
      workflows: present.length === 0 ? NO : present.map((f) => f.replace('.yml', '')).join('+'),
      local: !hasClone ? style.dim('absent') : modernized ? YES : style.yellow('legacy'),
    });
  }

  const headers: Row = {
    repo: 'REPO',
    branch: 'BRANCH',
    rulesets: 'RULESETS',
    labels: 'LABELS',
    codeql: 'CODEQL',
    workflows: 'WORKFLOWS',
    local: 'MODERNIZED',
  };

  const columns = Object.keys(headers) as Array<keyof Row>;
  const widths = Object.fromEntries(
    columns.map((column) => [
      column,
      Math.max(...[headers, ...rows].map((row) => visibleLength(row[column]))),
    ]),
  ) as Record<keyof Row, number>;

  console.log(
    style.bold(columns.map((column) => pad(headers[column], widths[column])).join('  ')),
  );
  for (const row of rows) {
    console.log(columns.map((column) => pad(row[column], widths[column])).join('  '));
  }

  console.log(
    `\n${style.dim('MODERNIZED and WORKFLOWS are read from the local clone; everything else from the API.')}`,
  );

  return 0;
}
