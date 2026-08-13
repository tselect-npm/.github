/**
 * Reading a release out of gitmoji commit subjects.
 *
 * These repositories have written gitmoji since 2016, which is the whole reason
 * an inferred bump is possible at all — the convention was already there and
 * `CHECKLIST.md` requires `main` to keep carrying it. This is the same bet
 * semantic-release makes on Conventional Commits, with the marker the history
 * actually uses.
 *
 * Three things about the mapping are worth knowing before trusting it:
 *
 *   1. **It is deliberately conservative about `major`.** Only `:boom:` and a
 *      `BREAKING CHANGE:` trailer raise one. gitmoji has no other unambiguous
 *      breaking marker, and inferring a major from, say, `:fire:` (remove code)
 *      or `:truck:` (rename resources) would be guessing with a consumer's
 *      install as the stake. Those two are flagged as worth a look instead.
 *
 *   2. **The tooling gitmoji release nothing**, because they change nothing a
 *      consumer receives: `:memo:`, `:white_check_mark:`, `:construction_worker:`,
 *      `:wrench:` and friends. This has one sharp edge that has already come up —
 *      the pilot committed `:wrench: Declare engines.node >=22`, which *is* a
 *      breaking change under the support policy. Raising the runtime floor,
 *      changing `exports`, or dropping an export are all breaking regardless of
 *      the emoji in front of them, and `:wrench:` will not say so. That is what
 *      the dispatch form's `bump` override is for, and it is how the seven
 *      modernization majors ship.
 *
 *   3. **Unrecognized subjects count as a patch**, not as nothing. Someone has
 *      already decided to publish by the time this runs; quietly discounting a
 *      commit nobody can see the emoji for is a worse failure than an
 *      unnecessary patch. Each one is warned about by name.
 *
 * The legacy shortcodes at the bottom of the table (`:shirt:`, `:muscle:`,
 * `:card_index:`, …) are not in gitmoji's list any more but are all over these
 * histories, so they are classified rather than left to fall through to the
 * unrecognized case.
 */
import * as core from './core.ts';
import type { Bump } from './semver.ts';

/** A bump, plus the "this commit releases nothing" case the table needs. */
export type Level = Bump | 'none';

const RANK: Record<Level, number> = { none: 0, patch: 1, minor: 2, major: 3 };

/** `[shortcode, unicode, level]`. Both spellings appear in the wild. */
const TABLE: ReadonlyArray<readonly [string, string, Level]> = [
  // --- breaking -------------------------------------------------------------
  [':boom:', '💥', 'major'],

  // --- features -------------------------------------------------------------
  [':sparkles:', '✨', 'minor'],
  [':tada:', '🎉', 'minor'],

  // --- fixes and changes a consumer can observe -----------------------------
  [':bug:', '🐛', 'patch'],
  [':ambulance:', '🚑️', 'patch'],
  [':lock:', '🔒️', 'patch'],
  [':zap:', '⚡️', 'patch'],
  [':recycle:', '♻️', 'patch'],
  [':fire:', '🔥', 'patch'],
  [':truck:', '🚚', 'patch'],
  [':rewind:', '⏪️', 'patch'],
  [':coffin:', '⚰️', 'patch'],
  [':alien:', '👽️', 'patch'],
  [':label:', '🏷️', 'patch'],
  [':necktie:', '👔', 'patch'],
  [':safety_vest:', '🦺', 'patch'],
  [':goal_net:', '🥅', 'patch'],
  [':stethoscope:', '🩺', 'patch'],
  [':thread:', '🧵', 'patch'],
  [':passport_control:', '🛂', 'patch'],
  [':adhesive_bandage:', '🩹', 'patch'],
  [':children_crossing:', '🚸', 'patch'],
  [':wheelchair:', '♿️', 'patch'],
  [':globe_with_meridians:', '🌐', 'patch'],
  [':speech_balloon:', '💬', 'patch'],
  [':pencil2:', '✏️', 'patch'],
  [':building_construction:', '🏗️', 'patch'],
  [':arrow_up:', '⬆️', 'patch'],
  [':arrow_down:', '⬇️', 'patch'],
  [':heavy_plus_sign:', '➕', 'patch'],
  [':heavy_minus_sign:', '➖', 'patch'],
  [':pushpin:', '📌', 'patch'],

  // --- nothing a consumer receives ------------------------------------------
  [':memo:', '📝', 'none'],
  [':white_check_mark:', '✅', 'none'],
  [':test_tube:', '🧪', 'none'],
  [':camera_flash:', '📸', 'none'],
  [':rotating_light:', '🚨', 'none'],
  [':art:', '🎨', 'none'],
  [':construction_worker:', '👷', 'none'],
  [':green_heart:', '💚', 'none'],
  [':wrench:', '🔧', 'none'],
  [':hammer:', '🔨', 'none'],
  [':bricks:', '🧱', 'none'],
  [':technologist:', '🧑‍💻', 'none'],
  [':bookmark:', '🔖', 'none'],
  [':rocket:', '🚀', 'none'],
  [':construction:', '🚧', 'none'],
  [':page_facing_up:', '📄', 'none'],
  [':see_no_evil:', '🙈', 'none'],
  [':closed_lock_with_key:', '🔐', 'none'],
  [':twisted_rightwards_arrows:', '🔀', 'none'],
  [':poop:', '💩', 'none'],
  [':seedling:', '🌱', 'none'],
  [':monocle_face:', '🧐', 'none'],
  [':money_with_wings:', '💸', 'none'],

  // --- retired shortcodes still present in these histories ------------------
  [':books:', '📚', 'none'],
  [':shirt:', '👕', 'none'],
  [':muscle:', '💪', 'patch'],
  [':racehorse:', '🐎', 'patch'],
  [':card_index:', '📇', 'patch'],
  [':shield:', '🛡️', 'patch'],
];

