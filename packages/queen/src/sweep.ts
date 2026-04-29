import {
  type MemoryStore,
  type MessageTarget,
  type PlanInfo,
  type SubtaskInfo,
  TaskThread,
  areDepsMet,
  listPlans,
} from '@colony/core';

export const DEFAULT_STALLED_MINUTES = 60;
export const DEFAULT_UNCLAIMED_MINUTES = 240;

const MINUTE_MS = 60_000;
const QUEEN_SESSION_ID = 'queen-sweep';
const QUEEN_AGENT = 'queen';

export interface SweepQueenPlansOptions {
  older_than_minutes?: number;
  unclaimed_older_than_minutes?: number;
  auto_message?: boolean;
  repo_root?: string;
  limit?: number;
  now?: number;
}

export type QueenAttentionReason = 'stalled' | 'unclaimed' | 'ready-to-archive';

export interface QueenSweepWaveRef {
  index: number;
  label: string;
  source: 'metadata' | 'inferred';
  id?: string;
  title?: string;
  is_finalizer?: boolean;
}

export interface QueenSweepWaveBlocker {
  index: number;
  label: string;
}

export interface QueenSweepWaveSummary extends QueenSweepWaveRef {
  subtask_indexes: number[];
  stalled_subtask_count: number;
  unclaimed_subtask_count: number;
  blocked_subtask_count: number;
  waiting_on_subtask_count: number;
  blocked_by: QueenSweepWaveBlocker[];
}

export type QueenReplacementAgent = 'claude-code' | 'codex' | 'any';
export type QueenReplacementNextTool = 'task_accept_handoff' | 'task_plan_claim_subtask';

export interface QueenReplacementRecommendation {
  recommended_replacement_agent: QueenReplacementAgent;
  reason: string;
  next_tool: QueenReplacementNextTool;
  claim_args: Record<string, unknown>;
  signals: {
    stale_blocker_age_minutes: number;
    claimed_file_count: number;
    task_size: number;
    claimed_by_agent: string | null;
    runtime_history: string | null;
    quota_exhausted_handoff_id: number | null;
  };
}

interface BaseAttention {
  reason: QueenAttentionReason;
  plan_slug: string;
  plan_title: string;
  repo_root: string;
  wave?: QueenSweepWaveRef;
}

export interface StalledSubtaskAttention extends BaseAttention {
  reason: 'stalled';
  task_id: number;
  subtask_index: number;
  subtask_title: string;
  age_minutes: number;
  claimed_at: number;
  claimed_by_session_id: string;
  claimed_by_agent: string | null;
  message_observation_id?: number;
  replacement_recommendation?: QueenReplacementRecommendation;
}

export interface UnclaimedSubtaskAttention extends BaseAttention {
  reason: 'unclaimed';
  task_id: number;
  subtask_index: number;
  subtask_title: string;
  age_minutes: number;
  available_since: number;
}

export interface ReadyToArchiveAttention extends BaseAttention {
  reason: 'ready-to-archive';
  spec_task_id: number;
  completed_subtask_count: number;
}

export type QueenAttentionItem =
  | StalledSubtaskAttention
  | UnclaimedSubtaskAttention
  | ReadyToArchiveAttention;

export interface QueenPlanAttention {
  plan_slug: string;
  title: string;
  repo_root: string;
  spec_task_id: number;
  items: QueenAttentionItem[];
  waves?: QueenSweepWaveSummary[];
  validation_summary?: QueenPlanValidationSweepSummary;
}

export interface QueenPlanValidationSweepSummary {
  blocking: boolean;
  finding_count: number;
  counts: {
    error: number;
    warning: number;
    info: number;
  };
  top_findings: Array<{
    code: string;
    severity: 'error' | 'warning' | 'info';
    message: string;
    file_path?: string;
    subtask_index?: number;
  }>;
}

