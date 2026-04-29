import path, { join } from 'node:path';
import { loadSettings, resolveDataDir } from '@colony/config';
import { MemoryStore, TaskThread, inferIdeFromSessionId } from '@colony/core';
import type { ObservationRow } from '@colony/storage';
import { extractTouchedFiles } from './handlers/post-tool-use.js';
import { runHook } from './runner.js';
import type { HookInput, HookName } from './types.js';

export const OMX_LIFECYCLE_SCHEMA = 'colony-omx-lifecycle-v1';
export const OMX_LIFECYCLE_SCHEMA_ID =
  'https://schemas.colony.local/colony-omx-lifecycle-v1.schema.json';

export type OmxLifecycleEventType =
  | 'session_start'
  | 'task_bind'
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'claim_result'
  | 'stop_intent'
  | 'finish_result';

export interface NormalizedOmxLifecycleEvent {
  schema: typeof OMX_LIFECYCLE_SCHEMA;
  event_id: string;
  parent_event_id?: string;
  event_type: OmxLifecycleEventType;
  session_id: string;
  agent: string;
  ide: string;
  cwd: string;
  repo_root: string;
  branch: string;
  timestamp: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  source: string;
  metadata: Record<string, unknown>;
}

export type ParseOmxLifecycleEnvelopeResult =
  | { ok: true; event: NormalizedOmxLifecycleEvent }
  | { ok: false; error: string };

export interface RunOmxLifecycleEnvelopeOptions {
  store?: MemoryStore;
  defaultCwd?: string;
  ide?: string;
}

export interface OmxLifecycleRunResult {
  ok: boolean;
  ms: number;
  event_id?: string;
  event_type?: OmxLifecycleEventType;
  route?: string;
  duplicate?: boolean;
  context?: string;
  extracted_paths?: string[];
  error?: string;
}

type JsonRecord = Record<string, unknown>;

const EVENT_TYPES = new Set<OmxLifecycleEventType>([
  'session_start',
  'task_bind',
  'pre_tool_use',
  'post_tool_use',
  'claim_result',
  'stop_intent',
  'finish_result',
]);

export function isOmxLifecycleEnvelopeLike(value: unknown): boolean {
  const root = asRecord(value);
  if (!root) return false;
  const schema = readEnvelopeSchema(root);
  if (schema && schema !== OMX_LIFECYCLE_SCHEMA && schema !== OMX_LIFECYCLE_SCHEMA_ID) return false;
  return EVENT_TYPES.has(root.event_name as OmxLifecycleEventType);
}

