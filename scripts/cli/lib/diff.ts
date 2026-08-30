/**
 * Comparing desired state against live state, and printing the result.
 *
 * The output is the product here. A settings tool that applies silently is one
 * you have to verify in the web UI afterwards, which is the manual work this is
 * replacing — so every provider reduces to a list of `key: current → desired`
 * lines, and `--apply` runs exactly that list and nothing else.
 */

const COLOR =
  process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

function paint(code: string, text: string): string {
  return COLOR ? `\u001B[${code}m${text}\u001B[0m` : text;
}

export const style = {
  bold: (text: string) => paint('1', text),
  dim: (text: string) => paint('2', text),
  red: (text: string) => paint('31', text),
  green: (text: string) => paint('32', text),
  yellow: (text: string) => paint('33', text),
  blue: (text: string) => paint('34', text),
  cyan: (text: string) => paint('36', text),
};

/**
 * Printable width of a string that may carry colour codes.
 *
 * Column alignment has to count what lands on screen; the escape sequences are
 * zero-width and would otherwise push every coloured cell out of line.
 */
export function visibleLength(text: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape is the point
  return text.replace(/\u001B\[[0-9;]*m/g, '').length;
}

/** Right-pad to `width` printable characters. */
export function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleLength(text)));
}

export type ChangeKind = 'create' | 'update' | 'delete';

export interface Change {
  /** What is changing, as a human reads it: `allow_merge_commit`, `label bug`. */
  key: string;
  from: unknown;
  to: unknown;
  kind: ChangeKind;
}

/**
 * Structural equality, with the normalisations the GitHub API forces on us.
 *
 * `homepage` comes back as `null` on one repo and `""` on the next for the same
 * "unset" state, and a label with no description is sometimes `null` and
 * sometimes absent. Treating those as different produces a diff that never
 * converges — the tool would report a change, apply it, and report it again.
 */
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || a === undefined || a === '') {
    return b === null || b === undefined || b === '';
  }
  if (b === null || b === undefined || b === '') {
    return false;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => equal(item, b[index]));
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].every((key) => equal(left[key], right[key]));
  }

  return false;
}

/** One `update` change per key whose live value differs from the desired one. */
export function diffKeys(
  desired: Record<string, unknown>,
  current: Record<string, unknown>,
): Change[] {
  return Object.entries(desired)
    .filter(([key, value]) => !equal(value, current[key]))
    .map(([key, value]) => ({ key, from: current[key], to: value, kind: 'update' as const }));
}

/**
 * Leaf-level differences between two nested objects, as dotted paths.
 *
 * A ruleset compared whole prints as two walls of JSON with the operator left to
 * spot the one field that moved. Walking to the leaves turns that into
 * `pr-required.bypass_actors: (empty) → …`, which is the sentence you actually
 * wanted. Arrays are leaves: reordering one is not a change worth describing
 * element by element.
 */
export function diffPaths(desired: unknown, current: unknown, prefix: string): Change[] {
  if (equal(desired, current)) {
    return [];
  }

  const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  if (isPlainObject(desired) && isPlainObject(current)) {
    const keys = new Set([...Object.keys(desired), ...Object.keys(current)]);
    return [...keys].flatMap((key) =>
      diffPaths(desired[key], current[key], prefix ? `${prefix}.${key}` : key),
    );
  }

  return [{ key: prefix, from: current, to: desired, kind: 'update' }];
}

export function formatValue(value: unknown): string {
  if (value === undefined) {
    return style.dim('(absent)');
  }
  if (value === null || value === '') {
    return style.dim('(unset)');
  }
  if (Array.isArray(value)) {
    // `join` would render an array of objects as `[object Object]`, which is the
    // least useful thing a diff can say about the field that actually changed.
    return value.length === 0
      ? style.dim('(empty)')
      : value
          .map((item) => (typeof item === 'object' && item !== null ? JSON.stringify(item) : String(item)))
          .join(', ');
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

const MARKS: Record<ChangeKind, string> = {
  create: '+',
  update: '~',
  delete: '-',
};

export function renderChange(change: Change): string {
  const mark = MARKS[change.kind];
  const colored =
    change.kind === 'create'
      ? style.green(mark)
      : change.kind === 'delete'
        ? style.red(mark)
        : style.yellow(mark);

  if (change.kind === 'create') {
    return `    ${colored} ${change.key} = ${formatValue(change.to)}`;
  }
  if (change.kind === 'delete') {
    return `    ${colored} ${change.key} ${style.dim(`(was ${formatValue(change.from)})`)}`;
  }

  return `    ${colored} ${change.key}: ${style.red(formatValue(change.from))} ${style.dim('→')} ${style.green(formatValue(change.to))}`;
}
