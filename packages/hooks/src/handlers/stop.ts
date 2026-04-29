import {
  type HandoffMetadata,
  type MemoryStore,
  type QuotaExhaustedHandoffContext,
  TaskThread,
  detectRepoBranch,
} from '@colony/core';
import type { ObservationRow } from '@colony/storage';
import type { HookInput } from '../types.js';

const AUTO_USAGE_HANDOFF_SUMMARY = 'Session hit usage limit; takeover requested.';
const USAGE_LIMIT_PATTERNS = [
  /\busage[-_\s]*limit\b/i,
  /\brate[-_\s]*limit(?:ed|ing)?\b/i,
  /\bquota(?:\s+(?:exceeded|reached|hit))?\b/i,
  /\btoken[-_\s]*limit\b/i,
  /\bmax(?:imum)?[-_\s]*tokens?\b/i,
];
const NARRATIVE_USAGE_LIMIT_PATTERNS = [
  /\b(?:usage[-_\s]*limit|rate[-_\s]*limit|quota)\b[\s\S]{0,60}\b(?:hit|reached|exceeded|triggered)\b/i,
  /\b(?:hit|reached|exceeded|triggered)\b[\s\S]{0,60}\b(?:usage[-_\s]*limit|rate[-_\s]*limit|quota)\b/i,
];

export async function stop(store: MemoryStore, input: HookInput): Promise<void> {
  const summary = input.turn_summary ?? input.last_assistant_message;
  if (summary?.trim()) {
    store.addSummary({
      session_id: input.session_id,
      scope: 'turn',
      content: summary,
    });
  }

  const usageReason = detectUsageLimitReason(input);
  if (!usageReason) return;

  const taskId = store.storage.findActiveTaskForSession(input.session_id);
  if (taskId === undefined) return;
  if (hasPendingAutoUsageHandoff(store, taskId, input.session_id)) return;

  const thread = new TaskThread(store, taskId);
  const agent = deriveAgent(input);
  const lastUpdate = compactOneLine(summary, 180);
  const quotaContext = buildQuotaHandoffContext(input, thread, agent, usageReason);

  thread.post({
    session_id: input.session_id,
    kind: 'blocker',
    content: `USAGE LIMIT: ${usageReason}. Takeover requested.`,
    metadata: {
      reason: 'usage_limit',
      auto_takeover: true,
    },
  });

  thread.handOff({
    from_session_id: input.session_id,
    from_agent: agent,
    to_agent: 'any',
    summary: AUTO_USAGE_HANDOFF_SUMMARY,
    next_steps: [
      quotaContext.suggested_next_step,
      lastUpdate
        ? `Last assistant update: ${lastUpdate}`
        : 'Last assistant update unavailable; inspect recent observations for context.',
    ],
    blockers: [usageReason],
    reason: 'quota_exhausted',
    runtime_status: 'blocked_by_runtime_limit',
    quota_context: quotaContext,
  });
}

function buildQuotaHandoffContext(
  input: HookInput,
  thread: TaskThread,
  agent: string,
  usageReason: string,
): QuotaExhaustedHandoffContext {
  const task = thread.task();
  const detected = input.cwd ? detectRepoBranch(input.cwd) : null;
  const metadata = input.metadata ?? {};
  const result = isRecord(metadata.result) ? metadata.result : {};
  const claimedFiles = thread
    .claims()
    .filter((claim) => claim.session_id === input.session_id)
    .map((claim) => claim.file_path);
  return {
    agent,
    session_id: input.session_id,
    repo_root: readString(metadata.repo_root) ?? task?.repo_root ?? detected?.repo_root ?? null,
    branch: readString(metadata.branch) ?? task?.branch ?? detected?.branch ?? null,
    worktree_path:
      readString(metadata.worktree_path) ?? readString(metadata.worktreePath) ?? input.cwd ?? null,
    task_id: thread.task_id,
    claimed_files: claimedFiles,
    dirty_files: readStringList(
      firstDefined(
        metadata.dirty_files,
        metadata.dirtyFiles,
        result.dirty_files,
        result.dirtyFiles,
      ),
    ),
    last_command:
      readString(firstDefined(metadata.last_command, metadata.lastCommand, result.last_command)) ??
      null,
    last_tool:
      readString(
        firstDefined(metadata.last_tool, metadata.lastTool, metadata.tool_name, result.last_tool),
      ) ?? null,
    last_verification: readVerification(metadata, result),
    suggested_next_step: `Accept this quota_exhausted handoff, inspect claimed/dirty files, then continue from the latest task timeline. Runtime status: blocked_by_runtime_limit. Cause: ${usageReason}`,
    handoff_ttl_ms: 2 * 60 * 60 * 1000,
  };
}

