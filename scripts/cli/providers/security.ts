/**
 * The security toggles — Dependabot, secret scanning, private reporting, CodeQL.
 *
 * These are separate from `settings` because almost none of them live in the
 * repository object: each is its own endpoint with its own idea of how to say
 * "on" (a 204 versus a 404, an `{enabled, paused}` object, a `state` string).
 * Normalising that into ordinary booleans is most of what this file does.
 *
 * Raw `octokit.request` routes rather than the `rest.*` helpers: these endpoints
 * are the ones whose helper names have moved between Octokit majors, and the
 * route strings have not.
 */
import type { SecurityConfig } from '../lib/config.ts';
import { equal, type Change } from '../lib/diff.ts';
import { isStatus } from '../lib/github.ts';
import type { Context, Provider, ProviderPlan } from './types.ts';

/** A 204/404 endpoint, read as a boolean. */
async function readFlag(request: Promise<unknown>): Promise<boolean> {
  try {
    await request;
    return true;
  } catch (error) {
    if (isStatus(error, 404)) {
      return false;
    }
    throw error;
  }
}

/**
 * CodeQL reports back more languages than you send it: `javascript-typescript`
 * comes home as itself plus `javascript` and `typescript`. Collapsing them keeps
 * the diff from reporting a change that applying can never resolve.
 */
function normalizeLanguages(languages: string[]): string[] {
  const set = new Set(languages);
  if (set.has('javascript-typescript')) {
    set.delete('javascript');
    set.delete('typescript');
  }
  return [...set].sort();
}

/**
 * Which CodeQL languages this repo can actually be analysed for.
 *
 * Derived from the repo rather than read off the default-setup response, because
 * that response only lists available languages while setup is *off*; once it is
 * on, the field means "currently analysed" instead. Trusting it in both states
 * produced a diff that could never settle — the tool asked for `actions` forever
 * on a repo with no workflows, and the API refused it every time.
 */
async function availableLanguages(context: Context): Promise<string[]> {
  const { octokit, owner, repo } = context;
  const available: string[] = [];

  const { data: languages } = await octokit.rest.repos.listLanguages({ owner, repo: repo.name });
  if ('JavaScript' in languages || 'TypeScript' in languages) {
    available.push('javascript-typescript');
  }

  // `actions` analyses workflow files, so it is available exactly when there are
  // some. Reading a directory listing needs no `workflow` scope; writing would.
  const workflows = await octokit
    .request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner,
      repo: repo.name,
      path: '.github/workflows',
    })
    .then((response) => (Array.isArray(response.data) ? response.data.length : 0))
    .catch((error: unknown) => {
      if (isStatus(error, 404)) return 0;
      throw error;
    });
  if (workflows > 0) {
    available.push('actions');
  }

  return available.sort();
}