export function sweepQueenPlans(
  store: MemoryStore,
  opts: SweepQueenPlansOptions = {},
): QueenPlanAttention[] {
  const now = opts.now ?? Date.now();
  const stalledAfterMs = minutesToMs(opts.older_than_minutes ?? DEFAULT_STALLED_MINUTES);
  const unclaimedAfterMs = minutesToMs(
    opts.unclaimed_older_than_minutes ?? DEFAULT_UNCLAIMED_MINUTES,
  );
  const plans = listPlans(store, {
    ...(opts.repo_root !== undefined ? { repo_root: opts.repo_root } : {}),
    limit: opts.limit ?? 2000,
  });

  const attention: QueenPlanAttention[] = [];
  for (const plan of plans) {
    const items: QueenAttentionItem[] = [];
    const waveModel = buildWaveModel(store, plan);

    for (const subtask of plan.subtasks) {
      if (subtask.status === 'claimed') {
        const claimedAt = latestStatusTs(store, subtask.task_id, 'claimed');
        if (claimedAt !== null && now - claimedAt > stalledAfterMs) {
          const claimedBy = subtask.claimed_by_session_id;
          if (claimedBy !== null) {
            const item: StalledSubtaskAttention = {
              reason: 'stalled',
              plan_slug: plan.plan_slug,
              plan_title: plan.title,
              repo_root: plan.repo_root,
              task_id: subtask.task_id,
              subtask_index: subtask.subtask_index,
              subtask_title: subtask.title,
              age_minutes: elapsedMinutes(now, claimedAt),
              claimed_at: claimedAt,
              claimed_by_session_id: claimedBy,
              claimed_by_agent: subtask.claimed_by_agent,
              ...waveForAttention(waveModel, subtask),
            };
            const recommendation = recommendReplacementAgent(store, item, subtask, now);
            if (recommendation !== undefined) item.replacement_recommendation = recommendation;
            if (opts.auto_message === true) {
              item.message_observation_id = messageStalledClaimer(store, item);
            }
            items.push(item);
          }
        }
      }

      if (subtask.status === 'available' && areDepsMet(subtask, plan.subtasks)) {
        const availableSince = availableSinceTs(store, plan, subtask);
        if (now - availableSince > unclaimedAfterMs) {
          items.push({
            reason: 'unclaimed',
            plan_slug: plan.plan_slug,
            plan_title: plan.title,
            repo_root: plan.repo_root,
            task_id: subtask.task_id,
            subtask_index: subtask.subtask_index,
            subtask_title: subtask.title,
            age_minutes: elapsedMinutes(now, availableSince),
            available_since: availableSince,
            ...waveForAttention(waveModel, subtask),
          });
        }
      }
    }

    if (isReadyToArchive(store, plan)) {
      items.push({
        reason: 'ready-to-archive',
        plan_slug: plan.plan_slug,
        plan_title: plan.title,
        repo_root: plan.repo_root,
        spec_task_id: plan.spec_task_id,
        completed_subtask_count: plan.subtasks.length,
      });
    }

    if (items.length > 0) {
      const waves = summarizeWaves(plan, items, waveModel);
      const validationSummary = latestValidationSummary(store, plan.spec_task_id);
      attention.push({
        plan_slug: plan.plan_slug,
        title: plan.title,
        repo_root: plan.repo_root,
        spec_task_id: plan.spec_task_id,
        items,
        ...(waves.length > 0 ? { waves } : {}),
        ...(validationSummary !== null ? { validation_summary: validationSummary } : {}),
      });
    }
  }

  return attention;
}

