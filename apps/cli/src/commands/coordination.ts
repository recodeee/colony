import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadSettings } from '@colony/config';
import { type CoordinationSweepResult, buildCoordinationSweep } from '@colony/core';
import type { Command } from 'commander';
import kleur from 'kleur';
import { withStore } from '../util/store.js';

interface SweepOpts {
  repoRoot?: string;
  dryRun?: boolean;
  releaseStaleBlockers?: boolean;
  releaseSameBranchDuplicates?: boolean;
  releaseSafeStaleClaims?: boolean;
  releaseExpiredQuota?: boolean;
  releaseAgedQuotaMinutes?: string;
  archiveCompletedPlans?: boolean;
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
    .option('--dry-run', 'scan only; this is the default until cleanup has an explicit apply path')
    .option(
      '--release-stale-blockers',
      'release stale downstream blocker claims and requeue blocker subtasks; audit history retained',
    )
    .option(
      '--release-same-branch-duplicates',
      'release same-branch duplicate claims to audit-only; audit history retained',
    )
    .option(
      '--release-safe-stale-claims',
      'release expired safe stale claims and downgrade inactive stale claims to audit-only; audit history retained',
    )
    .option(
      '--release-expired-quota',
      'downgrade quota-pending claims past their TTL to weak_expired and mark linked relays expired; audit history retained',
    )
    .option(
      '--release-aged-quota-minutes <minutes>',
      'release every quota-pending claim aged at-or-above this many minutes regardless of TTL; audit history retained',
    )
    .option(
      '--archive-completed-plans',
      'archive queen plans whose every sub-task completed; ignores per-plan auto_archive opt-in',
    )
    .option('--json', 'emit sweep result as JSON')
    .action(async (opts: SweepOpts) => {
      const repoRoot = resolve(opts.repoRoot ?? process.cwd());
      const repoRoots = repoRootAliases(repoRoot);
      const releaseStaleBlockers = opts.releaseStaleBlockers === true && opts.dryRun !== true;
      const releaseSameBranchDuplicates =
        opts.releaseSameBranchDuplicates === true && opts.dryRun !== true;
      const releaseSafeStaleClaims = opts.releaseSafeStaleClaims === true && opts.dryRun !== true;
      const releaseExpiredQuotaClaims = opts.releaseExpiredQuota === true && opts.dryRun !== true;
      const releaseAgedQuotaMinutes = parseAgedQuotaMinutes(opts.releaseAgedQuotaMinutes);
      if (releaseAgedQuotaMinutes === 'invalid') {
        process.stderr.write(
          `${kleur.red('error')} --release-aged-quota-minutes expects a non-negative number\n`,
        );
        process.exitCode = 1;
        return;
      }
      const releaseAgedQuotaPendingMinutes =
        releaseAgedQuotaMinutes !== null && opts.dryRun !== true ? releaseAgedQuotaMinutes : null;
      const archiveCompletedPlans = opts.archiveCompletedPlans === true && opts.dryRun !== true;
      const settings = loadSettings();
      await withStore(settings, (store) => {
        const result = buildCoordinationSweep(store, {
          repo_root: repoRoot,
          repo_roots: repoRoots,
          release_stale_blockers: releaseStaleBlockers,
          release_same_branch_duplicates: releaseSameBranchDuplicates,
          release_safe_stale_claims: releaseSafeStaleClaims,
          release_expired_quota_claims: releaseExpiredQuotaClaims,
          archive_completed_plans: archiveCompletedPlans,
          ...(releaseAgedQuotaPendingMinutes !== null
            ? { release_aged_quota_pending_minutes: releaseAgedQuotaPendingMinutes }
            : {}),
        });
        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify({ ...result, dry_run: opts.dryRun === true }, null, 2)}\n`,
          );
          return;
        }
        process.stdout.write(
          `${renderCoordinationSweep(result, {
            appliedModes: appliedSweepModes({
              releaseStaleBlockers,
              releaseSameBranchDuplicates,
              releaseSafeStaleClaims,
              releaseExpiredQuotaClaims,
              releaseAgedQuotaPendingMinutes,
              archiveCompletedPlans,
            }),
          })}\n`,
        );
      });
    });
}

function repoRootAliases(repoRoot: string): string[] {
  const roots = new Set([repoRoot]);
  try {
    roots.add(realpathSync(repoRoot));
  } catch {
    // Non-existent --repo-root values are still passed through as literal filters.
  }
  const remoteSlug = gitOriginSlug(repoRoot);
  if (remoteSlug) roots.add(resolve(dirname(repoRoot), remoteSlug));
  return [...roots];
}

function gitOriginSlug(repoRoot: string): string | null {
  try {
    const remote = execFileSync('git', ['-C', repoRoot, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const name = remote
      .split(/[/:]/)
      .pop()
      ?.replace(/\.git$/, '')
      .trim();
    return name && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

function renderCoordinationSweep(
  result: CoordinationSweepResult,
  opts: { appliedModes: string[] },
): string {
  const total = staleSignalCount(result);
  const lines: string[] = [];
  if (total === 0) {
    lines.push(kleur.green('Coordination sweep: no stale biological signals'));
    lines.push(kleur.dim('audit history retained'));
  } else {
    lines.push(kleur.bold(`Coordination sweep: ${total} stale biological signal(s)`));
  }
  lines.push(`  repo: ${result.repo_root ?? 'all'}`);
  lines.push(`  mode: ${renderSweepMode(opts.appliedModes)}`);
  lines.push('  audit: observations retained; advisory claims only');
  lines.push(`  recommended action: ${result.recommended_action}`);
  lines.push(
    `  active claims: ${result.summary.active_claim_count}  stale claims: ${result.summary.stale_claim_count}  expired/weak claims: ${result.summary.expired_weak_claim_count}`,
  );
  lines.push(
    `  expired handoffs: ${result.summary.expired_handoff_count}  expired messages: ${result.summary.expired_message_count}`,
  );
  lines.push(
    `  decayed proposals: ${result.summary.decayed_proposal_count}  stale hot files: ${result.summary.stale_hot_file_count}  blocked downstream: ${result.summary.blocked_downstream_task_count}`,
  );
  lines.push(
    `  same-branch duplicates: ${result.summary.same_branch_duplicate_claim_count}  released same-branch duplicates: ${result.summary.released_same_branch_duplicate_claim_count}`,
  );
  lines.push(
    `  stale downstream blockers: ${result.summary.stale_downstream_blocker_count}  released stale blocker claims: ${result.summary.released_stale_blocker_claim_count}  requeued blockers: ${result.summary.requeued_stale_blocker_count}`,
  );
  lines.push(
    `  released stale claims: ${result.summary.released_stale_claim_count}  downgraded stale claims: ${result.summary.downgraded_stale_claim_count}  skipped dirty claims: ${result.summary.skipped_dirty_claim_count}`,
  );
  lines.push(
    `  quota-pending claims: ${result.summary.quota_pending_claims}  released expired quota-pending: ${result.summary.released_expired_quota_pending_claim_count}`,
  );
  if (result.released_quota_pending_summary.released_count > 0) {
    lines.push(`  ${renderReleasedQuotaPendingSummary(result)}`);
  }

  renderSection(
    lines,
    'Active claims',
    result.active_claims,
    (claim) =>
      `task #${claim.task_id} ${claim.branch} ${claim.file_path} held by ${claim.session_id} for ${claim.age_minutes}m -> keep active`,
  );
  renderSection(
    lines,
    'Stale claims',
    result.stale_claims,
    (claim) =>
      `task #${claim.task_id} ${claim.branch} ${claim.file_path} held by ${claim.session_id} for ${claim.age_minutes}m, pheromone ${claim.current_strength} -> ${claim.cleanup_summary}`,
  );
  renderSection(
    lines,
    'Expired/weak claims',
    result.expired_weak_claims,
    (claim) =>
      `task #${claim.task_id} ${claim.branch} ${claim.file_path} held by ${claim.session_id} for ${claim.age_minutes}m (${claim.weak_reason ?? 'weak'}) -> ${claim.cleanup_summary}`,
  );
  renderSection(
    lines,
    'Top branches with stale claims',
    result.top_stale_branches,
    (branch) =>
      `${branch.branch} stale=${branch.stale_claim_count} expired/weak=${branch.expired_weak_claim_count} oldest=${branch.oldest_claim_age_minutes}m -> ${branch.suggested_cleanup_action}`,
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
  renderSection(
    lines,
    'Same-branch duplicate claims',
    result.same_branch_duplicate_claims,
    (claim) =>
      `task #${claim.task_id} ${claim.branch} ${claim.file_path} held by ${claim.session_id}, duplicate owner(s) ${claim.duplicate_session_ids.join(', ')} -> ${claim.cleanup_summary}`,
  );
  renderSection(
    lines,
    'Stale downstream blockers',
    result.stale_downstream_blockers,
    (blocker) =>
      `${blocker.plan_slug}/sub-${blocker.subtask_index} task #${blocker.task_id} ${blocker.file_path} held by ${blocker.owner_session_id} for ${blocker.age_minutes}m -> unlock candidate sub-${blocker.unlock_candidate.subtask_index}`,
  );
  renderSection(
    lines,
    'Released stale downstream blockers',
    result.released_stale_downstream_blockers,
    (blocker) =>
      `${blocker.plan_slug}/sub-${blocker.subtask_index} task #${blocker.task_id} released ${blocker.released_claim_count} claim(s), audit #${blocker.audit_observation_id}, requeue #${blocker.requeue_observation_id}`,
  );
  renderSection(
    lines,
    'Released same-branch duplicate claims',
    result.released_same_branch_duplicate_claims,
    (claim) =>
      `task #${claim.task_id} ${claim.branch} ${claim.file_path} held by ${claim.session_id} -> audit-only, audit #${claim.audit_observation_id}`,
  );
  renderSection(
    lines,
    'Released expired quota-pending claims',
    result.released_expired_quota_pending_claims,
    (claim) =>
      `task #${claim.task_id} ${claim.branch} ${claim.file_path} previously held by ${claim.session_id} (TTL ${claim.expires_at}, age ${claim.age_minutes}m) -> weak_expired, audit #${claim.audit_observation_id}`,
  );
  renderSection(
    lines,
    'Released stale claims',
    result.released_stale_claims,
    (claim) =>
      `task #${claim.task_id} ${claim.file_path} held by ${claim.session_id} -> released, audit #${claim.audit_observation_id}`,
  );
  renderSection(
    lines,
    'Downgraded stale claims',
    result.downgraded_stale_claims,
    (claim) =>
      `task #${claim.task_id} ${claim.file_path} held by ${claim.session_id} -> audit-only, audit #${claim.audit_observation_id}`,
  );
  renderSection(
    lines,
    'Skipped dirty claims',
    result.skipped_dirty_claims,
    (claim) =>
      `task #${claim.task_id} ${claim.branch} ${claim.file_path} held by ${claim.session_id} (${claim.reason}) -> ${claim.recommended_action}`,
  );

  return lines.join('\n');
}

function appliedSweepModes(opts: {
  releaseStaleBlockers: boolean;
  releaseSameBranchDuplicates: boolean;
  releaseSafeStaleClaims: boolean;
  releaseExpiredQuotaClaims: boolean;
  releaseAgedQuotaPendingMinutes: number | null;
  archiveCompletedPlans: boolean;
}): string[] {
  const modes: string[] = [];
  if (opts.releaseStaleBlockers) modes.push('release-stale-blockers');
  if (opts.releaseSameBranchDuplicates) modes.push('release-same-branch-duplicates');
  if (opts.releaseSafeStaleClaims) modes.push('release-safe-stale-claims');
  if (opts.releaseExpiredQuotaClaims) modes.push('release-expired-quota');
  if (opts.releaseAgedQuotaPendingMinutes !== null) {
    modes.push(`release-aged-quota>=${opts.releaseAgedQuotaPendingMinutes}m`);
  }
  if (opts.archiveCompletedPlans) modes.push('archive-completed-plans');
  return modes;
}

function parseAgedQuotaMinutes(value: string | undefined): number | null | 'invalid' {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return 'invalid';
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return 'invalid';
  return parsed;
}

function renderSweepMode(appliedModes: string[]): string {
  if (appliedModes.length === 0) return 'dry-run, read-only';
  return `${appliedModes.join(', ')}, audit-retaining`;
}

function renderReleasedQuotaPendingSummary(result: CoordinationSweepResult): string {
  const summary = result.released_quota_pending_summary;
  const oldest =
    summary.oldest_age_minutes === null ? 'n/a' : `${Math.round(summary.oldest_age_minutes)}m`;
  const topTasks = summary.top_tasks
    .map(
      (task) =>
        `#${task.task_id} ${task.branch} released=${task.released_count} oldest=${Math.round(task.oldest_age_minutes)}m`,
    )
    .join('; ');
  return `quota release summary: released=${summary.released_count} oldest=${oldest} top_tasks=${topTasks}`;
}

function staleSignalCount(result: CoordinationSweepResult): number {
  return (
    result.summary.stale_claim_count +
    result.summary.same_branch_duplicate_claim_count +
    result.summary.expired_handoff_count +
    result.summary.expired_message_count +
    result.summary.decayed_proposal_count +
    result.summary.stale_hot_file_count +
    result.summary.blocked_downstream_task_count +
    result.summary.stale_downstream_blocker_count
  );
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
