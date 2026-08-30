/**
 * `tselect sync` — the one that does the work.
 *
 * Dry-run unless `--apply`. Each provider plans against live state and hands
 * back both the changes and the closure that performs them, so what `--apply`
 * runs is by construction the list that was just printed.
 */
import { join } from 'node:path';
import {
  ROOT,
  loadLabels,
  loadRepos,
  loadSettings,
  selectRepos,
  type RepoConfig,
} from '../lib/config.ts';
import { renderChange, style } from '../lib/diff.ts';
import { client, tokenScopes } from '../lib/github.ts';
import { selectProviders } from '../providers/index.ts';
import type { Context } from '../providers/types.ts';

export interface SyncOptions {
  repos: string[];
  only: string[];
  skip: string[];
  apply: boolean;
}

/**
 * Where a package's clone lives: a sibling of this repository.
 *
 * The workspace is seven clones plus this one in a plain directory, so
 * `../<name>` is the whole rule. Only the `files` provider cares.
 */
function clonePathFor(repo: RepoConfig): string {
  return join(ROOT, '..', repo.name);
}

export async function sync(options: SyncOptions): Promise<number> {
  const config = loadRepos();
  const settings = loadSettings();
  const labels = loadLabels();
  const repos = selectRepos(config, options.repos);
  const providers = selectProviders(options.only, options.skip);
  const octokit = client();

  // Checked once, up front. The alternative is discovering a missing scope as a
  // 403 from the middle of the fourth repo, with three repos already changed.
  if (options.apply) {
    const scopes = await tokenScopes(octokit);
    if (scopes && !scopes.includes('repo')) {
      throw new Error(
        `token is missing the \`repo\` scope (has: ${scopes.join(', ') || 'none'}); run \`gh auth refresh -s repo\``,
      );
    }
  }

  console.log(
    options.apply
      ? style.bold(`Applying to ${repos.length} repo(s) in ${config.owner}\n`)
      : `${style.bold(`Planning ${repos.length} repo(s) in ${config.owner}`)} ${style.dim('(dry run — pass --apply to write)')}\n`,
  );

  let totalChanges = 0;
  let failures = 0;

  for (const repo of repos) {
    console.log(style.bold(style.cyan(`${config.owner}/${repo.name}`)));

    const context: Context = {
      octokit,
      owner: config.owner,
      repo,
      settings,
      labels,
      clonePath: clonePathFor(repo),
    };

    let repoChanges = 0;

    for (const provider of providers) {
      let plan: Awaited<ReturnType<typeof provider.plan>>;

      try {
        plan = await provider.plan(context);
      } catch (error) {
        failures += 1;
        console.log(`  ${style.red(`✗ ${provider.name}`)}: ${(error as Error).message}`);
        continue;
      }

      const hasOutput = plan.changes.length > 0 || plan.warnings.length > 0;
      if (!hasOutput) {
        continue;
      }

      console.log(`  ${style.bold(provider.name)}`);
      for (const change of plan.changes) {
        console.log(renderChange(change));
      }
      for (const warning of plan.warnings) {
        console.log(`    ${style.yellow('!')} ${warning}`);
      }

      repoChanges += plan.changes.length;
      totalChanges += plan.changes.length;

      if (options.apply && plan.changes.length > 0) {
        try {
          await plan.apply();
          console.log(`    ${style.green('✓')} applied`);
        } catch (error) {
          failures += 1;
          console.log(`    ${style.red('✗ failed')}: ${(error as Error).message}`);
        }
      }
    }

    if (repoChanges === 0) {
      console.log(`  ${style.green('✓')} up to date`);
    }
    console.log('');
  }

  if (failures > 0) {
    console.log(style.red(`${failures} provider(s) failed.`));
    return 1;
  }
  if (totalChanges === 0) {
    console.log(style.green('Everything is up to date.'));
    return 0;
  }

  console.log(
    options.apply
      ? style.green(`Applied ${totalChanges} change(s).`)
      : `${totalChanges} change(s) pending. Re-run with ${style.bold('--apply')} to write them.`,
  );
  return 0;
}
