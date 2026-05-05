import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { MemoryStore } from './memory-store.js';

const FIELD_LIMIT = 240;
const NOTE_LIMIT = 320;
const FILE_LIMIT = 8;
const MALFORMED_SUMMARY_EXAMPLE_LIMIT = 5;
const MALFORMED_SUMMARY_ERROR_LIMIT = 20;
export const COLONY_RUNTIME_SUMMARY_SCHEMA = 'colony-runtime-summary-v1';
export const DEFAULT_OMX_RUNTIME_SUMMARY_STALE_MS = 15 * 60_000;

type JsonRecord = Record<string, unknown>;
type JsonPrimitive = string | number | boolean | null;

export interface OmxRuntimeSummaryInput {
  session_id?: string;
  agent?: string;
  repo_root?: string;
  branch?: string;
  task_id?: number;
  timestamp?: string | number;
  last_seen_at?: unknown;
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
  lifecycle_events?: unknown;
  recent_lifecycle_events?: unknown;
  events?: unknown;
  tool_events?: unknown;
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

export interface OmxRuntimeMalformedSummaryFieldType {
  field: string;
  expected: string;
  actual: string;
}

export interface OmxRuntimeMalformedSummaryExample {
  path: string;
  error: string;
  schema_value: JsonPrimitive;
  missing_required_fields: string[];
  invalid_field_types: OmxRuntimeMalformedSummaryFieldType[];
  modified_time: string | null;
  modified_time_ms: number | null;
}

export interface OmxRuntimeSummaryHealthStats {
  status: OmxRuntimeBridgeStatus;
  summaries_ingested: number;
  latest_summary_ts: number | null;
  warning_count: number;
  active_sessions: number;
  recent_edit_paths: string[];
  claim_before_edit: OmxRuntimeSummaryClaimBeforeEditStats;
  malformed_summary_count: number;
  malformed_summary_examples: OmxRuntimeMalformedSummaryExample[];
  malformed_summary_errors: string[];
  sources: string[];
}

export interface OmxRuntimeSummaryClaimBeforeEditStats {
  hook_capable_edits: number;
  pre_tool_use_signals: number;
  measurable_edits: number;
  edits_claimed_before: number;
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
    ts: timestampMs(input.last_seen_at ?? input.timestamp),
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
    ts: Math.max(summary.ts, Date.now()),
    task_id: taskId,
    metadata: compactObject({
      kind: 'omx-runtime-summary',
      source: 'omx',
      agent: summary.agent,
      repo_root: summary.repo_root,
      branch: summary.branch,
      summary_ts: summary.ts,
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
  const claimBeforeEdit = emptyRuntimeClaimBeforeEditStats();
  const malformedSummaryExamples: OmxRuntimeMalformedSummaryExample[] = [];
  const malformedSummaryErrors: string[] = [];

  function recordMalformed(example: OmxRuntimeMalformedSummaryExample): void {
    malformedSummaryCount++;
    warningCount++;
    sources.add(example.path);
    if (malformedSummaryExamples.length < MALFORMED_SUMMARY_EXAMPLE_LIMIT) {
      malformedSummaryExamples.push(example);
    }
    if (malformedSummaryErrors.length < MALFORMED_SUMMARY_ERROR_LIMIT) {
      malformedSummaryErrors.push(example.error);
    }
  }

  for (const path of paths) {
    if (!existsSync(path)) continue;
    const fileStat = statSync(path);
    if (!fileStat.isFile()) continue;
    const source = summaryDiagnosticSource(path, fileStat.mtimeMs);
    const parsed = parseJson(readFileSync(path, 'utf8'));
    if (!parsed.ok) {
      recordMalformed(
        malformedSummaryExample(source, {
          error: `${path}: invalid JSON: ${parsed.error}`,
          schemaValue: null,
          missingRequiredFields: [],
          invalidFieldTypes: [],
        }),
      );
      continue;
    }
    const records = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
    for (const record of records) {
      const validation = validateColonyRuntimeSummaryRecord(record, source);
      if (!validation.ok) {
        recordMalformed(validation.example);
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
        const freshnessTs = runtimeSummaryFreshnessTs(input, normalized.ts, source.modifiedTimeMs);
        latestSummaryTs =
          latestSummaryTs === null ? freshnessTs : Math.max(latestSummaryTs, freshnessTs);
        warningCount += normalized.warnings.length + normalizeWarningList(input.warnings).length;
        for (const filePath of normalizeRecentEditPaths(input)) {
          if (!editPaths.includes(filePath)) editPaths.push(filePath);
        }
        mergeRuntimeClaimBeforeEditStats(
          claimBeforeEdit,
          runtimeClaimBeforeEditStatsFromSummary(input),
        );
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
    claim_before_edit: claimBeforeEdit,
    malformed_summary_count: malformedSummaryCount,
    malformed_summary_examples: malformedSummaryExamples,
    malformed_summary_errors: malformedSummaryErrors,
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
  const malformedSummaryExamples: OmxRuntimeMalformedSummaryExample[] = [];
  const malformedSummaryErrors: string[] = [];
  let summariesIngested = 0;
  let latestSummaryTs: number | null = null;
  let warningCount = 0;
  let malformedSummaryCount = 0;
  const claimBeforeEdit = emptyRuntimeClaimBeforeEditStats();

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
    mergeRuntimeClaimBeforeEditStats(claimBeforeEdit, stat.claim_before_edit);
    for (const example of stat.malformed_summary_examples ?? []) {
      if (malformedSummaryExamples.length >= MALFORMED_SUMMARY_EXAMPLE_LIMIT) break;
      malformedSummaryExamples.push(example);
    }
    for (const error of stat.malformed_summary_errors ?? []) {
      if (malformedSummaryErrors.length >= MALFORMED_SUMMARY_ERROR_LIMIT) break;
      malformedSummaryErrors.push(error);
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
    claim_before_edit: claimBeforeEdit,
    malformed_summary_count: malformedSummaryCount,
    malformed_summary_examples: malformedSummaryExamples,
    malformed_summary_errors: malformedSummaryErrors,
    sources,
  };
}

interface SummaryDiagnosticSource {
  path: string;
  modifiedTime: string | null;
  modifiedTimeMs: number | null;
}

function validateColonyRuntimeSummaryRecord(
  record: unknown,
  source: SummaryDiagnosticSource,
):
  | { ok: true; summaries: OmxRuntimeSummaryInput[] }
  | { ok: false; example: OmxRuntimeMalformedSummaryExample } {
  if (!isRecord(record)) {
    return {
      ok: false,
      example: malformedSummaryExample(source, {
        error: `${source.path}: expected object`,
        schemaValue: null,
        missingRequiredFields: [],
        invalidFieldTypes: [{ field: '$', expected: 'object', actual: typeDescription(record) }],
      }),
    };
  }
  const candidates = summaryCandidates(record);
  const details = validateSummaryRecordDetails(record, candidates);
  const error = summaryValidationError(source.path, details, candidates.length);
  if (error) {
    return {
      ok: false,
      example: malformedSummaryExample(source, {
        error,
        schemaValue: details.schemaValue,
        missingRequiredFields: details.missingRequiredFields,
        invalidFieldTypes: details.invalidFieldTypes,
      }),
    };
  }
  return { ok: true, summaries: candidates };
}

function summaryCandidates(record: JsonRecord): OmxRuntimeSummaryInput[] {
  const inherited = {
    repo_root: record.repo_root,
    branch: record.branch,
    timestamp: record.timestamp,
    last_seen_at: record.last_seen_at,
    lifecycle_events:
      record.lifecycle_events ??
      record.recent_lifecycle_events ??
      record.events ??
      record.tool_events,
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

function summaryDiagnosticSource(path: string, modifiedTimeMs: number): SummaryDiagnosticSource {
  return {
    path,
    modifiedTime: Number.isFinite(modifiedTimeMs) ? new Date(modifiedTimeMs).toISOString() : null,
    modifiedTimeMs: Number.isFinite(modifiedTimeMs) ? modifiedTimeMs : null,
  };
}

function malformedSummaryExample(
  source: SummaryDiagnosticSource,
  input: {
    error: string;
    schemaValue: JsonPrimitive;
    missingRequiredFields: string[];
    invalidFieldTypes: OmxRuntimeMalformedSummaryFieldType[];
  },
): OmxRuntimeMalformedSummaryExample {
  return {
    path: source.path,
    error: input.error,
    schema_value: input.schemaValue,
    missing_required_fields: input.missingRequiredFields,
    invalid_field_types: input.invalidFieldTypes,
    modified_time: source.modifiedTime,
    modified_time_ms: source.modifiedTimeMs,
  };
}

function validateSummaryRecordDetails(
  record: JsonRecord,
  candidates: OmxRuntimeSummaryInput[],
): {
  schemaValue: JsonPrimitive;
  schema: string | null;
  missingRequiredFields: string[];
  invalidFieldTypes: OmxRuntimeMalformedSummaryFieldType[];
} {
  const missing = new Set<string>();
  const invalid: OmxRuntimeMalformedSummaryFieldType[] = [];
  const rawSchema = record.schema ?? record.schema_version;
  const schemaValue = schemaValueFromRecord(record);
  const schema = shortString(rawSchema) ?? null;

  if (!hasOwn(record, 'schema') && !hasOwn(record, 'schema_version')) {
    missing.add('schema');
  } else if (typeof rawSchema !== 'string') {
    invalid.push({ field: 'schema', expected: 'string', actual: typeDescription(rawSchema) });
  } else if (!rawSchema.trim()) {
    missing.add('schema');
  }

  for (const candidate of candidates) {
    validateRequiredString(candidate, 'session_id', missing, invalid);
    validateRequiredString(candidate, 'repo_root', missing, invalid);
    validateLastSeenAt(candidate, missing, invalid);
  }

  return {
    schemaValue,
    schema,
    missingRequiredFields: [...missing],
    invalidFieldTypes: invalid,
  };
}

function summaryValidationError(
  path: string,
  details: ReturnType<typeof validateSummaryRecordDetails>,
  candidateCount: number,
): string | null {
  if (details.missingRequiredFields.length > 0) {
    return `${path}: missing required fields: ${details.missingRequiredFields.join(', ')}`;
  }
  if (details.invalidFieldTypes.length > 0) {
    const summary = details.invalidFieldTypes
      .map((item) => `${item.field} expected ${item.expected} got ${item.actual}`)
      .join('; ');
    return `${path}: invalid field types: ${summary}`;
  }
  if (details.schema !== COLONY_RUNTIME_SUMMARY_SCHEMA) {
    return `${path}: expected schema ${COLONY_RUNTIME_SUMMARY_SCHEMA}, got ${formatSchemaValue(details.schemaValue)}`;
  }
  if (candidateCount === 0) return `${path}: missing summary object`;
  return null;
}

function validateRequiredString(
  record: OmxRuntimeSummaryInput,
  field: 'session_id' | 'repo_root',
  missing: Set<string>,
  invalid: OmxRuntimeMalformedSummaryFieldType[],
): void {
  if (!hasOwn(record, field)) {
    missing.add(field);
    return;
  }
  const value = record[field];
  if (typeof value !== 'string') {
    invalid.push({ field, expected: 'non-empty string', actual: typeDescription(value) });
    return;
  }
  if (!value.trim()) missing.add(field);
}

function validateLastSeenAt(
  record: OmxRuntimeSummaryInput,
  missing: Set<string>,
  invalid: OmxRuntimeMalformedSummaryFieldType[],
): void {
  const value = record.last_seen_at ?? record.timestamp;
  if (value === undefined) {
    missing.add('last_seen_at');
    return;
  }
  if (!isValidTimestampValue(value)) {
    invalid.push({
      field: 'last_seen_at',
      expected: 'valid ISO timestamp string or epoch milliseconds',
      actual: typeDescription(value),
    });
  }
}

function isValidTimestampValue(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return Number.isFinite(Date.parse(value));
  return false;
}

function schemaValueFromRecord(record: JsonRecord): JsonPrimitive {
  const value = record.schema ?? record.schema_version ?? record.version ?? null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return null;
}

function formatSchemaValue(value: JsonPrimitive): string {
  if (value === null) return 'null';
  return String(value);
}

function hasOwn(record: object, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
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

function runtimeSummaryFreshnessTs(
  input: OmxRuntimeSummaryInput,
  summaryTs: number,
  sourceModifiedTimeMs: number | null,
): number {
  let latest = summaryTs;
  const latestLifecycleEventTs = latestRuntimeLifecycleEventTs(input);
  if (latestLifecycleEventTs !== null) latest = Math.max(latest, latestLifecycleEventTs);
  if (sourceModifiedTimeMs !== null && hasRuntimeActivityData(input)) {
    latest = Math.max(latest, sourceModifiedTimeMs);
  }
  return latest;
}

function latestRuntimeLifecycleEventTs(input: OmxRuntimeSummaryInput): number | null {
  let latest: number | null = null;
  for (const event of normalizeRuntimeLifecycleEvents(input)) {
    if (event.ts === null) continue;
    latest = latest === null ? event.ts : Math.max(latest, event.ts);
  }
  return latest;
}

function hasRuntimeActivityData(input: OmxRuntimeSummaryInput): boolean {
  return (
    normalizeRuntimeLifecycleEvents(input).length > 0 ||
    normalizeRecentEditPaths(input).length > 0 ||
    normalizeActiveSessions(input.active_sessions).length > 0 ||
    normalizeFileFocus(input.active_file_focus).length > 0
  );
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

interface RuntimeLifecycleSummaryEvent {
  event_type: 'pre_tool_use' | 'post_tool_use';
  event_id: string | null;
  parent_event_id: string | null;
  ts: number | null;
  order: number;
  paths: string[];
}

function runtimeClaimBeforeEditStatsFromSummary(
  input: OmxRuntimeSummaryInput,
): OmxRuntimeSummaryClaimBeforeEditStats {
  const events = normalizeRuntimeLifecycleEvents(input);
  if (events.length === 0) return emptyRuntimeClaimBeforeEditStats();

  const preEvents = events.filter((event) => event.event_type === 'pre_tool_use');
  const postEvents = events.filter((event) => event.event_type === 'post_tool_use');
  const preToolUseSignals = preEvents.reduce((count, event) => count + event.paths.length, 0);
  let coveredEdits = 0;

  for (const postEvent of postEvents) {
    coveredEdits += coveredPostToolUsePathCount(postEvent, preEvents);
  }

  return {
    hook_capable_edits: coveredEdits,
    pre_tool_use_signals: preToolUseSignals,
    measurable_edits: coveredEdits,
    edits_claimed_before: coveredEdits,
  };
}

function normalizeRuntimeLifecycleEvents(
  input: OmxRuntimeSummaryInput,
): RuntimeLifecycleSummaryEvent[] {
  const raw =
    input.lifecycle_events ?? input.recent_lifecycle_events ?? input.events ?? input.tool_events;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry, order) => normalizeRuntimeLifecycleEvent(entry, order))
    .filter((event): event is RuntimeLifecycleSummaryEvent => event !== null);
}

function normalizeRuntimeLifecycleEvent(
  value: unknown,
  order: number,
): RuntimeLifecycleSummaryEvent | null {
  if (!isRecord(value)) return null;
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const eventType = normalizeRuntimeLifecycleEventType(
    value.event_type ?? value.event_name ?? value.type ?? value.kind ?? metadata.event_type,
  );
  if (!eventType) return null;
  const paths = normalizeFileFocus(
    value.extracted_paths ??
      value.file_paths ??
      value.file_path ??
      value.path ??
      value.recent_edit_paths ??
      value.edit_paths ??
      metadata.extracted_paths ??
      metadata.file_paths ??
      metadata.file_path,
  );
  if (paths.length === 0) return null;
  return {
    event_type: eventType,
    event_id: shortString(value.event_id ?? value.id ?? metadata.event_id) ?? null,
    parent_event_id:
      shortString(value.parent_event_id ?? value.parent_id ?? metadata.parent_event_id) ?? null,
    ts: optionalTimestampMs(
      value.ts ?? value.timestamp ?? value.created_at ?? value.started_at ?? metadata.ts,
    ),
    order,
    paths,
  };
}

function normalizeRuntimeLifecycleEventType(
  value: unknown,
): RuntimeLifecycleSummaryEvent['event_type'] | null {
  const normalized = shortString(value)?.toLowerCase().replace(/-/g, '_');
  if (normalized === 'pretooluse') return 'pre_tool_use';
  if (normalized === 'posttooluse') return 'post_tool_use';
  if (normalized === 'pre_tool_use') return 'pre_tool_use';
  if (normalized === 'post_tool_use') return 'post_tool_use';
  return null;
}

function coveredPostToolUsePathCount(
  postEvent: RuntimeLifecycleSummaryEvent,
  preEvents: RuntimeLifecycleSummaryEvent[],
): number {
  let covered = 0;
  for (const filePath of postEvent.paths) {
    if (preEvents.some((preEvent) => preToolUseCoversPostPath(preEvent, postEvent, filePath))) {
      covered++;
    }
  }
  return covered;
}

function preToolUseCoversPostPath(
  preEvent: RuntimeLifecycleSummaryEvent,
  postEvent: RuntimeLifecycleSummaryEvent,
  filePath: string,
): boolean {
  if (!preEvent.paths.includes(filePath)) return false;
  if (postEvent.parent_event_id && preEvent.event_id === postEvent.parent_event_id) return true;
  if (preEvent.order >= postEvent.order) return false;
  if (preEvent.ts !== null && postEvent.ts !== null && preEvent.ts > postEvent.ts) return false;
  return true;
}

function emptyRuntimeClaimBeforeEditStats(): OmxRuntimeSummaryClaimBeforeEditStats {
  return {
    hook_capable_edits: 0,
    pre_tool_use_signals: 0,
    measurable_edits: 0,
    edits_claimed_before: 0,
  };
}

function mergeRuntimeClaimBeforeEditStats(
  target: OmxRuntimeSummaryClaimBeforeEditStats,
  source: Partial<OmxRuntimeSummaryClaimBeforeEditStats> | null | undefined,
): void {
  if (!source) return;
  target.hook_capable_edits += source.hook_capable_edits ?? 0;
  target.pre_tool_use_signals += source.pre_tool_use_signals ?? 0;
  target.measurable_edits += source.measurable_edits ?? 0;
  target.edits_claimed_before += source.edits_claimed_before ?? 0;
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

function optionalTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
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

function parseJson(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function safeJson(raw: string): unknown {
  const parsed = parseJson(raw);
  return parsed.ok ? parsed.value : null;
}

function safeRecord(raw: string): OmxRuntimeSummaryInput | null {
  const parsed = safeJson(raw);
  return isRecord(parsed) ? (parsed as OmxRuntimeSummaryInput) : null;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function typeDescription(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function agentFromSession(sessionId: string): string {
  const prefix = sessionId.split(/[@:/_-]/)[0]?.toLowerCase();
  if (prefix === 'claude') return 'claude';
  if (prefix === 'codex') return 'codex';
  return 'agent';
}