function detectUsageLimitReason(input: HookInput): string | null {
  for (const signal of collectReasonSignals(input)) {
    const normalized = normalizeSignalForMatch(signal);
    if (USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(signal) || pattern.test(normalized))) {
      return compactOneLine(signal, 220) ?? 'usage limit reached';
    }
  }
  for (const signal of collectNarrativeSignals(input)) {
    if (NARRATIVE_USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(signal))) {
      return compactOneLine(signal, 220) ?? 'usage limit reached';
    }
  }
  return null;
}

function collectReasonSignals(input: HookInput): string[] {
  const values = [input.stop_reason, input.reason, ...extractStringValues(input.metadata)];
  return values.filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
}

function collectNarrativeSignals(input: HookInput): string[] {
  const values = [input.turn_summary, input.last_assistant_message];
  return values.filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
}

function normalizeSignalForMatch(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractStringValues(value: unknown, depth = 0): string[] {
  if (depth > 2 || value == null) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractStringValues(item, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((item) =>
      extractStringValues(item, depth + 1),
    );
  }
  return [];
}

function readVerification(
  metadata: Record<string, unknown>,
  result: Record<string, unknown>,
): QuotaExhaustedHandoffContext['last_verification'] {
  const command = readString(
    firstDefined(
      metadata.last_verification_command,
      metadata.lastVerificationCommand,
      result.last_verification_command,
      result.lastVerificationCommand,
    ),
  );
  const verificationResult = readString(
    firstDefined(
      metadata.last_verification_result,
      metadata.lastVerificationResult,
      result.last_verification_result,
      result.lastVerificationResult,
    ),
  );
  if (!command && !verificationResult) return null;
  return {
    command: command ?? null,
    result: verificationResult ?? null,
  };
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasPendingAutoUsageHandoff(
  store: MemoryStore,
  taskId: number,
  sessionId: string,
): boolean {
  const rows = store.storage.taskObservationsByKind(taskId, 'handoff', 25);
  for (const row of rows) {
    const meta = parseHandoffMetadata(row);
    if (!meta) continue;
    if (meta.status !== 'pending') continue;
    if (meta.from_session_id !== sessionId) continue;
    if (meta.summary !== AUTO_USAGE_HANDOFF_SUMMARY) continue;
    return true;
  }
  return false;
}

function parseHandoffMetadata(row: ObservationRow): HandoffMetadata | null {
  if (!row.metadata) return null;
  try {
    const parsed = JSON.parse(row.metadata) as Partial<HandoffMetadata>;
    if (parsed.kind !== 'handoff') return null;
    if (typeof parsed.status !== 'string') return null;
    if (typeof parsed.from_session_id !== 'string') return null;
    if (typeof parsed.summary !== 'string') return null;
    return parsed as HandoffMetadata;
  } catch {
    return null;
  }
}

function deriveAgent(input: HookInput): string {
  const ide = input.ide?.toLowerCase();
  if (ide === 'claude-code' || ide === 'claude') return 'claude';
  if (ide === 'codex') return 'codex';
  const prefix = input.session_id.split('@')[0]?.toLowerCase();
  if (prefix === 'claude' || prefix === 'claude-code') return 'claude';
  if (prefix === 'codex') return 'codex';
  return prefix || ide || 'agent';
}

function compactOneLine(value: string | undefined, limit: number): string | null {
  if (!value || !value.trim()) return null;
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}
