/**
 * Walking the build output.
 *
 * Hand-rolled rather than using `readdirSync(dir, { recursive: true })` so the
 * scripts do not depend on a Node API whose shape moved across the versions in
 * the matrix — `Dirent.parentPath` in particular. CI is the wrong place to find
 * out that a helper behaves differently on one line of the matrix.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Every file under `dir`, recursively, as paths relative to `dir`. */
export function walk(dir: string, prefix = ''): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const relative = join(prefix, entry.name);

    if (entry.isDirectory()) {
      found.push(...walk(dir, relative));
    } else if (entry.isFile()) {
      found.push(relative);
    }
  }

  return found;
}

/**
 * Files under `dir` with one of `extensions` that are not zero bytes.
 *
 * The size test is the point: a build tool that emits an empty `index.d.ts` has
 * failed in exactly the way that still passes a "does the file exist?" check.
 */
export function nonEmptyFiles(dir: string, extensions: string[]): string[] {
  return walk(dir).filter(
    (file) =>
      extensions.some((extension) => file.endsWith(extension)) &&
      statSync(join(dir, file)).size > 0,
  );
}

/** Whether `dir` contains at least one file with `extension`. */
export function hasFiles(dir: string, extension: string): boolean {
  return walk(dir).some((file) => file.endsWith(extension));
}
