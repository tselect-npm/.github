#!/usr/bin/env -S npx tsx
/**
 * `tselect` — keep the seven package repositories configured the same way.
 *
 * `tselect-npm/url` is the reference: it is configured by hand in the web UI,
 * `pull` snapshots it into `config/`, and `sync` carries that to the others. The
 * alternative it replaces is the procedure this repository's README used to
 * describe — importing four ruleset files through the UI once per repo, twenty
 * eight times, with nothing keeping the copies in step afterwards.
 *
 * Dry run unless `--apply`. Every provider prints its plan before it can act.
 */
import { parseArgs } from 'node:util';
import { check } from './commands/check.ts';
import { pull } from './commands/pull.ts';
import { status } from './commands/status.ts';
import { sync } from './commands/sync.ts';
import { style } from './lib/diff.ts';
import { PROVIDERS } from './providers/index.ts';

const USAGE = `${style.bold('tselect')} — sync GitHub configuration across the @tselect repos

${style.bold('USAGE')}
  tselect check
  tselect status [repo...]
  tselect pull   [--from <repo>] [--rulesets] [--repos]
  tselect sync   [repo...] [--only <a,b>] [--skip <a,b>] [--apply]

${style.bold('COMMANDS')}
  check    Validate config/, rulesets/ and templates/ offline. Run by CI.
  status   One row per repo: default branch, rulesets, labels, CodeQL, local state.
  pull     Snapshot the reference repo's live settings into config/.
  sync     Compare every repo against config/ and, with --apply, fix the difference.

${style.bold('PROVIDERS')} ${style.dim('(sync --only / --skip)')}
${PROVIDERS.map((provider) => `  ${style.cyan(provider.name.padEnd(9))}${provider.describe}`).join('\n')}

${style.bold('OPTIONS')}
  --apply        Perform the planned changes. Without it, nothing is written.
  --only  a,b    Run just these providers.
  --skip  a,b    Run everything except these providers.
  --from  repo   Reference repo for \`pull\` (default: the one in config/repos.json).
  --rulesets     \`pull\` also overwrites rulesets/*.json from the reference repo.
  --repos        \`pull\` also reseeds descriptions and topics in config/repos.json.

${style.bold('AUTH')}
  A token from \`gh auth token\`, or GITHUB_TOKEN. Needs \`repo\` scope.
  The \`files\` provider writes to the local clones instead of the Contents API,
  so no \`workflow\` scope is required.
`;

/** `--only a,b --only c` and `--only a --only b` both mean {a, b}. */
function list(values: string[] | undefined): string[] {
  return (values ?? []).flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      apply: { type: 'boolean', default: false },
      only: { type: 'string', multiple: true },
      skip: { type: 'string', multiple: true },
      from: { type: 'string' },
      rulesets: { type: 'boolean', default: false },
      repos: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const [command, ...rest] = positionals;

  if (values.help || !command || command === 'help') {
    console.log(USAGE);
    return command || values.help ? 0 : 1;
  }

  switch (command) {
    case 'check':
      return check();

    case 'status':
      return status(rest);

    case 'pull':
      return pull({
        from: values.from,
        rulesets: values.rulesets === true,
        repos: values.repos === true,
      });

    case 'sync':
      return sync({
        repos: rest,
        only: list(values.only),
        skip: list(values.skip),
        apply: values.apply === true,
      });

    default:
      console.error(`${style.red('unknown command')} "${command}"\n`);
      console.log(USAGE);
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // A stack trace helps nobody here: every realistic failure is a bad token, a
    // typo'd repo name, or a 403 the message already explains.
    console.error(`${style.red('error')}: ${(error as Error).message}`);
    process.exitCode = 1;
  });