function recommendReplacementAgent(
  store: MemoryStore,
  item: StalledSubtaskAttention,
  subtask: SubtaskInfo,
  now: number,
): QueenReplacementRecommendation | undefined {
  const claimedFileCount = store.storage.listClaims(item.task_id).length;
  const taskSize = subtask.file_scope.length;
  const runtimeHistory = store.storage.getSession(item.claimed_by_session_id)?.ide ?? null;
  const quotaHandoff = latestQuotaExhaustedHandoff(store, item.task_id, now);
  const stalledAgent = normalizeRuntimeAgent(
    quotaHandoff?.from_agent ?? item.claimed_by_agent ?? runtimeHistory,
  );
  const recommended = oppositeRuntime(stalledAgent, claimedFileCount, taskSize);

  if (quotaHandoff !== null) {
    return {
      recommended_replacement_agent: recommended,
      reason: `${displayRuntime(stalledAgent)} recently hit quota on this branch`,
      next_tool: 'task_accept_handoff',
      claim_args: {
        handoff_observation_id: quotaHandoff.id,
        session_id: '<session_id>',
      },
      signals: {
        stale_blocker_age_minutes: item.age_minutes,
        claimed_file_count: claimedFileCount,
        task_size: taskSize,
        claimed_by_agent: item.claimed_by_agent,
        runtime_history: runtimeHistory,
        quota_exhausted_handoff_id: quotaHandoff.id,
      },
    };
  }

  if (item.age_minutes < DEFAULT_STALLED_MINUTES) return undefined;
  return {
    recommended_replacement_agent: recommended,
    reason: `${displayRuntime(stalledAgent)} stale for ${item.age_minutes}m on ${claimedFileCount} claimed file(s); task size ${taskSize} file(s)`,
    next_tool: 'task_plan_claim_subtask',
    claim_args: {
      plan_slug: item.plan_slug,
      subtask_index: item.subtask_index,
      session_id: '<session_id>',
      agent: recommended,
      repo_root: item.repo_root,
      file_scope: subtask.file_scope,
    },
    signals: {
      stale_blocker_age_minutes: item.age_minutes,
      claimed_file_count: claimedFileCount,
      task_size: taskSize,
      claimed_by_agent: item.claimed_by_agent,
      runtime_history: runtimeHistory,
      quota_exhausted_handoff_id: null,
    },
  };
}

function latestQuotaExhaustedHandoff(
  store: MemoryStore,
  taskId: number,
  now: number,
): { id: number; from_agent: string | null } | null {
  const rows = store.storage.taskObservationsByKind(taskId, 'handoff', 100);
  for (const row of rows) {
    const meta = parseMeta(row.metadata);
    if (!isPendingSignal(meta, now)) continue;
    const text = [
      row.content,
      stringValue(meta.reason),
      stringValue(meta.summary),
      stringValue(meta.one_line),
      stringArrayValue(meta.blockers).join(' '),
    ]
      .filter(Boolean)
      .join(' ');
    if (
      meta.quota_exhausted === true ||
      /\bquota(?:[-_\s]*exhausted|[-_\s]*hit|[-_\s]*reached|[-_\s]*exceeded)?\b/i.test(text)
    ) {
      return {
        id: row.id,
        from_agent: stringValue(meta.from_agent) ?? null,
      };
    }
  }
  return null;
}

function isPendingSignal(meta: Record<string, unknown>, now: number): boolean {
  const status = stringValue(meta.status);
  if (status !== undefined && status !== 'pending') return false;
  const expiresAt = numberValue(meta.expires_at);
  return expiresAt === undefined || now < expiresAt;
}

function latestValidationSummary(
  store: MemoryStore,
  specTaskId: number,
): QueenPlanValidationSweepSummary | null {
  const latest = store.storage.taskObservationsByKind(specTaskId, 'plan-validation', 1)[0];
  if (!latest?.metadata) return null;
  const meta = parseMeta(latest.metadata);
  const counts = objectValue(meta.counts);
  const findings = Array.isArray(meta.findings) ? meta.findings : [];
  return {
    blocking: booleanValue(meta.blocking) ?? false,
    finding_count: numberValue(meta.finding_count) ?? findings.length,
    counts: {
      error: numberValue(counts?.error) ?? 0,
      warning: numberValue(counts?.warning) ?? 0,
      info: numberValue(counts?.info) ?? 0,
    },
    top_findings: findings.slice(0, 5).flatMap((finding) => {
      const item = objectValue(finding);
      const code = stringValue(item?.code);
      const severity = stringValue(item?.severity);
      const message = stringValue(item?.message);
      if (
        !code ||
        !message ||
        (severity !== 'error' && severity !== 'warning' && severity !== 'info')
      ) {
        return [];
      }
      const out: QueenPlanValidationSweepSummary['top_findings'][number] = {
        code,
        severity,
        message,
      };
      const filePath = stringValue(item?.file_path);
      const subtaskIndex = numberValue(item?.subtask_index);
      if (filePath !== undefined) out.file_path = filePath;
      if (subtaskIndex !== undefined) out.subtask_index = subtaskIndex;
      return [out];
    }),
  };
}

