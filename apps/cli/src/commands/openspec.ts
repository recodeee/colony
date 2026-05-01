import { resolve } from 'node:path';
import { loadSettings } from '@colony/config';
import { formatOpenSpecSyncStatus, openspecSyncStatus } from '@colony/spec';
import type { Command } from 'commander';
import kleur from 'kleur';
import { withStore } from '../util/store.js';

interface OpenSpecSyncOptions {
  repoRoot?: string;
  staleHours?: string;
  limit?: string;
  json?: boolean;
}

export function registerOpenSpecCommand(program: Command): void {
  const group = program.command('openspec').description('Inspect Colony and OpenSpec drift');

  group
    .command('sync')
    .description('Report drift between Colony task state and OpenSpec artifacts')
    .option('--repo-root <path>', 'Repo root (defaults to process.cwd())')
    .option('--stale-hours <hours>', 'Open checkbox stale threshold', '24')
    .option('--limit <n>', 'Maximum issues to print')
    .option('--json', 'Emit sync status as JSON')
    .action(async (opts: OpenSpecSyncOptions) => {
      const staleHours = parsePositiveNumber(opts.staleHours, '--stale-hours');
      const limit = parseOptionalPositiveInteger(opts.limit, '--limit');
      if (staleHours === null || limit === null) {
        process.exitCode = 1;
        return;
      }

      const settings = loadSettings();
      const repoRoot = resolve(opts.repoRoot ?? process.cwd());
      await withStore(
        settings,
        (store) => {
          const status = openspecSyncStatus({
            store,
            repoRoot,
            staleAfterMs: staleHours * 60 * 60_000,
            ...(limit !== undefined ? { limit } : {}),
          });

          if (opts.json === true) {
            process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
            return;
          }

          const output = formatOpenSpecSyncStatus(status);
          process.stdout.write(status.issue_count > 0 ? kleur.yellow(output) : kleur.green(output));
        },
        { readonly: true },
      );
    });
}

function parsePositiveNumber(value: string | undefined, flag: string): number | null {
  const parsed = Number(value ?? '');
  if (!Number.isFinite(parsed) || parsed <= 0) {
    process.stderr.write(`colony error: ${flag} must be a positive number\n`);
    return null;
  }
  return parsed;
}

function parseOptionalPositiveInteger(
  value: string | undefined,
  flag: string,
): number | null | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    process.stderr.write(`colony error: ${flag} must be a positive integer\n`);
    return null;
  }
  return parsed;
}
