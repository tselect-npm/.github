/**
 * The git the release scripts do, kept mechanical.
 *
 * Nothing here decides anything — which commits count, which tag to cut, whether
 * to push — so that the policy all lives in `publish-plan.ts` and `publish.ts`
 * where it can be read in one go. These are the verbs.
 *
 * The jobs that call this check out with `fetch-depth: 0`, so the full history
 * and every tag are present. A shallow checkout would make `commitsSince` return
 * a truncated range and the inferred bump quietly wrong, which is why
 * `assertFullHistory` exists.
 */
import * as core from './core.ts';
import { capture, run, tryCapture } from './exec.ts';
import type { Commit } from './gitmoji.ts';

/**
 * Field and record separators for `git log --format`.
 *
 * Commit messages contain newlines, blank lines and any punctuation a person
 * felt like typing, so a line- or character-delimited format is not parseable.
 * ASCII unit (0x1f) and record (0x1e) separators cannot appear in a commit
 * message written by any normal tool, which makes the split unambiguous.
 */
const FIELD = '\x1f';
const RECORD = '\x1e';

export function head(): string {
  return capture('git', ['rev-parse', 'HEAD']).trim();
}

export function currentBranch(): string {
  return capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
}

/** Whether the working tree and index are free of changes. */
export function isClean(): boolean {
  return capture('git', ['status', '--porcelain']).trim() === '';
}

/**
 * Fail unless the checkout carries the whole history.
 *
 * A shallow clone does not error when asked for a commit range — it returns
 * however much it has. The bump would then be inferred from a suffix of the
 * history, which is exactly the kind of wrong that looks right.
 */
export function assertFullHistory(): void {
  const shallow = capture('git', ['rev-parse', '--is-shallow-repository']).trim();

  core.assert(
    shallow === 'false',
    'the checkout is shallow — the release jobs must check out with `fetch-depth: 0`',
  );
}

export function tagExists(tag: string): boolean {
  return tryCapture('git', ['rev-parse', '--verify', `refs/tags/${tag}`]) !== null;
}

/** The commit a tag points at, or null if there is no such tag. */
export function tagCommit(tag: string): string | null {
  // `rev-list` rather than `rev-parse`: an annotated tag is its own object, so
  // `rev-parse v1.0.0` returns the tag's sha, which never equals a commit sha.
  // `rev-list -n 1` dereferences to the commit the tag wraps.
  return tryCapture('git', ['rev-list', '-n', '1', tag])?.trim() ?? null;
}

/** Whether `ref` is an ancestor of HEAD (or HEAD itself). */
export function isReachable(ref: string): boolean {
  return tryCapture('git', ['merge-base', '--is-ancestor', ref, 'HEAD']) !== null;
}

/** Every tag in the repository, newest first by version order. */
export function tags(): string[] {
  return capture('git', ['tag', '--list', '--sort=-v:refname']).split('\n').filter(Boolean);
}

/**
 * Commits reachable from HEAD, newest first, excluding merges.
 *
 * `since` is exclusive; passing null walks back to the root commit. Merges are
 * dropped because their subjects are generated (`Merge pull request #20 from …`)
 * and carry no gitmoji — counting them would mean every squash-free release
 * picked up unrecognized-subject warnings for commits nobody wrote.
 */
export function commitsSince(since: string | null): Commit[] {
  const range = since ? [`${since}..HEAD`] : ['HEAD'];

  const output = capture('git', [
    'log',
    '--no-merges',
    `--format=%H${FIELD}%s${FIELD}%b${RECORD}`,
    ...range,
  ]);

  return output
    .split(RECORD)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = '', subject = '', body = ''] = record.split(FIELD);
      return { sha, subject, body };
    });
}

/**
 * Identify commits as the Actions bot.
 *
 * This is the account GitHub attributes `GITHUB_TOKEN` pushes to, and the numeric
 * address is what makes the commit link to the bot's profile in the UI rather
 * than showing as an unknown author.
 */
export function configureBot(): void {
  run('git', ['config', 'user.name', 'github-actions[bot]']);
  run('git', [
    'config',
    'user.email',
    '41898282+github-actions[bot]@users.noreply.github.com',
  ]);
}

/** Stage `paths` and commit them. */
export function commit(paths: string[], message: string): void {
  run('git', ['add', '--', ...paths]);
  run('git', ['commit', '--message', message]);
}

/** Create an annotated tag at HEAD. */
export function tag(name: string, message: string): void {
  run('git', ['tag', '--annotate', name, '--message', message]);
}

/**
 * Push a branch and a tag in one atomic transaction.
 *
 * `--atomic` is the point: without it the branch can land and the tag fail (or
 * the reverse), leaving `main` carrying a version bump with nothing tagging it.
 * One transaction means the repository either has both or neither.
 */
export function pushAtomic(branch: string, tagName: string): void {
  run('git', ['push', '--atomic', 'origin', `HEAD:refs/heads/${branch}`, `refs/tags/${tagName}`]);
}