function messageStalledClaimer(store: MemoryStore, item: StalledSubtaskAttention): number {
  const thread = new TaskThread(store, item.task_id);
  store.startSession({ id: QUEEN_SESSION_ID, ide: QUEEN_AGENT, cwd: null });
  thread.join(QUEEN_SESSION_ID, QUEEN_AGENT);
  return thread.postMessage({
    from_session_id: QUEEN_SESSION_ID,
    from_agent: QUEEN_AGENT,
    to_agent: messageTarget(item.claimed_by_agent),
    to_session_id: item.claimed_by_session_id,
    urgency: 'needs_reply',
    content: `Sub-task ${item.subtask_index} has been claimed for ${item.age_minutes} minutes — still active?`,
  });
}

function isReadyToArchive(store: MemoryStore, plan: PlanInfo): boolean {
  if (plan.subtasks.length === 0) return false;
  if (!plan.subtasks.every((subtask) => subtask.status === 'completed')) return false;
  if (planAutoArchiveEnabled(store, plan.spec_task_id)) return false;
  return !planAlreadyArchived(store, plan.spec_task_id);
}

function planAutoArchiveEnabled(store: MemoryStore, specTaskId: number): boolean {
  const configRows = store.storage.taskObservationsByKind(specTaskId, 'plan-config', 100);
  const latest = configRows[0];
  if (!latest?.metadata) return false;
  const meta = parseMeta(latest.metadata);
  return meta.auto_archive === true;
}

function planAlreadyArchived(store: MemoryStore, specTaskId: number): boolean {
  return (
    store.storage.taskObservationsByKind(specTaskId, 'plan-archived', 1).length > 0 ||
    store.storage.taskObservationsByKind(specTaskId, 'plan-auto-archive', 1).length > 0
  );
}

function availableSinceTs(store: MemoryStore, plan: PlanInfo, subtask: SubtaskInfo): number {
  const initial = initialSubtaskTs(store, subtask.task_id);
  const dependencyCompletionTimes = subtask.depends_on
    .map((index) => plan.subtasks.find((candidate) => candidate.subtask_index === index))
    .filter((candidate): candidate is SubtaskInfo => candidate !== undefined)
    .map((dependency) => latestStatusTs(store, dependency.task_id, 'completed'))
    .filter((ts): ts is number => ts !== null);
  return Math.max(initial, ...dependencyCompletionTimes);
}

interface WaveModel {
  by_subtask_index: Map<number, QueenSweepWaveRef>;
  reportable: boolean;
}

function buildWaveModel(store: MemoryStore, plan: PlanInfo): WaveModel {
  const inferredIndexes = inferWaveIndexes(plan);
  const bySubtask = new Map<number, QueenSweepWaveRef>();
  let hasMetadata = false;

  for (const subtask of plan.subtasks) {
    const inferredIndex = inferredIndexes.get(subtask.subtask_index) ?? 1;
    const metadata = waveMetadataFromSubtask(store, subtask);
    if (metadata !== null) hasMetadata = true;
    const index = metadata?.index ?? inferredIndex;
    const isFinalizer = metadata?.is_finalizer === true;
    bySubtask.set(subtask.subtask_index, {
      index,
      label: metadata?.label ?? (isFinalizer ? 'Finalizer' : `Wave ${index}`),
      source: metadata !== null ? 'metadata' : 'inferred',
      ...(metadata?.id !== undefined ? { id: metadata.id } : {}),
      ...(metadata?.title !== undefined ? { title: metadata.title } : {}),
      ...(isFinalizer ? { is_finalizer: true } : {}),
    });
  }

  const uniqueInferredWaves = new Set(inferredIndexes.values());
  return {
    by_subtask_index: bySubtask,
    reportable: hasMetadata || uniqueInferredWaves.size > 1,
  };
}

