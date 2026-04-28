import type { ObservationRow, PheromoneRow, ProposalRow, TaskRow } from '@colony/storage';
import type { MemoryStore } from './memory-store.js';
import { PheromoneSystem } from './pheromone.js';
import { type SubtaskInfo, listPlans } from './plan.js';
import { ProposalSystem } from './proposal-system.js';
import { type HandoffMetadata, parseMessage } from './task-thread.js';

const HOT_FILE_NOISE_FLOOR = 0.1;
const STALE_HOT_FILE_MIN_ORIGINAL_STRENGTH = 1;
const DEFAULT_HANDOFF_TTL_MS = 2 * 60 * 60 * 1000;

export interface CoordinationSweepOptions {
  repo_root?: string;
  now?: number;
  stale_claim_minutes?: number;
  hot_file_noise_floor?: number;
  stale_hot_file_min_original_strength?: number;
}

export interface CoordinationSweepResult {
  generated_at: number;
  repo_root: string | null;
  thresholds: {
    stale_claim_minutes: number;
    hot_file_noise_floor: number;
    stale_hot_file_min_original_strength: number;
    proposal_noise_floor: number;
  };
  summary: {
    fresh_claim_count: number;
    stale_claim_count: number;
    expired_weak_claim_count: number;
    expired_handoff_count: number;
    expired_message_count: number;
    decayed_proposal_count: number;
    stale_hot_file_count: number;
    blocked_downstream_task_count: number;
  };
  fresh_claims: FreshClaimSignal[];
  stale_claims: StaleClaimSignal[];
  expired_weak_claims: ExpiredWeakClaimSignal[];
  top_stale_branches: StaleClaimBranchSummary[];
  suggested_cleanup_action: string;
  expired_handoffs: ExpiredHandoffSignal[];
  expired_messages: ExpiredMessageSignal[];
  decayed_proposals: DecayedProposalSignal[];
  stale_hot_files: StaleHotFileSignal[];
  blocked_downstream_tasks: BlockedDownstreamTaskSignal[];
}

export type ClaimCleanupAction = 'keep_fresh' | 'review_stale_claim' | 'expire_weak_claim';

export interface ClaimSignal {
  task_id: number;
  task_title: string;
  repo_root: string;
  branch: string;
  file_path: string;
  session_id: string;
  claimed_at: number;
  age_minutes: number;
  original_strength: number;
  current_strength: number;
  latest_deposited_at: number | null;
  cleanup_action: ClaimCleanupAction;
  cleanup_summary: string;
}

export interface FreshClaimSignal extends ClaimSignal {
  cleanup_action: 'keep_fresh';
}

export interface StaleClaimSignal extends ClaimSignal {
  cleanup_action: 'review_stale_claim' | 'expire_weak_claim';
}

export interface ExpiredWeakClaimSignal extends ClaimSignal {
  cleanup_action: 'expire_weak_claim';
}

export interface StaleClaimBranchSummary {
  repo_root: string;
  branch: string;
  stale_claim_count: number;
  expired_weak_claim_count: number;
  oldest_claim_age_minutes: number;
  suggested_cleanup_action: string;
}

export interface ExpiredHandoffSignal {
  observation_id: number;
  task_id: number;
  task_title: string;
  repo_root: string;
  branch: string;
  from_session_id: string;
  from_agent: string;
  to_agent: string;
  to_session_id: string | null;
  status: string;
  expires_at: number;
  expired_minutes: number;
  summary: string;
}

export interface ExpiredMessageSignal {
  observation_id: number;
  task_id: number;
  task_title: string;
  repo_root: string;
  branch: string;
  from_session_id: string;
  from_agent: string;
  to_agent: string;
  to_session_id: string | null;
  urgency: string;
  status: string;
  expires_at: number;
  expired_minutes: number;
  preview: string;
}

export interface DecayedProposalSignal {
  proposal_id: number;
  repo_root: string;
  branch: string;
  summary: string;
  proposed_by: string;
  proposed_at: number;
  age_minutes: number;
  strength: number;
  noise_floor: number;
  reinforcement_count: number;
  touches_files: string[];
}

export interface StaleHotFileSignal {
  task_id: number;
  task_title: string;
  repo_root: string;
  branch: string;
  file_path: string;
  original_strength: number;
  current_strength: number;
  latest_deposited_at: number;
  age_minutes: number;
  sessions: string[];
}

