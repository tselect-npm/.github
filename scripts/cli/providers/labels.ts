/**
 * Issue and PR labels.
 *
 * Creates and updates by default; extra labels are reported but kept unless
 * `config/labels.json` sets `prune: true`. Deleting a label removes it from
 * every issue that carries it, and that is not a reasonable side effect of
 * "make the repos consistent".
 */
import type { LabelConfig } from '../lib/config.ts';
import { equal, type Change } from '../lib/diff.ts';
import type { Context, Provider, ProviderPlan } from './types.ts';

interface LiveLabel {
  name: string;
  color: string;
  description: string | null;
}

/** Label names are matched case-insensitively, the way GitHub matches them. */
function key(name: string): string {
  return name.toLowerCase();
}

export const labelsProvider: Provider = {
  name: 'labels',
  describe: 'the shared issue/PR label set, including Dependabot’s `dependencies`',

  async plan(context: Context): Promise<ProviderPlan> {
    const { octokit, owner, repo, labels } = context;

    const live: LiveLabel[] = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, {
      owner,
      repo: repo.name,
      per_page: 100,
    });
    const byName = new Map(live.map((label) => [key(label.name), label]));

    const changes: Change[] = [];
    const creates: LabelConfig[] = [];
    const updates: LabelConfig[] = [];

    for (const desired of labels.labels) {
      const current = byName.get(key(desired.name));

      if (!current) {
        creates.push(desired);
        changes.push({ key: `label ${desired.name}`, from: undefined, to: desired.color, kind: 'create' });
        continue;
      }

      const colorDiffers = current.color.toLowerCase() !== desired.color.toLowerCase();

      // A `null` description means "no opinion", not "must be blank". The
      // reference repo carries GitHub's older default labels, which have no
      // descriptions at all, while the repos created later have them — enforcing
      // null would delete real text everywhere to match an absence. Set a string
      // in config/labels.json to manage a description.
      const descriptionDiffers =
        desired.description !== null && !equal(current.description, desired.description);

      if (colorDiffers || descriptionDiffers) {
        updates.push(desired);
        changes.push({
          key: `label ${desired.name}`,
          from: `#${current.color}${current.description ? ` — ${current.description}` : ''}`,
          to: `#${desired.color}${desired.description ? ` — ${desired.description}` : ''}`,
          kind: 'update',
        });
      }
    }

    const declared = new Set(labels.labels.map((label) => key(label.name)));
    const extra = live.filter((label) => !declared.has(key(label.name)));

    const warnings: string[] = [];
    const deletes: LiveLabel[] = [];

    if (extra.length > 0) {
      if (labels.prune) {
        for (const label of extra) {
          deletes.push(label);
          changes.push({ key: `label ${label.name}`, from: label.color, to: undefined, kind: 'delete' });
        }
      } else {
        warnings.push(
          `not declared in config/labels.json, left in place: ${extra.map((l) => l.name).join(', ')}`,
        );
      }
    }

    return {
      changes,
      warnings,
      async apply() {
        // `description` is omitted rather than sent as '' when unmanaged: the
        // API treats an empty string as "clear it", which is the very thing the
        // null-means-no-opinion rule above exists to avoid.
        for (const label of creates) {
          await octokit.rest.issues.createLabel({
            owner,
            repo: repo.name,
            name: label.name,
            color: label.color,
            ...(label.description !== null ? { description: label.description } : {}),
          });
        }
        for (const label of updates) {
          await octokit.rest.issues.updateLabel({
            owner,
            repo: repo.name,
            name: label.name,
            color: label.color,
            ...(label.description !== null ? { description: label.description } : {}),
          });
        }
        for (const label of deletes) {
          await octokit.rest.issues.deleteLabel({ owner, repo: repo.name, name: label.name });
        }
      },
    };
  },
};