function waveForAttention(
  model: WaveModel,
  subtask: SubtaskInfo,
): { wave: QueenSweepWaveRef } | Record<string, never> {
  const wave = model.by_subtask_index.get(subtask.subtask_index);
  return wave ? { wave } : {};
}

function summarizeWaves(
  plan: PlanInfo,
  items: QueenAttentionItem[],
  model: WaveModel,
): QueenSweepWaveSummary[] {
  if (!model.reportable) return [];

  const waves = new Map<number, QueenSweepWaveSummary>();
  for (const subtask of plan.subtasks) {
    const wave = model.by_subtask_index.get(subtask.subtask_index);
    if (!wave) continue;
    let summary = waves.get(wave.index);
    if (!summary) {
      summary = {
        ...wave,
        subtask_indexes: [],
        stalled_subtask_count: 0,
        unclaimed_subtask_count: 0,
        blocked_subtask_count: 0,
        waiting_on_subtask_count: 0,
        blocked_by: [],
      };
      waves.set(wave.index, summary);
    }
    summary.subtask_indexes.push(subtask.subtask_index);
  }

  for (const item of items) {
    if (item.reason === 'ready-to-archive') continue;
    const wave = item.wave ? waves.get(item.wave.index) : undefined;
    if (!wave) continue;
    if (item.reason === 'stalled') wave.stalled_subtask_count++;
    if (item.reason === 'unclaimed') wave.unclaimed_subtask_count++;
  }

  for (const summary of waves.values()) {
    const waitingOn = new Set<number>();
    const blockedBy = new Map<number, QueenSweepWaveBlocker>();
    for (const subtask of plan.subtasks) {
      const wave = model.by_subtask_index.get(subtask.subtask_index);
      if (wave?.index !== summary.index) continue;
      if (subtask.status !== 'available' || areDepsMet(subtask, plan.subtasks)) continue;
      summary.blocked_subtask_count++;
      for (const depIndex of unmetDependencyIndexes(subtask, plan.subtasks)) {
        waitingOn.add(depIndex);
        const depWave = model.by_subtask_index.get(depIndex);
        if (depWave && depWave.index !== summary.index) {
          blockedBy.set(depWave.index, { index: depWave.index, label: depWave.label });
        }
      }
    }
    summary.waiting_on_subtask_count = waitingOn.size;
    summary.blocked_by = [...blockedBy.values()].sort((a, b) => a.index - b.index);
    summary.subtask_indexes.sort((a, b) => a - b);
  }

  return [...waves.values()].sort((a, b) => a.index - b.index);
}

function unmetDependencyIndexes(subtask: SubtaskInfo, all: SubtaskInfo[]): number[] {
  return subtask.depends_on.filter((idx) => {
    const dep = all.find((candidate) => candidate.subtask_index === idx);
    return dep?.status !== 'completed';
  });
}

function inferWaveIndexes(plan: PlanInfo): Map<number, number> {
  const byIndex = new Map(plan.subtasks.map((subtask) => [subtask.subtask_index, subtask]));
  const memo = new Map<number, number>();

  const visit = (subtask: SubtaskInfo): number => {
    const cached = memo.get(subtask.subtask_index);
    if (cached !== undefined) return cached;
    const depWaves = subtask.depends_on
      .map((idx) => byIndex.get(idx))
      .filter((dep): dep is SubtaskInfo => dep !== undefined)
      .map(visit);
    const index = depWaves.length > 0 ? Math.max(...depWaves) + 1 : 1;
    memo.set(subtask.subtask_index, index);
    return index;
  };

  for (const subtask of plan.subtasks) visit(subtask);
  return memo;
}

