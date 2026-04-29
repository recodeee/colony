import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { MemoryStore } from './memory-store.js';

const FIELD_LIMIT = 240;
const NOTE_LIMIT = 320;
const FILE_LIMIT = 8;

type JsonRecord = Record<string, unknown>;

export interface OmxRuntimeSummaryInput {
  session_id?: string;
  agent?: string;
  repo_root?: string;
  branch?: string;
  task_id?: number;
  timestamp?: string | number;
  quota_warning?: unknown;
  runtime_model_error?: unknown;
  runtime_error?: unknown;
  model_error?: unknown;
  last_prompt_summary?: unknown;
  last_failed_tool?: unknown;
  local_working_note?: unknown;
  active_file_focus?: unknown;
}

export interface NormalizedOmxRuntimeSummary {
  session_id: string;
  agent: string;
  repo_root: string | null;
  branch: string | null;
  task_id: number | null;
  ts: number;
  quota_warning: string | null;
  runtime_model_error: string | null;
  last_prompt_summary: string | null;
  last_failed_tool: { name: string | null; error: string | null } | null;
  local_working_note: string | null;
  active_file_focus: string[];
  warnings: OmxRuntimeWarningKind[];
}

export type OmxRuntimeWarningKind = 'quota_warning' | 'runtime_model_error' | 'last_failed_tool';

export interface IngestOmxRuntimeSummaryResult {
  ok: boolean;
  observation_id?: number;
  task_id?: number | null;
  warnings?: OmxRuntimeWarningKind[];
  error?: string;
}

export interface IngestOmxRuntimeSummaryFileResult {
  path: string;
  scanned: number;
  ingested: number;
  failed: number;
  observations: number[];
  errors: string[];
}

export function normalizeOmxRuntimeSummary(
  input: OmxRuntimeSummaryInput,
  defaults: { repoRoot?: string; sessionId?: string; agent?: string; branch?: string } = {},
): NormalizedOmxRuntimeSummary | null {
  const sessionId = shortString(input.session_id) ?? defaults.sessionId;
  if (!sessionId) return null;
  const repoRoot = shortString(input.repo_root) ?? defaults.repoRoot ?? null;
  const branch = shortString(input.branch) ?? defaults.branch ?? null;
  const runtimeModelError = compactText(input.runtime_model_error ?? input.model_error, FIELD_LIMIT);
  const failedTool = normalizeFailedTool(input.last_failed_tool);
  const summary: NormalizedOmxRuntimeSummary = {
    session_id: sessionId,
    agent: shortString(input.agent) ?? defaults.agent ?? agentFromSession(sessionId),
    repo_root: repoRoot ? resolve(repoRoot) : null,
    branch,
    task_id: typeof input.task_id === 'number' && Number.isInteger(input.task_id) ? input.task_id : null,
    ts: timestampMs(input.timestamp),
    quota_warning: compactText(input.quota_warning, FIELD_LIMIT),
    runtime_model_error: runtimeModelError,
    last_prompt_summary: compactText(input.last_prompt_summary, FIELD_LIMIT),
    last_failed_tool: failedTool,
    local_working_note: compactText(input.local_working_note, NOTE_LIMIT),
    active_file_focus: normalizeFileFocus(input.active_file_focus),
    warnings: [],
  };
  if (summary.quota_warning) summary.warnings.push('quota_warning');
  if (summary.runtime_model_error) summary.warnings.push('runtime_model_error');
  if (summary.last_failed_tool?.error) summary.warnings.push('last_failed_tool');
  return summary;
}

export function ingestOmxRuntimeSummary(
  store: MemoryStore,
  input: OmxRuntimeSummaryInput,
  defaults: { repoRoot?: string; sessionId?: string; agent?: string; branch?: string } = {},
): IngestOmxRuntimeSummaryResult {
  const summary = normalizeOmxRuntimeSummary(input, defaults);
  if (!summary) return { ok: false, error: 'missing session_id' };

  store.startSession({
    id: summary.session_id,
    ide: summary.agent === 'claude' ? 'claude-code' : summary.agent,
    cwd: summary.repo_root,
    metadata: compactObject({
      source: 'omx-runtime-summary',
      agent: summary.agent,
      repo_root: summary.repo_root,
      branch: summary.branch,
    }),
  });

  const taskId = resolveTaskId(store, summary);
  const observationId = store.storage.insertObservation({
    session_id: summary.session_id,
    kind: 'omx-runtime-summary',
    content: contentFromSummary(summary),
    compressed: false,
    intensity: null,
    ts: summary.ts,
    task_id: taskId,
    metadata: compactObject({
      kind: 'omx-runtime-summary',
      source: 'omx',
      agent: summary.agent,
      repo_root: summary.repo_root,
      branch: summary.branch,
      quota_warning: summary.quota_warning,
      runtime_model_error: summary.runtime_model_error,
      last_prompt_summary: summary.last_prompt_summary,
      last_failed_tool: summary.last_failed_tool,
      local_working_note: summary.local_working_note,
      active_file_focus: summary.active_file_focus,
      warnings: summary.warnings,
      warning_count: summary.warnings.length,
    }),
  });

  return { ok: true, observation_id: observationId, task_id: taskId, warnings: summary.warnings };
}