export interface BlockedDownstreamTaskSignal {
  plan_slug: string;
  plan_title: string;
  repo_root: string;
  task_id: number;
  subtask_index: number;
  subtask_title: string;
  status: string;
  blocked_by_count: number;
  blocked_by: Array<{
    subtask_index: number;
    title: string;
    status: string;
    task_id: number;
  }>;
}

export function buildCoordinationSweep(
  store: MemoryStore,
  opts: CoordinationSweepOptions = {},
): CoordinationSweepResult {
  const now = opts.now ?? Date.now();
  const proposalSystem = new ProposalSystem(store, { now: () => now });
  const thresholds = {
    stale_claim_minutes: opts.stale_claim_minutes ?? store.settings.claimStaleMinutes,
    hot_file_noise_floor: opts.hot_file_noise_floor ?? HOT_FILE_NOISE_FLOOR,
    stale_hot_file_min_original_strength:
      opts.stale_hot_file_min_original_strength ?? STALE_HOT_FILE_MIN_ORIGINAL_STRENGTH,
    proposal_noise_floor: proposalSystem.noiseFloor,
  };
  const tasks = store.storage
    .listTasks(2_000)
    .filter((task) => opts.repo_root === undefined || task.repo_root === opts.repo_root);

  const claimBuckets = collectClaimBuckets(store, tasks, now, thresholds);
  const expired_handoffs = collectExpiredHandoffs(store, tasks, now);
  const expired_messages = collectExpiredMessages(store, tasks, now);
  const decayed_proposals = collectDecayedProposals(store, proposalSystem, opts.repo_root, now);
  const stale_hot_files = collectStaleHotFiles(store, tasks, now, thresholds);
  const blocked_downstream_tasks = collectBlockedDownstreamTasks(store, opts.repo_root);

  return {
    generated_at: now,
    repo_root: opts.repo_root ?? null,
    thresholds,
    summary: {
      fresh_claim_count: claimBuckets.fresh_claims.length,
      stale_claim_count: claimBuckets.stale_claims.length,
      expired_weak_claim_count: claimBuckets.expired_weak_claims.length,
      expired_handoff_count: expired_handoffs.length,
      expired_message_count: expired_messages.length,
      decayed_proposal_count: decayed_proposals.length,
      stale_hot_file_count: stale_hot_files.length,
      blocked_downstream_task_count: blocked_downstream_tasks.length,
    },
    fresh_claims: claimBuckets.fresh_claims,
    stale_claims: claimBuckets.stale_claims,
    expired_weak_claims: claimBuckets.expired_weak_claims,
    top_stale_branches: claimBuckets.top_stale_branches,
    suggested_cleanup_action: suggestClaimCleanup(claimBuckets),
    expired_handoffs,
    expired_messages,
    decayed_proposals,
    stale_hot_files,
    blocked_downstream_tasks,
  };
}