function waveMetadataFromSubtask(
  store: MemoryStore,
  subtask: SubtaskInfo,
): QueenSweepWaveRef | null {
  const meta = initialSubtaskMeta(store, subtask.task_id);
  const nested = objectValue(meta.wave) ?? objectValue(meta.queen_wave);
  const rawIndex =
    numberValue(meta.wave_number) ??
    numberValue(nested?.number) ??
    waveNumberFromText(stringValue(meta.wave_label)) ??
    waveNumberFromText(stringValue(nested?.label)) ??
    waveNumberFromText(stringValue(meta.wave_id)) ??
    waveNumberFromText(stringValue(nested?.id)) ??
    normalizeWaveIndex(numberValue(meta.wave_index) ?? numberValue(nested?.index));
  const id = stringValue(meta.wave_id) ?? stringValue(nested?.id);
  const title = stringValue(meta.wave_title) ?? stringValue(nested?.title);
  const label = stringValue(meta.wave_label) ?? stringValue(nested?.label);
  const role = stringValue(meta.wave_role) ?? stringValue(nested?.role);
  const isFinalizer =
    booleanValue(meta.is_finalizer) === true ||
    booleanValue(nested?.is_finalizer) === true ||
    role === 'finalizer' ||
    labelContainsFinalizer(label) ||
    labelContainsFinalizer(title) ||
    labelContainsFinalizer(id);

  if (rawIndex === undefined && id === undefined && title === undefined && label === undefined) {
    return null;
  }

  const index = rawIndex ?? 1;
  return {
    index,
    label: label ?? (isFinalizer ? 'Finalizer' : `Wave ${index}`),
    source: 'metadata',
    ...(id !== undefined ? { id } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(isFinalizer ? { is_finalizer: true } : {}),
  };
}

function initialSubtaskMeta(store: MemoryStore, taskId: number): Record<string, unknown> {
  const rows = store.storage.taskObservationsByKind(taskId, 'plan-subtask', 500);
  if (rows.length === 0) return {};
  const first = rows[0];
  if (!first) return {};
  const initial = rows.reduce((oldest, row) => (row.ts < oldest.ts ? row : oldest), first);
  return parseMeta(initial.metadata);
}

function normalizeWaveIndex(raw: number | undefined): number | undefined {
  if (raw === undefined || !Number.isInteger(raw) || raw < 0) return undefined;
  return raw + 1;
}

function waveNumberFromText(raw: string | undefined): number | undefined {
  const match = raw?.match(/\bwave[-_\s]*(\d+)\b/i);
  if (!match?.[1]) return undefined;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function labelContainsFinalizer(raw: string | undefined): boolean {
  return raw?.toLowerCase().includes('finalizer') === true;
}

function initialSubtaskTs(store: MemoryStore, taskId: number): number {
  const rows = store.storage.taskObservationsByKind(taskId, 'plan-subtask', 500);
  const initial = rows.length > 0 ? Math.min(...rows.map((row) => row.ts)) : null;
  if (initial !== null) return initial;
  return store.storage.getTask(taskId)?.created_at ?? 0;
}

function latestStatusTs(
  store: MemoryStore,
  taskId: number,
  status: 'claimed' | 'completed',
): number | null {
  const rows = store.storage.taskObservationsByKind(taskId, 'plan-subtask-claim', 500);
  for (const row of rows) {
    const meta = parseMeta(row.metadata);
    if (meta.status === status) return row.ts;
  }
  return null;
}

function elapsedMinutes(now: number, since: number): number {
  return Math.max(0, Math.floor((now - since) / MINUTE_MS));
}

function minutesToMs(minutes: number): number {
  return Math.max(0, minutes) * MINUTE_MS;
}

function messageTarget(agent: string | null): MessageTarget {
  if (agent === 'claude' || agent === 'codex') return agent;
  return 'any';
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function normalizeRuntimeAgent(value: string | null | undefined): QueenReplacementAgent {
  const normalized = value?.toLowerCase() ?? '';
  if (normalized.includes('claude')) return 'claude-code';
  if (normalized.includes('codex')) return 'codex';
  return 'any';
}

function oppositeRuntime(
  staleAgent: QueenReplacementAgent,
  claimedFileCount: number,
  taskSize: number,
): QueenReplacementAgent {
  if (staleAgent === 'codex') return 'claude-code';
  if (staleAgent === 'claude-code') return 'codex';
  return claimedFileCount > 3 || taskSize > 3 ? 'any' : 'codex';
}

function displayRuntime(agent: QueenReplacementAgent): string {
  if (agent === 'claude-code') return 'Claude';
  if (agent === 'codex') return 'Codex';
  return 'Unknown runtime';
}
