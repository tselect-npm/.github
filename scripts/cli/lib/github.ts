/**
 * The GitHub client, and the small amount of REST that Octokit does not type
 * usefully.
 *
 * Unlike `scripts/ci/`, this code never runs on a runner — it runs on a laptop,
 * against the API, with a human watching. So the dependency-free rule that keeps
 * `pnpm dlx tsx` down to one package does not apply here, and `octokit` earns its
 * place: pagination, retry on secondary rate limits, and response types that make
 * the diffing code checkable.
 */
import { Octokit } from 'octokit';
import { tryCapture } from '../../ci/lib/exec.ts';

/**
 * A token, from `gh auth token` if the CLI is signed in, else `GITHUB_TOKEN`.
 *
 * Deliberately no third source. The whole point of leaning on `gh` is that this
 * tool introduces no new secret to store, rotate or leak — if `gh` is signed in,
 * the tool works, and if it is not, the fix is `gh auth login` rather than
 * anything specific to `tselect`.
 */
export function resolveToken(): string {
  const fromGh = tryCapture('gh', ['auth', 'token'])?.trim();
  if (fromGh) {
    return fromGh;
  }

  const fromEnv = process.env.GITHUB_TOKEN?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  throw new Error(
    'no GitHub token: run `gh auth login`, or set GITHUB_TOKEN to a token with `repo` scope',
  );
}

export function client(): Octokit {
  return new Octokit({ auth: resolveToken() });
}

/**
 * Scopes attached to the token, as GitHub reports them on the response header.
 *
 * Checked up front so a run fails with "your token is missing X" rather than with
 * a 403 from the middle of the fourth repo, half-applied. A fine-grained token
 * sends no `x-oauth-scopes` header at all; that is reported as unknown rather
 * than as empty, because "no scopes" and "scopes not expressible this way" call
 * for very different advice.
 */
export async function tokenScopes(octokit: Octokit): Promise<string[] | null> {
  const response = await octokit.request('GET /user');
  const header = response.headers['x-oauth-scopes'];

  if (typeof header !== 'string') {
    return null;
  }

  return header
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
}

/** True when a request rejected with the given HTTP status. */
export function isStatus(error: unknown, status: number): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === status;
}

/**
 * Run a request, returning null on 404 instead of throwing.
 *
 * Most of the "is this configured?" reads answer with a 404 when the answer is
 * no — an absent environment, a repo with CodeQL default setup never enabled.
 * That is the reading, not a failure.
 */
export async function optional<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch (error) {
    if (isStatus(error, 404)) {
      return null;
    }
    throw error;
  }
}
