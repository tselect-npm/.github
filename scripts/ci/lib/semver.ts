/**
 * The slice of semver the release scripts need, hand-rolled.
 *
 * Same reason as `lib/core.ts`: `pnpm dlx tsx <script>` then has exactly one
 * package to fetch, and depending on `semver` would mean a `node_modules`
 * install before the plan job could read a version number. Range matching and
 * ordering are most of what makes the real package worth having, and neither is
 * used here — this parses a version and increments it.
 */

/** The three release kinds, in the order the gitmoji table ranks them. */
export type Bump = 'major' | 'minor' | 'patch';

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** The `beta.2` in `3.0.0-beta.2`, without the leading dash. Empty if none. */
  prerelease: string;
}

// Build metadata is matched so it can be rejected rather than silently kept:
// `1.0.0+build` and `1.0.0` are the same version to a registry, and a release
// that thinks otherwise would publish under a name nothing resolves.
const PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/** Parse a version string, or return null if it is not plain semver. */
export function parseVersion(value: string): Version | null {
  const match = PATTERN.exec(value.trim());

  if (!match || match[5] !== undefined) {
    return null; // Unparseable, or carries build metadata.
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? '',
  };
}

export function formatVersion(version: Version): string {
  const release = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease ? `${release}-${version.prerelease}` : release;
}

/**
 * Increment `version` by `bump`, dropping any prerelease.
 *
 * The prerelease rule is the one npm's `semver.inc` uses and it is easy to get
 * wrong: `1.0.0-beta.2` is a version *on the way to* `1.0.0`, so releasing it
 * lands on `1.0.0` rather than `1.0.1` — the prerelease is discarded, not
 * incremented past. That only applies when the parts below the bump are already
 * zero; `1.2.0-beta.1` patched is `1.2.0`, but `1.2.3-beta.1` patched is
 * `1.2.4`.
 *
 * None of the seven packages carries a prerelease version today. This handles it
 * anyway, because the alternative is a script that is subtly wrong on the one
 * occasion it matters.
 */
export function increment(version: Version, bump: Bump): Version {
  const { major, minor, patch, prerelease } = version;

  if (bump === 'major') {
    return prerelease && minor === 0 && patch === 0
      ? { major, minor: 0, patch: 0, prerelease: '' }
      : { major: major + 1, minor: 0, patch: 0, prerelease: '' };
  }

  if (bump === 'minor') {
    return prerelease && patch === 0
      ? { major, minor, patch: 0, prerelease: '' }
      : { major, minor: minor + 1, patch: 0, prerelease: '' };
  }

  return prerelease
    ? { major, minor, patch, prerelease: '' }
    : { major, minor, patch: patch + 1, prerelease: '' };
}
