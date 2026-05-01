import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { MemoryStore } from './memory-store.js';

const FIELD_LIMIT = 240;
const NOTE_LIMIT = 320;
const FILE_LIMIT = 8;
export const COLONY_RUNTIME_SUMMARY_SCHEMA = 'colony-runtime-summary-v1';
export const DEFAULT_OMX_RUNTIME_SUMMARY_STALE_MS = 15 * 60_000;

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
  active_sessions?: unknown;
  recent_edit_paths?: unknown;
  edit_paths?: unknown;
  extracted_paths?: unknown;
  warnings?: unknown;
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

export type OmxRuntimeBridgeStatus = 'available' | 'stale' | 'unavailable';

export interface OmxRuntimeSummaryHealthStats {
  status: OmxRuntimeBridgeStatus;
  summaries_ingested: number;
  latest_summary_ts: number | null;
  warning_count: number;
  active_sessions: number;
  recent_edit_paths: string[];
  malformed_summary_count: number;
  sources: string[];
}

export interface DiscoverOmxRuntimeSummaryStatsOptions {
  repoRoot?: string;
  since?: number;
  now?: number;
  staleMs?: number;
  globalSummaryDir?: string | null;
  paths?: string[];
}

export function normalizeOmxRuntimeSummary(
  input: OmxRuntimeSummaryInput,
  defaults: { repoRoot?: string; sessionId?: string; agent?: string; branch?: string } = {},
): NormalizedOmxRuntimeSummary | null {
  const sessionId = shortString(input.session_id) ?? defaults.sessionId;
  if (!sessionId) return null;
  const repoRoot = shortString(input.repo_root) ?? defaults.repoRoot ?? null;
  const branch = shortString(input.branch) ?? defaults.branch ?? null;
  const runtimeModelError = compactText(
    input.runtime_model_error ?? input.model_error,
    FIELD_LIMIT,
  );
  const failedTool = normalizeFailedTool(input.last_failed_tool);
  const summary: NormalizedOmxRuntimeSummary = {
    session_id: sessionId,
    agent: shortString(input.agent) ?? defaults.agent ?? agentFromSession(sessionId),
    repo_root: repoRoot ? resolve(repoRoot) : null,
    branch,
    task_id:
      typeof input.task_id === 'number' && Number.isInteger(input.task_id) ? input.task_id : null,
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

export function defaultColonyRuntimeSummaryPaths(options: {
  repoRoot?: string;
  globalSummaryDir?: string | null;
}): string[] {
  const paths: string[] = [];
  if (options.repoRoot) {
    paths.push(join(resolve(options.repoRoot), '.omx', 'state', 'colony-runtime-summary.json'));
  }
  const summaryDir =
    options.globalSummaryDir === null
      ? null
      : (options.globalSummaryDir ?? join(homedir(), '.omx', 'colony', 'runtime-summaries'));
  if (summaryDir && existsSync(summaryDir)) {
    for (const entry of readdirSync(summaryDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        paths.push(join(summaryDir, entry.name));
      }
    }
  }
  return Array.from(new Set(paths));
}

export function discoverOmxRuntimeSummaryStats(
  options: DiscoverOmxRuntimeSummaryStatsOptions = {},
): OmxRuntimeSummaryHealthStats {
  const since = options.since ?? 0;
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? DEFAULT_OMX_RUNTIME_SUMMARY_STALE_MS;
  const paths =
    options.paths ??
    defaultColonyRuntimeSummaryPaths({
      ...(options.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
      ...(options.globalSummaryDir !== undefined
        ? { globalSummaryDir: options.globalSummaryDir }
        : {}),
    });
  const sessionIds = new Set<string>();
  const editPaths: string[] = [];
  const sources = new Set<string>();
  let summariesIngested = 0;
  let latestSummaryTs: number | null = null;
  let warningCount = 0;
  let malformedSummaryCount = 0;

  for (const path of paths) {
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    const parsed = safeJson(readFileSync(path, 'utf8'));
    const records = Array.isArray(parsed) ? parsed : [parsed];
    for (const record of records) {
      const validation = validateColonyRuntimeSummaryRecord(record, path);
      if (!validation.ok) {
        malformedSummaryCount++;
        warningCount++;
        sources.add(path);
        continue;
      }
      for (const input of validation.summaries) {
        const normalized = normalizeOmxRuntimeSummary(input, {
          ...(options.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
        });
        if (!normalized || normalized.ts <= since) continue;
        summariesIngested++;
        sources.add(path);
        sessionIds.add(normalized.session_id);
        for (const sessionId of normalizeActiveSessions(input.active_sessions)) {
          sessionIds.add(sessionId);
        }
        latestSummaryTs =
          latestSummaryTs === null ? normalized.ts : Math.max(latestSummaryTs, normalized.ts);
        warningCount += normalized.warnings.length + normalizeWarningList(input.warnings).length;
        for (const filePath of normalizeRecentEditPaths(input)) {
          if (!editPaths.includes(filePath)) editPaths.push(filePath);
        }
      }
    }
  }

  const status = runtimeBridgeStatus({
    summaries_ingested: summariesIngested,
    latest_summary_ts: latestSummaryTs,
    now,
    staleMs,
  });
  return {
    status,
    summaries_ingested: summariesIngested,
    latest_summary_ts: latestSummaryTs,
    warning_count: warningCount,
    active_sessions: sessionIds.size,
    recent_edit_paths: editPaths.slice(0, FILE_LIMIT),
    malformed_summary_count: malformedSummaryCount,
    sources: [...sources],
  };
}

export function mergeOmxRuntimeSummaryStats(
  stats: Array<Partial<OmxRuntimeSummaryHealthStats> | null | undefined>,
  options: { now?: number; staleMs?: number } = {},
): OmxRuntimeSummaryHealthStats {
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? DEFAULT_OMX_RUNTIME_SUMMARY_STALE_MS;
  const sessions = new Set<string>();
  const paths: string[] = [];
  const sources: string[] = [];
  let summariesIngested = 0;
  let latestSummaryTs: number | null = null;
  let warningCount = 0;
  let malformedSummaryCount = 0;

  for (const stat of stats) {
    if (!stat) continue;
    summariesIngested += stat.summaries_ingested ?? 0;
    warningCount += stat.warning_count ?? 0;
    malformedSummaryCount += stat.malformed_summary_count ?? 0;
    if (stat.latest_summary_ts !== undefined && stat.latest_summary_ts !== null) {
      latestSummaryTs =
        latestSummaryTs === null
          ? stat.latest_summary_ts
          : Math.max(latestSummaryTs, stat.latest_summary_ts);
    }
    for (const source of stat.sources ?? []) {
      if (!sources.includes(source)) sources.push(source);
    }
    for (const filePath of stat.recent_edit_paths ?? []) {
      if (!paths.includes(filePath)) paths.push(filePath);
    }
    if (typeof stat.active_sessions === 'number' && stat.active_sessions > 0) {
      for (let i = 0; i < stat.active_sessions; i++) sessions.add(`stat:${sources.length}:${i}`);
    }
  }

  return {
    status: runtimeBridgeStatus({
      summaries_ingested: summariesIngested,
      latest_summary_ts: latestSummaryTs,
      now,
      staleMs,
    }),
    summaries_ingested: summariesIngested,
    latest_summary_ts: latestSummaryTs,
    warning_count: warningCount,
    active_sessions: sessions.size,
    recent_edit_paths: paths.slice(0, FILE_LIMIT),
    malformed_summary_count: malformedSummaryCount,
    sources,
  };
}

function validateColonyRuntimeSummaryRecord(
  record: unknown,
  path: string,
): { ok: true; summaries: OmxRuntimeSummaryInput[] } | { ok: false; error: string } {
  if (!isRecord(record)) return { ok: false, error: `${path}: expected object` };
  const schema = shortString(record.schema ?? record.schema_version);
  if (schema !== COLONY_RUNTIME_SUMMARY_SCHEMA) {
    return { ok: false, error: `${path}: expected schema ${COLONY_RUNTIME_SUMMARY_SCHEMA}` };
  }
  const candidates = summaryCandidates(record);
  if (candidates.length === 0) return { ok: false, error: `${path}: missing summary object` };
  return { ok: true, summaries: candidates };
}

function summaryCandidates(record: JsonRecord): OmxRuntimeSummaryInput[] {
  const inherited = {
    repo_root: record.repo_root,
    branch: record.branch,
    timestamp: record.timestamp,
  };
  const raw =
    Array.isArray(record.summaries) && record.summaries.length > 0
      ? record.summaries
      : Array.isArray(record.sessions) && record.sessions.length > 0
        ? record.sessions
        : isRecord(record.summary)
          ? [record.summary]
          : [record];
  return raw
    .filter(isRecord)
    .map((entry) => compactObject({ ...inherited, ...entry }) as OmxRuntimeSummaryInput);
}

function runtimeBridgeStatus(input: {
  summaries_ingested: number;
  latest_summary_ts: number | null;
  now: number;
  staleMs: number;
}): OmxRuntimeBridgeStatus {
  if (input.summaries_ingested <= 0 || input.latest_summary_ts === null) return 'unavailable';
  return input.now - input.latest_summary_ts > input.staleMs ? 'stale' : 'available';
}

function normalizeActiveSessions(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'number'
      ? new Array(value).fill(null)
      : [];
  return raw
    .map((entry, index) => {
      if (typeof entry === 'string') return compactText(entry, FIELD_LIMIT);
      if (isRecord(entry))
        return compactText(entry.session_id ?? entry.id ?? entry.session, FIELD_LIMIT);
      return typeof value === 'number' ? `active-${index}` : null;
    })
    .filter((entry): entry is string => Boolean(entry));
}

function normalizeWarningList(value: unknown): string[] {
  return (Array.isArray(value) ? value : [])
    .map((entry) => compactText(entry, FIELD_LIMIT))
    .filter((entry): entry is string => Boolean(entry));
}

function normalizeRecentEditPaths(input: OmxRuntimeSummaryInput): string[] {
  return normalizeFileFocus(
    input.recent_edit_paths ?? input.edit_paths ?? input.extracted_paths ?? input.active_file_focus,
  );
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