export const securityProvider: Provider = {
  name: 'security',
  describe: 'Dependabot, secret scanning, private reporting and CodeQL default setup',

  async plan(context: Context): Promise<ProviderPlan> {
    const { octokit, owner, repo, settings } = context;
    const desired: SecurityConfig = settings.security;
    const params = { owner, repo: repo.name };

    const [live, alerts, fixes, reporting] = await Promise.all([
      octokit.rest.repos.get(params),
      readFlag(octokit.request('GET /repos/{owner}/{repo}/vulnerability-alerts', params)),
      octokit
        .request('GET /repos/{owner}/{repo}/automated-security-fixes', params)
        .then((response) => {
          const body = response.data as { enabled?: boolean; paused?: boolean };
          // A paused repo still answers `enabled: true`, but Dependabot opens
          // nothing. Only unpaused-and-enabled counts as on.
          return body.enabled === true && body.paused !== true;
        })
        .catch((error: unknown) => {
          if (isStatus(error, 404)) return false;
          throw error;
        }),
      readFlag(
        octokit.request('GET /repos/{owner}/{repo}/private-vulnerability-reporting', params),
      ),
    ]);

    const analysis = (live.data.security_and_analysis ?? {}) as Record<
      string,
      { status?: string } | undefined
    >;

    const scanningKeys = [
      'secret_scanning',
      'secret_scanning_push_protection',
      'secret_scanning_non_provider_patterns',
      'secret_scanning_validity_checks',
    ] as const;

    const changes: Change[] = [];
    const analysisPatch: Record<string, { status: string }> = {};

    for (const key of scanningKeys) {
      const want = desired[key];
      const have = analysis[key]?.status;
      if (want !== have) {
        changes.push({ key, from: have, to: want, kind: 'update' });
        analysisPatch[key] = { status: want };
      }
    }

    const flags: Array<[string, boolean, boolean]> = [
      ['vulnerability_alerts', alerts, desired.vulnerability_alerts],
      ['automated_security_fixes', fixes, desired.automated_security_fixes],
      ['private_vulnerability_reporting', reporting, desired.private_vulnerability_reporting],
    ];
    for (const [key, have, want] of flags) {
      if (have !== want) {
        changes.push({ key, from: have, to: want, kind: 'update' });
      }
    }

    // CodeQL default setup. A repo that never had it enabled answers 404.
    const wantedScanning = desired.code_scanning_default_setup;
    const currentScanning = await octokit
      .request('GET /repos/{owner}/{repo}/code-scanning/default-setup', params)
      .then((response) => response.data as { state: string; query_suite?: string; languages?: string[] })
      .catch((error: unknown) => {
        if (isStatus(error, 404) || isStatus(error, 403)) return null;
        throw error;
      });

    const warnings: string[] = [];
    let scanningPatch: Record<string, unknown> | null = null;

    if (currentScanning === null) {
      warnings.push(
        'code scanning is not readable on this repo (404/403); skipping CodeQL default setup',
      );
    } else if (wantedScanning.state === 'configured') {
      const sameState = currentScanning.state === 'configured';
      const liveLanguages = normalizeLanguages(currentScanning.languages ?? []);

      const available = await availableLanguages(context);
      const requested = wantedScanning.languages.filter((language) =>
        available.includes(language),
      );

      const dropped = wantedScanning.languages.filter((language) => !requested.includes(language));
      if (dropped.length > 0) {
        warnings.push(
          `CodeQL: ${dropped.join(', ')} not available in this repo yet; enabling for ${requested.join(', ')}. Re-run once the repo has workflows.`,
        );
      }

      const sameSuite = (currentScanning.query_suite ?? null) === wantedScanning.query_suite;
      const sameLanguages =
        sameState && equal(normalizeLanguages(requested), liveLanguages);

      if (requested.length === 0) {
        warnings.push('CodeQL: none of the declared languages are available; skipping');
      } else if (!sameState || !sameSuite || !sameLanguages) {
        changes.push({
          key: 'code_scanning_default_setup',
          from: sameState
            ? { query_suite: currentScanning.query_suite, languages: liveLanguages }
            : currentScanning.state,
          to: { query_suite: wantedScanning.query_suite, languages: normalizeLanguages(requested) },
          kind: sameState ? 'update' : 'create',
        });
        scanningPatch = {
          state: 'configured',
          query_suite: wantedScanning.query_suite,
          languages: requested,
        };
      }
    } else if (currentScanning.state === 'configured') {
      changes.push({
        key: 'code_scanning_default_setup',
        from: 'configured',
        to: 'not-configured',
        kind: 'delete',
      });
      scanningPatch = { state: 'not-configured' };
    }

    return {
      changes,
      warnings,
      async apply() {
        if (Object.keys(analysisPatch).length > 0) {
          await octokit.rest.repos.update({ ...params, security_and_analysis: analysisPatch });
        }

        for (const [key, have, want] of flags) {
          if (have === want) continue;

          const route = {
            vulnerability_alerts: '/repos/{owner}/{repo}/vulnerability-alerts',
            automated_security_fixes: '/repos/{owner}/{repo}/automated-security-fixes',
            private_vulnerability_reporting:
              '/repos/{owner}/{repo}/private-vulnerability-reporting',
          }[key];

          await octokit.request(`${want ? 'PUT' : 'DELETE'} ${route}`, params);
        }

        if (scanningPatch) {
          // Enabling default setup queues an analysis; 202 is the success case.
          await octokit.request(
            'PATCH /repos/{owner}/{repo}/code-scanning/default-setup',
            { ...params, ...scanningPatch },
          );
        }
      },
    };
  },
};