function collectClaimBuckets(
  store: MemoryStore,
  tasks: TaskRow[],
  now: number,
  thresholds: CoordinationSweepResult['thresholds'],
): {
  fresh_claims: FreshClaimSignal[];
  stale_claims: StaleClaimSignal[];
  expired_weak_claims: ExpiredWeakClaimSignal[];
  top_stale_branches: StaleClaimBranchSummary[];
} {
  const staleAfterMs = thresholds.stale_claim_minutes * 60_000;
  const fresh_claims: FreshClaimSignal[] = [];
  const stale_claims: StaleClaimSignal[] = [];
  const expired_weak_claims: ExpiredWeakClaimSignal[] = [];
  for (const task of tasks) {
    for (const claim of store.storage.listClaims(task.id)) {
      const strength = claimPheromoneStrength(
        store,
        task.id,
        claim.file_path,
        claim.session_id,
        now,
      );
      const ageMinutes = elapsedMinutes(now, claim.claimed_at);
      if (now - claim.claimed_at < staleAfterMs) {
        fresh_claims.push({
          task_id: task.id,
          task_title: task.title,
          repo_root: task.repo_root,
          branch: task.branch,
          file_path: claim.file_path,
          session_id: claim.session_id,
          claimed_at: claim.claimed_at,
          age_minutes: ageMinutes,
          ...strength,
          cleanup_action: 'keep_fresh',
          cleanup_summary: 'keep active; claim is inside the fresh window',
        });
        continue;
      }

      const isExpiredWeak = strength.current_strength < thresholds.hot_file_noise_floor;
      const signal: StaleClaimSignal = {
        task_id: task.id,
        task_title: task.title,
        repo_root: task.repo_root,
        branch: task.branch,
        file_path: claim.file_path,
        session_id: claim.session_id,
        claimed_at: claim.claimed_at,
        age_minutes: ageMinutes,
        ...strength,
        cleanup_action: isExpiredWeak ? 'expire_weak_claim' : 'review_stale_claim',
        cleanup_summary: isExpiredWeak
          ? 'would expire advisory claim; audit observations stay intact'
          : 'review owner activity, then release or hand off if inactive',
      };
      stale_claims.push(signal);
      if (isExpiredWeak) expired_weak_claims.push(signal as ExpiredWeakClaimSignal);
    }
  }

  fresh_claims.sort(
    (a, b) => b.age_minutes - a.age_minutes || a.file_path.localeCompare(b.file_path),
  );
  stale_claims.sort(
    (a, b) => b.age_minutes - a.age_minutes || a.file_path.localeCompare(b.file_path),
  );
  expired_weak_claims.sort(
    (a, b) => b.age_minutes - a.age_minutes || a.file_path.localeCompare(b.file_path),
  );

  return {
    fresh_claims,
    stale_claims,
    expired_weak_claims,
    top_stale_branches: topStaleBranches(stale_claims),
  };
}

function claimPheromoneStrength(
  store: MemoryStore,
  taskId: number,
  filePath: string,
  sessionId: string,
  now: number,
): Pick<ClaimSignal, 'original_strength' | 'current_strength' | 'latest_deposited_at'> {
  const row = store.storage.getPheromone(taskId, filePath, sessionId);
  if (!row) {
    return { original_strength: 0, current_strength: 0, latest_deposited_at: null };
  }
  return {
    original_strength: roundStrength(row.strength),
    current_strength: roundStrength(PheromoneSystem.decay(row.strength, row.deposited_at, now)),
    latest_deposited_at: row.deposited_at,
  };
}

function topStaleBranches(staleClaims: StaleClaimSignal[]): StaleClaimBranchSummary[] {
  const byBranch = new Map<string, StaleClaimBranchSummary>();
  for (const claim of staleClaims) {
    const key = `${claim.repo_root}\u0000${claim.branch}`;
    const summary =
      byBranch.get(key) ??
      ({
        repo_root: claim.repo_root,
        branch: claim.branch,
        stale_claim_count: 0,
        expired_weak_claim_count: 0,
        oldest_claim_age_minutes: 0,
        suggested_cleanup_action: '',
      } satisfies StaleClaimBranchSummary);
    summary.stale_claim_count += 1;
    if (claim.cleanup_action === 'expire_weak_claim') summary.expired_weak_claim_count += 1;
    summary.oldest_claim_age_minutes = Math.max(
      summary.oldest_claim_age_minutes,
      claim.age_minutes,
    );
    summary.suggested_cleanup_action =
      summary.expired_weak_claim_count > 0
        ? `expire ${summary.expired_weak_claim_count} weak advisory claim(s); keep audit observations`
        : `review ${summary.stale_claim_count} stale advisory claim(s)`;
    byBranch.set(key, summary);
  }
  return [...byBranch.values()]
    .sort(
      (a, b) =>
        b.stale_claim_count - a.stale_claim_count ||
        b.expired_weak_claim_count - a.expired_weak_claim_count ||
        b.oldest_claim_age_minutes - a.oldest_claim_age_minutes ||
        a.branch.localeCompare(b.branch),
    )
    .slice(0, 10);
}

function suggestClaimCleanup(args: {
  fresh_claims: FreshClaimSignal[];
  stale_claims: StaleClaimSignal[];
  expired_weak_claims: ExpiredWeakClaimSignal[];
}): string {
  if (args.expired_weak_claims.length > 0) {
    return `dry-run: ${args.expired_weak_claims.length} expired/weak advisory claim(s) would be released; audit observations stay intact`;
  }
  if (args.stale_claims.length > 0) {
    return `dry-run: review ${args.stale_claims.length} stale advisory claim(s) for owner activity before release or handoff`;
  }
  if (args.fresh_claims.length > 0) {
    return `dry-run: no cleanup; ${args.fresh_claims.length} fresh claim(s) remain active`;
  }
  return 'dry-run: no cleanup; no live claims found';
}

