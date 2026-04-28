import { loadSettings } from '@colony/config';
import {
  DEFAULT_STALLED_MINUTES,
  DEFAULT_UNCLAIMED_MINUTES,
  type QueenAttentionItem,
  sweepQueenPlans,
} from '@colony/queen';
import type { Command } from 'commander';
import kleur from 'kleur';
import { withStore } from '../util/store.js';

interface SweepOpts {
  repoRoot?: string;
  olderThanMinutes?: string;
  unclaimedOlderThanMinutes?: string;
  autoMessage?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export function registerQueenCommand(program: Command): void {
  const group = program
    .command('queen')
    .description('Queen coordination helpers for published plan lanes');

  group
    .command('sweep')
    .description('List queen plans needing attention: stalled, unclaimed, ready to archive')
    .option('--repo-root <path>', 'repo root to scan')
    .option(
      '--older-than-minutes <minutes>',
      `claimed sub-task stall threshold (default ${DEFAULT_STALLED_MINUTES})`,
    )
    .option(
      '--unclaimed-older-than-minutes <minutes>',
      `available sub-task threshold (default ${DEFAULT_UNCLAIMED_MINUTES})`,
    )
    .option('--auto-message', 'send needs_reply messages to stalled claim owners')
    .option('--dry-run', 'scan only; suppress auto-messages')
    .option('--json', 'emit sweep result as JSON')
    .action(async (opts: SweepOpts) => {
      const olderThan = parseMinutes(opts.olderThanMinutes, '--older-than-minutes');
      const unclaimedOlderThan = parseMinutes(
        opts.unclaimedOlderThanMinutes,
        '--unclaimed-older-than-minutes',
      );
      if (olderThan === null || unclaimedOlderThan === null) {
        process.exitCode = 1;
        return;
      }

      const settings = loadSettings();
      await withStore(settings, (store) => {
        const result = sweepQueenPlans(store, {
          auto_message: opts.autoMessage === true && opts.dryRun !== true,
          ...(opts.repoRoot !== undefined ? { repo_root: opts.repoRoot } : {}),
          ...(olderThan !== undefined ? { older_than_minutes: olderThan } : {}),
          ...(unclaimedOlderThan !== undefined
            ? { unclaimed_older_than_minutes: unclaimedOlderThan }
            : {}),
        });

        if (opts.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          return;
        }

        process.stdout.write(`${renderSweep(result, opts)}\n`);
      });
    });
}

function parseMinutes(raw: string | undefined, flag: string): number | undefined | null {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    process.stderr.write(`${kleur.red('invalid value')} for ${flag}: ${raw}\n`);
    return null;
  }
  return parsed;
}

function renderSweep(result: ReturnType<typeof sweepQueenPlans>, opts: SweepOpts): string {
  const items = result.flatMap((plan) => plan.items);
  const stalled = items.filter((item) => item.reason === 'stalled');
  const unclaimed = items.filter((item) => item.reason === 'unclaimed');
  const ready = items.filter((item) => item.reason === 'ready-to-archive');
  const sent = stalled.filter((item) => item.message_observation_id !== undefined).length;

  const lines: string[] = [];
  if (items.length === 0) {
    lines.push(kleur.green('Queen sweep: no plans need attention'));
    return lines.join('\n');
  }

  lines.push(
    kleur.bold(
      `Queen sweep: ${result.length} plan(s) need attention  stalled: ${stalled.length}  unclaimed: ${unclaimed.length}  ready-to-archive: ${ready.length}`,
    ),
  );
  if (opts.autoMessage === true) {
    lines.push(
      opts.dryRun === true
        ? kleur.yellow('  dry-run: auto-message requested, no messages sent')
        : `  messages sent: ${sent}`,
    );
  }

  lines.push('');
  lines.push(kleur.cyan('Examples:'));
  for (const item of items.slice(0, 5)) {
    lines.push(`  ${renderExample(item)}`);
  }
  if (items.length > 5) {
    lines.push(`  ... ${items.length - 5} more item(s); use --json for full detail`);
  }

  return lines.join('\n');
}

function renderExample(item: QueenAttentionItem): string {
  if (item.reason === 'stalled') {
    return `${item.plan_slug}/sub-${item.subtask_index} stalled: claimed by ${item.claimed_by_agent ?? item.claimed_by_session_id} for ${item.age_minutes}m`;
  }
  if (item.reason === 'unclaimed') {
    return `${item.plan_slug}/sub-${item.subtask_index} unclaimed: available for ${item.age_minutes}m`;
  }
  return `${item.plan_slug} ready-to-archive: ${item.completed_subtask_count} completed sub-task(s), auto_archive off`;
}