export function ingestOmxRuntimeSummaryFile(
  store: MemoryStore,
  path: string,
  defaults: { repoRoot?: string; sessionId?: string; agent?: string; branch?: string } = {},
): IngestOmxRuntimeSummaryFileResult {
  const result: IngestOmxRuntimeSummaryFileResult = {
    path,
    scanned: 0,
    ingested: 0,
    failed: 0,
    observations: [],
    errors: [],
  };
  if (!existsSync(path) || !statSync(path).isFile()) return result;
  for (const record of readSummaryRecords(path)) {
    result.scanned++;
    const ingest = ingestOmxRuntimeSummary(store, record, defaults);
    if (ingest.ok && ingest.observation_id !== undefined) {
      result.ingested++;
      result.observations.push(ingest.observation_id);
    } else {
      result.failed++;
      result.errors.push(ingest.error ?? 'invalid summary');
    }
  }
  return result;
}

export function defaultOmxRuntimeSummaryPaths(repoRoot: string): string[] {
  return [
    join(repoRoot, '.omx', 'runtime-summary.json'),
    join(repoRoot, '.omx', 'runtime-summary.jsonl'),
    join(repoRoot, '.omx', 'state', 'runtime-summary.json'),
    join(repoRoot, '.omx', 'state', 'runtime-summary.jsonl'),
  ];
}

function readSummaryRecords(path: string): OmxRuntimeSummaryInput[] {
  const raw = readFileSync(path, 'utf8');
  if (path.endsWith('.jsonl')) {
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => safeRecord(line))
      .filter((record): record is OmxRuntimeSummaryInput => record !== null);
  }
  const parsed = safeJson(raw);
  if (Array.isArray(parsed)) return parsed.filter(isRecord) as OmxRuntimeSummaryInput[];
  return isRecord(parsed) ? [parsed as OmxRuntimeSummaryInput] : [];
}

function resolveTaskId(store: MemoryStore, summary: NormalizedOmxRuntimeSummary): number | null {
  if (summary.task_id !== null) return summary.task_id;
  const active = store.storage.findActiveTaskForSession(summary.session_id);
  if (active !== undefined) return active;
  if (summary.repo_root && summary.branch) {
    return store.storage.findTaskByBranch(summary.repo_root, summary.branch)?.id ?? null;
  }
  return null;
}

function contentFromSummary(summary: NormalizedOmxRuntimeSummary): string {
  const parts = [
    summary.quota_warning ? `quota=${summary.quota_warning}` : '',
    summary.runtime_model_error ? `runtime_error=${summary.runtime_model_error}` : '',
    summary.last_failed_tool
      ? `failed_tool=${summary.last_failed_tool.name ?? 'unknown'}${summary.last_failed_tool.error ? `: ${summary.last_failed_tool.error}` : ''}`
      : '',
    summary.last_prompt_summary ? `prompt=${summary.last_prompt_summary}` : '',
    summary.local_working_note ? `note=${summary.local_working_note}` : '',
    summary.active_file_focus.length ? `files=${summary.active_file_focus.join(',')}` : '',
  ].filter(Boolean);
  return `omx runtime summary: ${parts.join('; ') || 'no warnings'}`;
}

function normalizeFailedTool(value: unknown): { name: string | null; error: string | null } | null {
  if (!value) return null;
  if (typeof value === 'string') return { name: null, error: compact(value, FIELD_LIMIT) };
  if (!isRecord(value)) return null;
  const name = compactText(value.name ?? value.tool ?? value.tool_name, 80);
  const error = compactText(value.error ?? value.message ?? value.stderr, FIELD_LIMIT);
  if (!name && !error) return null;
  return { name, error };
}

function normalizeFileFocus(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return raw
    .map((entry) => compactText(entry, FIELD_LIMIT))
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, FILE_LIMIT);
}

function timestampMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function shortString(value: unknown): string | undefined {
  const text = compactText(value, FIELD_LIMIT);
  return text ?? undefined;
}

function compactText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const text = compact(value, limit);
  return text || null;
}

function compact(value: string, limit: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 3).trimEnd()}...` : text;
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => {
      if (value === null || value === undefined) return false;
      if (typeof value === 'string') return value.trim() !== '';
      if (Array.isArray(value)) return value.length > 0;
      return true;
    }),
  );
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function safeRecord(raw: string): OmxRuntimeSummaryInput | null {
  const parsed = safeJson(raw);
  return isRecord(parsed) ? (parsed as OmxRuntimeSummaryInput) : null;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function agentFromSession(sessionId: string): string {
  const prefix = sessionId.split(/[@:/_-]/)[0]?.toLowerCase();
  if (prefix === 'claude') return 'claude';
  if (prefix === 'codex') return 'codex';
  return 'agent';
}