function collectExpiredHandoffs(
  store: MemoryStore,
  tasks: TaskRow[],
  now: number,
): ExpiredHandoffSignal[] {
  const out: ExpiredHandoffSignal[] = [];
  for (const task of tasks) {
    for (const row of store.storage.taskObservationsByKind(task.id, 'handoff', 1_000)) {
      const meta = parseHandoff(row);
      if (!meta) continue;
      const effectivelyExpired =
        meta.status === 'expired' || (meta.status === 'pending' && now >= meta.expires_at);
      if (!effectivelyExpired) continue;
      out.push({
        observation_id: row.id,
        task_id: task.id,
        task_title: task.title,
        repo_root: task.repo_root,
        branch: task.branch,
        from_session_id: meta.from_session_id,
        from_agent: meta.from_agent,
        to_agent: meta.to_agent,
        to_session_id: meta.to_session_id,
        status: meta.status,
        expires_at: meta.expires_at,
        expired_minutes: elapsedMinutes(now, meta.expires_at),
        summary: meta.summary,
      });
    }
  }
  return out.sort((a, b) => b.expired_minutes - a.expired_minutes);
}

function collectExpiredMessages(
  store: MemoryStore,
  tasks: TaskRow[],
  now: number,
): ExpiredMessageSignal[] {
  const out: ExpiredMessageSignal[] = [];
  for (const task of tasks) {
    for (const row of store.storage.taskObservationsByKind(task.id, 'message', 1_000)) {
      const meta = parseMessage(row.metadata);
      if (!meta || meta.expires_at === null) continue;
      const effectivelyExpired =
        meta.status === 'expired' || (meta.status === 'unread' && now >= meta.expires_at);
      if (!effectivelyExpired) continue;
      out.push({
        observation_id: row.id,
        task_id: task.id,
        task_title: task.title,
        repo_root: task.repo_root,
        branch: task.branch,
        from_session_id: meta.from_session_id,
        from_agent: meta.from_agent,
        to_agent: meta.to_agent,
        to_session_id: meta.to_session_id,
        urgency: meta.urgency,
        status: meta.status,
        expires_at: meta.expires_at,
        expired_minutes: elapsedMinutes(now, meta.expires_at),
        preview: compactPreview(expandedContent(store, row.id, row.content)),
      });
    }
  }
  return out.sort((a, b) => b.expired_minutes - a.expired_minutes);
}

function collectDecayedProposals(
  store: MemoryStore,
  proposals: ProposalSystem,
  repoRoot: string | undefined,
  now: number,
): DecayedProposalSignal[] {
  const rows = store.storage.listProposals(repoRoot);
  return rows
    .filter((proposal) => proposal.status === 'pending')
    .map((proposal) => {
      const strength = proposals.currentStrength(proposal.id, now);
      return proposalSignal(store, proposal, strength, proposals.noiseFloor, now);
    })
    .filter((signal): signal is DecayedProposalSignal => signal !== null)
    .sort((a, b) => a.strength - b.strength || b.age_minutes - a.age_minutes);
}

function proposalSignal(
  store: MemoryStore,
  proposal: ProposalRow,
  strength: number,
  noiseFloor: number,
  now: number,
): DecayedProposalSignal | null {
  if (strength >= noiseFloor) return null;
  const reinforcements = store.storage.listReinforcements(proposal.id);
  return {
    proposal_id: proposal.id,
    repo_root: proposal.repo_root,
    branch: proposal.branch,
    summary: proposal.summary,
    proposed_by: proposal.proposed_by,
    proposed_at: proposal.proposed_at,
    age_minutes: elapsedMinutes(now, proposal.proposed_at),
    strength: roundStrength(strength),
    noise_floor: noiseFloor,
    reinforcement_count: new Set(reinforcements.map((row) => row.session_id)).size,
    touches_files: parseFiles(proposal.touches_files),
  };
}

