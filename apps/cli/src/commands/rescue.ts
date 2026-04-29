import { loadSettings } from '@colony/config';
import { type BulkStrandedRescueOutcome, bulkRescueStrandedSessions } from '@colony/core';
import { type Command, InvalidArgumentError } from 'commander';
import kleur from 'kleur';
import { withStore } from '../util/store.js';

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  min: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 60 * 60_000,
  hr: 60 * 60_000,
  hour: 60 * 60_000,
  hours: 60 * 60_000,
  d: 24 * 60 * 60_000,
  day: 24 * 60 * 60_000,
  days: 24 * 60 * 60_000,
  w: 7 * 24 * 60 * 60_000,
  week: 7 * 24 * 60 * 60_000,
  weeks: 7 * 24 * 60 * 60_000,
};

interface StrandedRescueOpts {
  olderThan: number;
  dryRun?: boolean;
  apply?: boolean;
  json?: boolean;
}

export function registerRescueCommand(program: Command): void {
  const group = program.command('rescue').description('Clean up stranded sessions safely');

  group
    .command('stranded')
    .description('Release old stranded-session claims and mark sessions rescued')
    .requiredOption(
      '--older-than <duration>',
      'minimum idle duration to rescue, for example 2h, 90m, or 3d',
      parseDuration,
    )
    .option('--dry-run', 'scan only; this is the default unless --apply is set')
    .option('--apply', 'release stranded claims, mark sessions rescued, and write audit notes')
    .option('--json', 'emit rescue result as JSON')
    .action(async (opts: StrandedRescueOpts) => {
      if (opts.apply && opts.dryRun) {
        throw new InvalidArgumentError('choose either --dry-run or --apply, not both');
      }
      const dryRun = opts.apply !== true;
      const settings = loadSettings();
      await withStore(settings, (store) => {
        const outcome = bulkRescueStrandedSessions(store, {
          stranded_after_ms: opts.olderThan,
          dry_run: dryRun,
        });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
          return;
        }
        process.stdout.write(`${renderStrandedRescue(outcome)}\n`);
      });
    });
}

function parseDuration(input: string): number {
  const match = input
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*([a-z]+)?$/);
  if (!match) throw new InvalidArgumentError('duration must look like 90m, 2h, or 3d');
  const amount = Number(match[1]);
  const unit = match[2] ?? 'm';
  const multiplier = DURATION_UNITS[unit];
  if (!Number.isFinite(amount) || amount <= 0 || multiplier === undefined) {
    throw new InvalidArgumentError('duration must use ms, s, m, h, d, or w');
  }
  return Math.floor(amount * multiplier);
}

function renderStrandedRescue(outcome: BulkStrandedRescueOutcome): string {
  const lines: string[] = [];
  const mode = outcome.dry_run ? 'dry-run, read-only' : 'apply';
  const actionCount = outcome.dry_run ? outcome.stranded.length : outcome.rescued.length;
  if (actionCount === 0) {
    lines.push(kleur.green('Stranded rescue: no stranded sessions with held claims'));
  } else {
    lines.push(kleur.bold(`Stranded rescue: ${actionCount} stranded session(s)`));
  }
  lines.push(`  mode: ${mode}`);
  lines.push(`  scanned: ${outcome.scanned}`);
  lines.push(`  released claims: ${outcome.released_claim_count}`);
  lines.push('  audit: observations retained; apply writes rescue-stranded audit notes');

  const rows = outcome.dry_run ? outcome.stranded : outcome.rescued;
  for (const row of rows.slice(0, 20)) {
    const audit = row.audit_observation_id ? ` audit #${row.audit_observation_id}` : '';
    lines.push(
      `  ${row.session_id} agent=${row.agent} repo=${row.repo_root} branch=${row.branch} last_activity=${new Date(row.last_activity).toISOString()} held_claims=${row.held_claim_count} -> ${row.suggested_action}${audit}`,
    );
  }
  if (rows.length > 20) lines.push(`  ... ${rows.length - 20} more; use --json for full detail`);
  if (outcome.skipped.length > 0) {
    lines.push('');
    lines.push(kleur.yellow('Skipped:'));
    for (const skipped of outcome.skipped.slice(0, 10)) {
      lines.push(`  ${skipped.session_id || '<missing>'}: ${skipped.reason}`);
    }
  }
  return lines.join('\n');
}