const LEVELS = new Map<string, Level>();
for (const [shortcode, unicode, level] of TABLE) {
  LEVELS.set(shortcode, level);
  LEVELS.set(unicode, level);
}

/**
 * `:fire:` and `:truck:` are patches here but are the two that most often are
 * not — deleting a file and renaming an export both break consumers, and gitmoji
 * gives them the same emoji whether or not the thing removed was public.
 */
const WORTH_A_LOOK = new Set([':fire:', '🔥', ':truck:', '🚚']);

export interface Commit {
  sha: string;
  subject: string;
  body: string;
}

export interface Classification {
  commit: Commit;
  level: Level;
  /** The gitmoji that decided it, or '' when nothing was recognized. */
  marker: string;
}

/**
 * A commit is classified by the *first* token of its subject.
 *
 * Anchoring at the start is what keeps a subject like `:bug: Fix the :boom:
 * handler` from reading as a breaking change: the emoji that means something is
 * the one the convention puts first, and any other occurrence is prose.
 */
function marker(subject: string): string {
  const [first = ''] = subject.trim().split(/\s+/, 1);
  return LEVELS.has(first) ? first : '';
}

/**
 * A `BREAKING CHANGE:` (or `BREAKING-CHANGE:`) trailer in the body forces a
 * major whatever the subject says.
 *
 * Borrowed from Conventional Commits rather than invented: it is the escape
 * hatch for a commit that is breaking for a reason the emoji has no way to
 * express — a raised `engines.node` floor being the example these repos keep
 * hitting.
 */
const BREAKING = /^BREAKING[ -]CHANGE:/m;

export function classify(commit: Commit): Classification {
  if (BREAKING.test(commit.body)) {
    return { commit, level: 'major', marker: 'BREAKING CHANGE:' };
  }

  const found = marker(commit.subject);

  return {
    commit,
    level: found ? (LEVELS.get(found) as Level) : 'patch',
    marker: found,
  };
}

export interface Inference {
  level: Level;
  classifications: Classification[];
}

/**
 * The bump implied by `commits`: the highest level any one of them reaches.
 *
 * Warnings are emitted here rather than returned because they are advisory —
 * the release is not blocked by an unrecognized subject, but whoever approves it
 * should be able to see one in the log.
 */
export function infer(commits: Commit[]): Inference {
  const classifications = commits.map(classify);

  for (const { commit, level, marker: found } of classifications) {
    if (!found) {
      core.warning(
        `${commit.sha.slice(0, 7)} has no recognized gitmoji ("${commit.subject}") — counted as a patch`,
      );
    } else if (WORTH_A_LOOK.has(found)) {
      core.warning(
        `${commit.sha.slice(0, 7)} is ${found} ("${commit.subject}") — counted as a ${level}, but removing or renaming something public is breaking. Override the bump if it was.`,
      );
    }
  }

  const level = classifications.reduce<Level>(
    (highest, current) => (RANK[current.level] > RANK[highest] ? current.level : highest),
    'none',
  );

  return { level, classifications };
}