function collectStaleHotFiles(
  store: MemoryStore,
  tasks: TaskRow[],
  now: number,
  thresholds: CoordinationSweepResult['thresholds'],
): StaleHotFileSignal[] {
  const out: StaleHotFileSignal[] = [];
  for (const task of tasks) {
    const byFile = groupPheromonesByFile(store.storage.listPheromonesForTask(task.id));
    for (const [filePath, rows] of byFile.entries()) {
      const originalStrength = rows.reduce((sum, row) => sum + row.strength, 0);
      if (originalStrength < thresholds.stale_hot_file_min_original_strength) continue;
      const currentStrength = rows.reduce(
        (sum, row) => sum + PheromoneSystem.decay(row.strength, row.deposited_at, now),
        0,
      );
      if (currentStrength >= thresholds.hot_file_noise_floor) continue;
      const latestDepositedAt = Math.max(...rows.map((row) => row.deposited_at));
      out.push({
        task_id: task.id,
        task_title: task.title,
        repo_root: task.repo_root,
        branch: task.branch,
        file_path: filePath,
        original_strength: roundStrength(originalStrength),
        current_strength: roundStrength(currentStrength),
        latest_deposited_at: latestDepositedAt,
        age_minutes: elapsedMinutes(now, latestDepositedAt),
        sessions: [...new Set(rows.map((row) => row.session_id))].sort(),
      });
    }
  }
  return out.sort(
    (a, b) => b.original_strength - a.original_strength || b.age_minutes - a.age_minutes,
  );
}

function collectBlockedDownstreamTasks(
  store: MemoryStore,
  repoRoot: string | undefined,
): BlockedDownstreamTaskSignal[] {
  const out: BlockedDownstreamTaskSignal[] = [];
  for (const plan of listPlans(store, {
    ...(repoRoot !== undefined ? { repo_root: repoRoot } : {}),
    limit: 2_000,
  })) {
    for (const subtask of plan.subtasks) {
      if (subtask.status === 'completed' || subtask.blocked_by_count === 0) continue;
      out.push({
        plan_slug: plan.plan_slug,
        plan_title: plan.title,
        repo_root: plan.repo_root,
        task_id: subtask.task_id,
        subtask_index: subtask.subtask_index,
        subtask_title: subtask.title,
        status: subtask.status,
        blocked_by_count: subtask.blocked_by_count,
        blocked_by: blockersFor(subtask, plan.subtasks),
      });
    }
  }
  return out.sort(
    (a, b) =>
      b.blocked_by_count - a.blocked_by_count ||
      a.plan_slug.localeCompare(b.plan_slug) ||
      a.subtask_index - b.subtask_index,
  );
}

function blockersFor(
  subtask: SubtaskInfo,
  all: SubtaskInfo[],
): BlockedDownstreamTaskSignal['blocked_by'] {
  return subtask.blocked_by
    .map((index) => all.find((candidate) => candidate.subtask_index === index))
    .filter((candidate): candidate is SubtaskInfo => candidate !== undefined)
    .map((blocker) => ({
      subtask_index: blocker.subtask_index,
      title: blocker.title,
      status: blocker.status,
      task_id: blocker.task_id,
    }));
}

function groupPheromonesByFile(rows: PheromoneRow[]): Map<string, PheromoneRow[]> {
  const byFile = new Map<string, PheromoneRow[]>();
  for (const row of rows) {
    const list = byFile.get(row.file_path) ?? [];
    list.push(row);
    byFile.set(row.file_path, list);
  }
  return byFile;
}

function parseHandoff(row: ObservationRow): HandoffMetadata | null {
  if (!row.metadata) return null;
  try {
    const parsed = JSON.parse(row.metadata) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const meta = parsed as Partial<HandoffMetadata>;
    if (meta.kind !== 'handoff' || typeof meta.status !== 'string') return null;
    const handoff = parsed as HandoffMetadata;
    if (typeof handoff.expires_at !== 'number' || !Number.isFinite(handoff.expires_at)) {
      handoff.expires_at = row.ts + DEFAULT_HANDOFF_TTL_MS;
    }
    return handoff;
  } catch {
    return null;
  }
}

function parseFiles(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function compactPreview(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function expandedContent(store: MemoryStore, observationId: number, fallback: string): string {
  return store.getObservations([observationId], { expand: true })[0]?.content ?? fallback;
}

function elapsedMinutes(now: number, then: number): number {
  return Math.max(0, Math.floor((now - then) / 60_000));
}

function roundStrength(value: number): number {
  return Number(value.toFixed(3));
}
