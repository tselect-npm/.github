/**
 * `tselect check` — validate everything under `config/`, `rulesets/` and
 * `templates/` without touching the network.
 *
 * This is what `self-check.yml` runs. Reusing the CLI's own loaders rather than
 * re-stating the rules in a `node --eval` block is the point: a validator that
 * drifts from the code it is meant to protect passes a file the tool then
 * rejects, which is worse than having no validator.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, RULESET_NAMES, loadLabels, loadRepos, loadRuleset, loadSettings } from '../lib/config.ts';
import { style } from '../lib/diff.ts';

export function check(): number {
  const problems: string[] = [];
  const checked: string[] = [];

  const step = (label: string, fn: () => void): void => {
    try {
      fn();
      checked.push(label);
    } catch (error) {
      problems.push(`${label}: ${(error as Error).message}`);
    }
  };

  step('config/repos.json', () => {
    const config = loadRepos();
    const seen = new Set<string>();
    for (const repo of config.repos) {
      if (seen.has(repo.name)) {
        throw new Error(`"${repo.name}" appears twice`);
      }
      seen.add(repo.name);
    }
  });

  step('config/repo-settings.json', () => {
    const settings = loadSettings();
    const scanning = settings.security.code_scanning_default_setup;
    if (scanning.state !== 'configured' && scanning.state !== 'not-configured') {
      throw new Error(`code_scanning_default_setup.state must be configured or not-configured`);
    }
    if (!Array.isArray(scanning.languages) || scanning.languages.length === 0) {
      throw new Error('code_scanning_default_setup.languages must be a non-empty array');
    }
    // Squash-only in settings has to agree with the ruleset, or the UI offers
    // buttons that the ruleset then rejects at click time.
    if (settings.allow_squash_merge !== true) {
      throw new Error('allow_squash_merge must be true; rulesets/pr-required.json allows only squash');
    }
  });

  step('config/labels.json', () => {
    const labels = loadLabels();
    if (!labels.labels.some((label) => label.name === 'dependencies')) {
      throw new Error('the `dependencies` label is required; .github/dependabot.yml applies it by name');
    }
  });

  for (const name of RULESET_NAMES) {
    step(`rulesets/${name}.json`, () => {
      const ruleset = loadRuleset(name);
      for (const key of ['name', 'target', 'enforcement', 'rules']) {
        if (!(key in ruleset)) {
          throw new Error(`missing ${key}`);
        }
      }
      if (ruleset.name !== name) {
        throw new Error(`declares name "${String(ruleset.name)}" but lives in ${name}.json`);
      }
    });
  }

  step('templates/workflows', () => {
    const config = loadRepos();
    for (const workflow of ['ci.yml', 'publish.yml']) {
      if (!existsSync(join(ROOT, 'templates', 'workflows', workflow))) {
        throw new Error(`templates/workflows/${workflow} is missing`);
      }
    }
    // A per-repo override directory named after a repo that is not in
    // repos.json never applies to anything. It is not an error the tool would
    // ever report at run time — it just silently stops being used the day the
    // repo is renamed — so it is caught here instead.
    const names = new Set(config.repos.map((repo) => repo.name));
    const overrides = readdirSync(join(ROOT, 'templates', 'workflows'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    for (const override of overrides) {
      if (!names.has(override)) {
        throw new Error(`templates/workflows/${override}/ does not match any repo in repos.json`);
      }
    }
  });

  for (const label of checked) {
    console.log(`  ${style.green('✓')} ${label}`);
  }
  for (const problem of problems) {
    console.log(`  ${style.red('✗')} ${problem}`);
  }

  return problems.length > 0 ? 1 : 0;
}
