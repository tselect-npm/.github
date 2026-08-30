/**
 * Loading and validating everything under `config/`, `rulesets/` and
 * `templates/`.
 *
 * The config files are plain `.json` rather than `.jsonc` so that
 * `self-check.yml` can keep parsing them with `JSON.parse` and no dependency.
 * Comments therefore travel as keys beginning with `//`, which is the convention
 * the repository's own `package.json` already uses. They are stripped before
 * anything is compared against the API or sent to it — a stray `//` key in a
 * PATCH body is a 422.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, resolved from this file rather than from `process.cwd()`. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface RepoConfig {
  name: string;
  description?: string;
  homepage?: string;
  topics?: string[];
}

export interface ReposConfig {
  owner: string;
  reference: string;
  repos: RepoConfig[];
}

export interface SecurityConfig {
  vulnerability_alerts: boolean;
  automated_security_fixes: boolean;
  private_vulnerability_reporting: boolean;
  secret_scanning: string;
  secret_scanning_push_protection: string;
  secret_scanning_non_provider_patterns: string;
  secret_scanning_validity_checks: string;
  code_scanning_default_setup: {
    state: 'configured' | 'not-configured';
    query_suite: string;
    languages: string[];
  };
}

export interface ActionsConfig {
  enabled: boolean;
  allowed_actions: string;
}

/**
 * The uniform half of a repo's settings.
 *
 * Everything not named here is a key of the `PATCH /repos` body; `security` and
 * `actions` are groupings for the endpoints that live elsewhere.
 */
export type SettingsConfig = Record<string, unknown> & {
  security: SecurityConfig;
  actions: ActionsConfig;
};

export interface LabelConfig {
  name: string;
  color: string;
  description: string | null;
}

export interface LabelsConfig {
  prune: boolean;
  labels: LabelConfig[];
}

/** Drop every `//`-prefixed key, recursively. */
export function stripComments<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripComments(item)) as T;
  }

  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (!key.startsWith('//')) {
        result[key] = stripComments(item);
      }
    }
    return result as T;
  }

  return value;
}

function readJson<T>(...segments: string[]): T {
  const path = join(ROOT, ...segments);
  try {
    return stripComments(JSON.parse(readFileSync(path, 'utf8')) as T);
  } catch (error) {
    throw new Error(`could not read ${path}: ${(error as Error).message}`);
  }
}

export function loadRepos(): ReposConfig {
  const config = readJson<ReposConfig>('config', 'repos.json');

  if (!config.owner || !Array.isArray(config.repos) || config.repos.length === 0) {
    throw new Error('config/repos.json: `owner` and a non-empty `repos` array are required');
  }
  if (!config.repos.some((repo) => repo.name === config.reference)) {
    throw new Error(
      `config/repos.json: reference repo "${config.reference}" is not in the repos list`,
    );
  }

  return config;
}

export function loadSettings(): SettingsConfig {
  const config = readJson<SettingsConfig>('config', 'repo-settings.json');

  if (!config.security || !config.actions) {
    throw new Error('config/repo-settings.json: `security` and `actions` objects are required');
  }

  return config;
}

export function loadLabels(): LabelsConfig {
  const config = readJson<LabelsConfig>('config', 'labels.json');

  if (!Array.isArray(config.labels)) {
    throw new Error('config/labels.json: a `labels` array is required');
  }
  for (const label of config.labels) {
    if (!label.name || !/^[0-9a-f]{6}$/i.test(label.color)) {
      throw new Error(
        `config/labels.json: "${label.name}" needs a name and a six-digit hex color without "#"`,
      );
    }
  }

  return config;
}

/**
 * The four rulesets, in the order they should be applied.
 *
 * `ci-required` is last on purpose: it is the only one whose effect depends on
 * something outside the repo's settings — a `ci / ci` check that has to start
 * reporting — so the three unconditional protections are in place first.
 */
export const RULESET_NAMES = ['pr-required', 'no-force-push', 'no-delete', 'ci-required'] as const;

export type RulesetName = (typeof RULESET_NAMES)[number];

export function loadRuleset(name: RulesetName): Record<string, unknown> {
  return readJson<Record<string, unknown>>('rulesets', `${name}.json`);
}

/**
 * Resolve the repos a command should act on.
 *
 * An empty selection means all of them; anything named has to exist in
 * `repos.json`, because silently doing nothing for a typo'd repo name is the
 * worst possible outcome for a tool whose whole job is applying settings.
 */
export function selectRepos(config: ReposConfig, names: string[]): RepoConfig[] {
  if (names.length === 0) {
    return config.repos;
  }

  const known = new Map(config.repos.map((repo) => [repo.name, repo]));
  return names.map((name) => {
    const repo = known.get(name);
    if (!repo) {
      throw new Error(
        `unknown repo "${name}"; known repos are ${config.repos.map((r) => r.name).join(', ')}`,
      );
    }
    return repo;
  });
}