export function parseOmxLifecycleEnvelope(
  value: unknown,
  options: Pick<RunOmxLifecycleEnvelopeOptions, 'defaultCwd' | 'ide'> = {},
): ParseOmxLifecycleEnvelopeResult {
  try {
    const root = asRecord(value);
    if (!root) return { ok: false, error: 'lifecycle envelope must be a JSON object' };
    if (!isOmxLifecycleEnvelopeLike(root)) {
      return { ok: false, error: `expected ${OMX_LIFECYCLE_SCHEMA} envelope` };
    }

    const eventId = readString(root.event_id);
    if (!eventId) return { ok: false, error: 'missing event_id' };
    const parentEventId = readString(root.parent_event_id);

    const eventType = root.event_name as OmxLifecycleEventType;
    const sessionId = readString(root.session_id);
    if (!sessionId) return { ok: false, error: 'missing session_id' };

    const agent = normalizeAgent(readString(root.agent) ?? inferIdeFromSessionId(sessionId));
    const cwd = normalizeFilePath(readRequiredString(root.cwd, 'cwd'), options.defaultCwd);
    const repoRoot = normalizeFilePath(readRequiredString(root.repo_root, 'repo_root'), cwd);
    const branch = readRequiredString(root.branch, 'branch');
    const timestamp = readRequiredString(root.timestamp, 'timestamp');
    if (Number.isNaN(Date.parse(timestamp))) return { ok: false, error: 'invalid timestamp' };
    const source = readRequiredString(root.source, 'source');
    const toolName = readString(root.tool_name);
    const toolInput = root.tool_input;
    const result = asRecord(root.result);

    if ((eventType === 'pre_tool_use' || eventType === 'post_tool_use') && !toolName) {
      return { ok: false, error: 'missing tool_name' };
    }
    if (
      (eventType === 'pre_tool_use' || eventType === 'post_tool_use') &&
      !Object.prototype.hasOwnProperty.call(root, 'tool_input')
    ) {
      return { ok: false, error: 'missing tool_input' };
    }

    const metadata = {
      schema: OMX_LIFECYCLE_SCHEMA,
      schema_id: OMX_LIFECYCLE_SCHEMA_ID,
      event_id: eventId,
      ...optionalString('parent_event_id', parentEventId),
      event_type: eventType,
      event_name: eventType,
      source,
      agent,
      repo_root: repoRoot,
      branch,
      timestamp,
      ...(result ? { result } : {}),
    };

    return {
      ok: true,
      event: {
        schema: OMX_LIFECYCLE_SCHEMA,
        event_id: eventId,
        ...optionalString('parent_event_id', parentEventId),
        event_type: eventType,
        session_id: sessionId,
        agent,
        ide: options.ide?.trim() || ideForAgent(agent),
        cwd,
        repo_root: repoRoot,
        branch,
        timestamp,
        ...optionalString('tool_name', toolName),
        ...(Object.prototype.hasOwnProperty.call(root, 'tool_input')
          ? { tool_input: toolInput }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(root, 'tool_response')
          ? { tool_response: root.tool_response }
          : {}),
        source,
        metadata,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runOmxLifecycleEnvelope(
  value: unknown,
  options: RunOmxLifecycleEnvelopeOptions = {},
): Promise<OmxLifecycleRunResult> {
  const start = performance.now();
  const parsed = parseOmxLifecycleEnvelope(value, options);
  if (!parsed.ok) return { ok: false, ms: elapsed(start), error: parsed.error };

  const event = parsed.event;
  const injected = options.store !== undefined;
  let store: MemoryStore;
  if (options.store) {
    store = options.store;
  } else {
    const settings = loadSettings();
    store = new MemoryStore({
      dbPath: join(resolveDataDir(settings.dataDir), 'data.db'),
      settings,
    });
  }

  try {
    store.startSession({
      id: event.session_id,
      ide: event.ide,
      cwd: event.cwd,
      metadata: {
        source: 'omx-lifecycle',
        agent: event.agent,
        repo_root: event.repo_root,
        branch: event.branch,
      },
    });

    if (hasProcessedLifecycleEvent(store, event.event_id, event.session_id)) {
      return {
        ok: true,
        ms: elapsed(start),
        event_id: event.event_id,
        event_type: event.event_type,
        route: 'duplicate',
        duplicate: true,
      };
    }

    const routed = await routeLifecycleEvent(store, event);
    recordLifecycleAudit(store, event, routed);
    const result: OmxLifecycleRunResult = {
      ok: routed.ok,
      ms: elapsed(start),
      event_id: event.event_id,
      event_type: event.event_type,
      route: routed.route,
    };
    if (routed.context !== undefined) result.context = routed.context;
    if (routed.extracted_paths !== undefined) result.extracted_paths = routed.extracted_paths;
    if (routed.error !== undefined) result.error = routed.error;
    return result;
  } catch (err) {
    return {
      ok: false,
      ms: elapsed(start),
      event_id: event.event_id,
      event_type: event.event_type,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (!injected) store.close();
  }
}

async function routeLifecycleEvent(
  store: MemoryStore,
  event: NormalizedOmxLifecycleEvent,
): Promise<{
  ok: boolean;
  route: string;
  context?: string;
  extracted_paths?: string[];
  error?: string;
}> {
  if (event.event_type === 'task_bind') return bindTaskFromLifecycle(store, event);
  if (event.event_type === 'claim_result') {
    bindTaskFromLifecycle(store, event);
    return { ok: true, route: 'claim_result_audit' };
  }
  if (event.event_type === 'finish_result') {
    bindTaskFromLifecycle(store, event);
    return { ok: true, route: 'finish_result_audit' };
  }

  if (event.event_type === 'session_start') {
    const result = await runHook('session-start', hookInputFromLifecycle(event), { store });
    bindTaskFromLifecycle(store, event);
    return hookRouteResult('session-start', result);
  }

  if (event.event_type === 'pre_tool_use') {
    return hookRouteResult(
      'pre-tool-use',
      await runHook('pre-tool-use', hookInputFromLifecycle(event), { store }),
    );
  }

  if (event.event_type === 'post_tool_use') {
    const preToolUse = await ensurePreToolUseBeforePostToolUse(store, event);
    if (!preToolUse.ok) return preToolUse;
    return hookRouteResult(
      'post-tool-use',
      await runHook('post-tool-use', hookInputFromLifecycle(event), { store }),
    );
  }

  bindTaskFromLifecycle(store, event);
  return hookRouteResult('stop', await runHook('stop', hookInputFromLifecycle(event), { store }));
}

async function ensurePreToolUseBeforePostToolUse(
  store: MemoryStore,
  event: NormalizedOmxLifecycleEvent,
): Promise<{
  ok: boolean;
  route: string;
  context?: string;
  extracted_paths?: string[];
  error?: string;
}> {
  const touchedFiles = extractTouchedFiles(event.tool_name ?? '', toolInputForHook(event), {
    cwd: event.cwd,
    repoRoot: event.repo_root,
  });
  if (touchedFiles.length === 0) return { ok: true, route: 'pre-tool-use-not-needed' };

  const parentEventId =
    event.parent_event_id ??
    findMatchingPreToolUseEventId(store, event, touchedFiles) ??
    syntheticPreToolUseEventId(event);
  event.parent_event_id = parentEventId;
  event.metadata = { ...event.metadata, parent_event_id: parentEventId };

  if (hasProcessedLifecycleEvent(store, parentEventId, event.session_id)) {
    return { ok: true, route: 'pre-tool-use-existing', extracted_paths: touchedFiles };
  }

  const preEvent = preToolUseEventFromPost(event, parentEventId);
  const routed = hookRouteResult(
    'pre-tool-use',
    await runHook('pre-tool-use', hookInputFromLifecycle(preEvent), { store }),
  );
  recordLifecycleAudit(store, preEvent, routed);
  if (!routed.ok) return routed;
  return { ok: true, route: 'pre-tool-use-synthesized', extracted_paths: touchedFiles };
}

function findMatchingPreToolUseEventId(
  store: MemoryStore,
  event: NormalizedOmxLifecycleEvent,
  touchedFiles: string[],
): string | undefined {
  const rows = store.storage.timeline(event.session_id, undefined, 250);
  for (const row of rows.slice().reverse()) {
    if (row.kind !== 'omx-lifecycle') continue;
    const metadata = parseMetadata(row.metadata);
    if (!metadata || metadata.event_type !== 'pre_tool_use') continue;
    if (metadata.tool_name !== event.tool_name) continue;
    const paths = stringArray(metadata.extracted_paths);
    if (paths.length > 0 && !paths.some((filePath) => touchedFiles.includes(filePath))) continue;
    return readString(metadata.event_id);
  }
  return undefined;
}

function syntheticPreToolUseEventId(event: NormalizedOmxLifecycleEvent): string {
  return `${event.event_id}:pre_tool_use`;
}

function preToolUseEventFromPost(
  event: NormalizedOmxLifecycleEvent,
  eventId: string,
): NormalizedOmxLifecycleEvent {
  return {
    schema: event.schema,
    event_id: eventId,
    event_type: 'pre_tool_use',
    session_id: event.session_id,
    agent: event.agent,
    ide: event.ide,
    cwd: event.cwd,
    repo_root: event.repo_root,
    branch: event.branch,
    timestamp: event.timestamp,
    ...optionalString('tool_name', event.tool_name),
    ...('tool_input' in event ? { tool_input: event.tool_input } : {}),
    source: event.source,
    metadata: {
      ...event.metadata,
      event_id: eventId,
      event_type: 'pre_tool_use',
      event_name: 'pre_tool_use',
      synthesized_from_event_id: event.event_id,
      synthesized_from_event_type: 'post_tool_use',
    },
  };
}

function hookRouteResult(
  route: HookName,
  result: { ok: boolean; context?: string; extracted_paths?: string[]; error?: string },
): { ok: boolean; route: string; context?: string; extracted_paths?: string[]; error?: string } {
  return {
    ok: result.ok,
    route,
    ...(result.context !== undefined ? { context: result.context } : {}),
    ...(result.extracted_paths !== undefined ? { extracted_paths: result.extracted_paths } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

function bindTaskFromLifecycle(
  store: MemoryStore,
  event: NormalizedOmxLifecycleEvent,
): { ok: boolean; route: string } {
  const thread = TaskThread.open(store, {
    repo_root: event.repo_root,
    branch: event.branch,
    session_id: event.session_id,
  });
  thread.join(event.session_id, event.agent);
  store.storage.touchTask(thread.task_id);
  return { ok: true, route: 'task_bind' };
}

function hookInputFromLifecycle(event: NormalizedOmxLifecycleEvent): HookInput {
  const input: HookInput = {
    session_id: event.session_id,
    ide: event.ide,
    cwd: event.cwd,
    source: event.source,
    metadata: event.metadata,
  };
  if (event.tool_name !== undefined) input.tool_name = event.tool_name;
  if ('tool_input' in event) input.tool_input = toolInputForHook(event);
  if ('tool_response' in event) input.tool_response = event.tool_response;

  if (event.event_type === 'stop_intent') {
    const result = asRecord(event.metadata.result);
    const reason = readString(result?.code) ?? readString(result?.message);
    const summary = readString(result?.message);
    if (reason) input.stop_reason = reason;
    if (summary) input.turn_summary = summary;
  }

  return input;
}

function toolInputForHook(event: NormalizedOmxLifecycleEvent): unknown {
  const input = asRecord(event.tool_input);
  if (!input) return event.tool_input;
  if (typeof input.file_path === 'string') return input;
  const filePath = targetPathFromLifecycleToolInput(input);
  return filePath ? { ...input, file_path: filePath } : input;
}

function targetPathFromLifecycleToolInput(input: JsonRecord): string | undefined {
  const extractedPaths = stringArray(input.extracted_paths);
  if (extractedPaths.length > 0) return extractedPaths[0];
  const paths = Array.isArray(input.paths) ? input.paths.filter(isPathRef) : [];
  const target =
    paths.find((p) => p.kind === 'file' && p.role === 'target') ??
    paths.find((p) => p.kind === 'file' && p.role === 'destination') ??
    paths.find((p) => p.kind === 'file');
  return target?.path;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
}

function hasProcessedLifecycleEvent(
  store: MemoryStore,
  eventId: string,
  sessionId: string,
): boolean {
  const rowMatches = (row: ObservationRow): boolean => {
    if (row.kind !== 'omx-lifecycle') return false;
    const metadata = parseMetadata(row.metadata);
    return metadata?.event_id === eventId;
  };
  if (store.storage.timeline(sessionId, undefined, 250).some(rowMatches)) return true;
  return (
    store.storage.searchFts(eventId, 1, {
      kind: 'omx-lifecycle',
      metadata: { event_id: eventId },
    }).length > 0
  );
}

function recordLifecycleAudit(
  store: MemoryStore,
  event: NormalizedOmxLifecycleEvent,
  routed: { ok: boolean; route: string; error?: string; extracted_paths?: string[] },
): void {
  const taskId = activeTaskIdForLifecycle(store, event);
  store.storage.insertObservation({
    session_id: event.session_id,
    kind: 'omx-lifecycle',
    content: `omx lifecycle ${event.event_id} ${event.event_type}`,
    compressed: false,
    intensity: null,
    metadata: {
      kind: 'omx-lifecycle',
      schema: OMX_LIFECYCLE_SCHEMA,
      schema_id: OMX_LIFECYCLE_SCHEMA_ID,
      event_id: event.event_id,
      parent_event_id: event.parent_event_id ?? null,
      event_type: event.event_type,
      event_name: event.event_type,
      source: event.source,
      agent: event.agent,
      cwd: event.cwd,
      repo_root: event.repo_root,
      branch: event.branch,
      timestamp: event.timestamp,
      tool_name: event.tool_name ?? null,
      route: routed.route,
      ok: routed.ok,
      ...(routed.extracted_paths?.length ? { extracted_paths: routed.extracted_paths } : {}),
      ...(routed.error ? { error: routed.error } : {}),
    },
    task_id: taskId ?? null,
    reply_to: null,
  });
  if (taskId !== undefined) store.storage.touchTask(taskId);
}

function activeTaskIdForLifecycle(
  store: MemoryStore,
  event: NormalizedOmxLifecycleEvent,
): number | undefined {
  const active = store.storage.findActiveTaskForSession(event.session_id);
  if (active !== undefined) return active;
  return store.storage.findTaskByBranch(event.repo_root, event.branch)?.id;
}

function readEnvelopeSchema(root: JsonRecord): string | undefined {
  return readString(
    firstDefined(root.schema, root.protocol, root.envelope, root.lifecycle_schema, root.$id),
  );
}

function normalizeAgent(value: string | undefined): string {
  const normalized = (value ?? 'agent').trim().toLowerCase().replaceAll('_', '-');
  if (normalized === 'claude-code' || normalized === 'claudecode') return 'claude';
  if (normalized === 'codex') return 'codex';
  return normalized || 'agent';
}

function ideForAgent(agent: string): string {
  if (agent === 'claude') return 'claude-code';
  return agent;
}

function normalizeFilePath(value: string, cwd: string | undefined): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd ?? process.cwd(), value);
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readRequiredString(value: unknown, key: string): string {
  const read = readString(value);
  if (!read) throw new Error(`missing ${key}`);
  return read;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function optionalString<K extends string>(
  key: K,
  value: string | undefined,
): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

function parseMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isPathRef(value: unknown): value is { path: string; role: string; kind: string } {
  const record = asRecord(value);
  return (
    record !== undefined &&
    typeof record.path === 'string' &&
    typeof record.role === 'string' &&
    typeof record.kind === 'string'
  );
}

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}
