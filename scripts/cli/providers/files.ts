/**
 * The in-repo workflow callers, `.github/workflows/{ci,publish}.yml`.
 *
 * Two deliberate limits here.
 *
 * **It writes to the local clone, never through the API.** The Contents API
 * refuses to touch anything under `.github/workflows/` unless the token carries
 * the `workflow` scope, which `gh auth login` does not grant by default. Writing
 * files and letting the operator review, commit and push over SSH avoids needing
 * a broader token for a change that wants reviewing anyway. Nothing here stages,
 * commits or pushes.
 *
 * **It refuses repos that are not modernized yet.** Dropping a caller for the
 * pnpm/Vitest/tsdown workflow into a repo still on npm and Mocha does not
 * configure CI, it just adds a red X to every future commit. The gate is the
 * presence of the toolchain the workflow assumes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROOT } from '../lib/config.ts';
import { style, type Change } from '../lib/diff.ts';
import type { Context, Provider, ProviderPlan } from './types.ts';

const WORKFLOWS = ['ci.yml', 'publish.yml'] as const;

/**
 * A repo-specific template wins over the shared one.
 *
 * `thrown` and `http-method` both carry a paragraph in their `ci.yml` that is
 * true of that repo and no other. Rendering their callers from a shared file
 * plus a data key would delete those comments on the first sync, so the escape
 * hatch is a whole file: `templates/workflows/<repo>/ci.yml`.
 */
function templateFor(repo: string, workflow: string): string {
  const specific = join(ROOT, 'templates', 'workflows', repo, workflow);
  const shared = join(ROOT, 'templates', 'workflows', workflow);
  return existsSync(specific) ? specific : shared;
}

function render(templatePath: string, repo: string): string {
  return readFileSync(templatePath, 'utf8')
    .replaceAll('{{package}}', `@tselect/${repo}`)
    .replaceAll('{{repo}}', repo);
}

/** Does this clone use the toolchain the shared workflow drives? */
function isModernized(clonePath: string): boolean {
  return (
    existsSync(join(clonePath, 'pnpm-lock.yaml')) &&
    existsSync(join(clonePath, 'biome.json')) &&
    existsSync(join(clonePath, 'tsdown.config.ts'))
  );
}

/** First differing line, for a diff that says something without printing a file. */
function firstDifference(current: string, desired: string): string {
  const currentLines = current.split('\n');
  const desiredLines = desired.split('\n');

  for (let index = 0; index < Math.max(currentLines.length, desiredLines.length); index += 1) {
    if (currentLines[index] !== desiredLines[index]) {
      return `line ${index + 1}: ${style.red(currentLines[index] ?? '(end of file)')} → ${style.green(desiredLines[index] ?? '(removed)')}`;
    }
  }

  return 'no textual difference';
}

export const filesProvider: Provider = {
  name: 'files',
  describe: 'the .github/workflows callers in each local clone (writes files, never commits)',

  async plan(context: Context): Promise<ProviderPlan> {
    const { repo, clonePath, octokit, owner } = context;

    const changes: Change[] = [];
    const warnings: string[] = [];
    const writes: Array<{ path: string; content: string }> = [];

    if (!existsSync(clonePath)) {
      return {
        changes,
        warnings: [`no local clone at ${clonePath}; skipping`],
        apply: async () => {},
      };
    }

    if (!isModernized(clonePath)) {
      return {
        changes,
        warnings: [
          'not modernized yet (no pnpm-lock.yaml / biome.json / tsdown.config.ts); the shared workflow would fail here, so its callers are not written. Run CHECKLIST.md steps 1-7 first.',
        ],
        apply: async () => {},
      };
    }

    const { data: live } = await octokit.rest.repos.get({ owner, repo: repo.name });
    if (live.default_branch !== 'main') {
      warnings.push(
        `default branch is "${live.default_branch}"; the callers trigger on pushes to "main" and will not run until the rename`,
      );
    }

    for (const workflow of WORKFLOWS) {
      const target = join(clonePath, '.github', 'workflows', workflow);
      const desired = render(templateFor(repo.name, workflow), repo.name);
      const current = existsSync(target) ? readFileSync(target, 'utf8') : null;

      if (current === null) {
        writes.push({ path: target, content: desired });
        changes.push({
          key: `.github/workflows/${workflow}`,
          from: undefined,
          to: 'created from template',
          kind: 'create',
        });
      } else if (current !== desired) {
        writes.push({ path: target, content: desired });
        changes.push({
          key: `.github/workflows/${workflow}`,
          from: firstDifference(current, desired),
          to: 'template',
          kind: 'update',
        });
      }
    }

    if (writes.length > 0) {
      warnings.push('files are written to the working tree only — review, commit and push yourself');
    }

    return {
      changes,
      warnings,
      async apply() {
        for (const { path, content } of writes) {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, content, 'utf8');
        }
      },
    };
  },
};
