import { resolve } from 'node:path';
import { loadSettings } from '@colony/config';
import { type CoordinationSweepResult, buildCoordinationSweep } from '@colony/core';
import type { Command } from 'commander';
import kleur from 'kleur';
import { withStore } from '../util/store.js';

interface SweepOpts {
  repoRoot?: string;
  dryRun?: boolean;
  json?: boolean;
}

export function registerCoordinationCommand(program: Command): void {
  const group = program
    .command('coordination')
    .description('Inspect biological coordination signals');

  group
    .command('sweep')
    .description('Report stale claims, expired messages, decayed proposals, and stale trails')
    .option('--repo-root <path>', 'repo root to scan (defaults to process.cwd())')
    .option('--dry-run', 'scan only; no cleanup is performed')
    .option('--json', 'emit sweep result as JSON')
    .action(async (opts: SweepOpts) => {
      const repoRoot = resolve(opts.repoRoot ?? process.cwd());
      const settings = loadSettings();
      await withStore(settings, (store) => {
        const result = buildCoordinationSweep(store, { repo_root: repoRoot });
        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify({ ...result, dry_run: opts.dryRun === true }, null, 2)}\n`,
          );
          return;
        }
        process.stdout.write(`${renderCoordinationSweep(result, opts)}\n`);
      });
    });
}

function renderCoordinationSweep(result: CoordinationSweepResult, opts: SweepOpts): string {
  const total = Object.values(result.summary).reduce((sum, count) => sum + count, 0);
  const lines: string[] = [];
  if (total === 0) {
    lines.push(kleur.green('Coordination sweep: no stale biological signals'));
    lines.push(kleur.dim('read-only: no audit history deleted'));
    return lines.join('\n');
  }

  lines.push(kleur.bold(`Coordination sweep: ${total} stale biological signal(s)`));
  lines.push(`  repo: ${result.repo_root ?? 'all'}`);
  lines.push(`  mode: ${opts.dryRun === true ? 'dry-run, read-only' : 'read-only'}`);
  lines.push(
    `  stale claims: ${result.summary.stale_claim_count}  expired handoffs: ${result.summary.expired_handoff_count}  expired messages: ${result.summary.expired_message_count}`,
  );
  lines.push(
    `  decayed proposals: ${result.summary.decayed_proposal_count}  stale hot files: ${result.summary.stale_hot_file_count}  blocked downstream: ${result.summary.blocked_downstream_task_count}`,
  );

  renderSection(
    lines,
    'Stale claims',
    result.stale_claims,
    (claim) =>
      `task #${claim.task_id} ${claim.branch} ${claim.file_path} held by ${claim.session_id} for ${claim.age_minutes}m -> confirm, release, or hand off`,
  );
  renderSection(
    lines,
    'Expired handoffs',
    result.expired_handoffs,
    (handoff) =>
      `#${handoff.observation_id} ${handoff.from_agent}->${handoff.to_session_id ?? handoff.to_agent} expired ${handoff.expired_minutes}m ago -> send a fresh handoff if still needed`,
  );
  renderSection(
    lines,
    'Expired messages',
    result.expired_messages,
    (message) =>
      `#${message.observation_id} ${message.from_agent}->${message.to_session_id ?? message.to_agent} ${message.urgency} expired ${message.expired_minutes}m ago -> resend or ignore`,
  );
  renderSection(
    lines,
    'Decayed proposals',
    result.decayed_proposals,
    (proposal) =>
      `#${proposal.proposal_id} strength ${proposal.strength} < ${proposal.noise_floor} ${proposal.summary} -> reinforce or let fade`,
  );
  renderSection(
    lines,
    'Stale hot files',
    result.stale_hot_files,
    (file) =>
      `task #${file.task_id} ${file.file_path} current ${file.current_strength} from ${file.original_strength} -> ignore unless activity restarts`,
  );
  renderSection(
    lines,
    'Blocked downstream tasks',
    result.blocked_downstream_tasks,
    (task) =>
      `${task.plan_slug}/sub-${task.subtask_index} waits on ${task.blocked_by.map((b) => `sub-${b.subtask_index} [${b.status}]`).join(', ')} -> finish blocker or replan`,
  );

  return lines.join('\n');
}

function renderSection<T>(
  lines: string[],
  title: string,
  items: T[],
  render: (item: T) => string,
): void {
  if (items.length === 0) return;
  lines.push('');
  lines.push(kleur.cyan(`${title}:`));
  for (const item of items.slice(0, 5)) {
    lines.push(`  ${render(item)}`);
  }
  if (items.length > 5) lines.push(`  ... ${items.length - 5} more; use --json for full detail`);
}
