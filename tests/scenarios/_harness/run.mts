import { readFileSync } from 'node:fs';
import { TaskThread } from '../../../packages/core/src/index.js';
import { runOmxLifecycleEnvelope } from '../../../packages/hooks/src/lifecycle-envelope.js';
import { BASE_TS, type ScenarioContext } from './setup.mjs';

/**
 * Time hook the runner calls between each input. Inside vitest tests
 * we pass `vi.setSystemTime`; in `record.ts` we pass a hand-rolled
 * Date.now stub that doesn't need the vitest runtime.
 */
export type SetSystemTime = (ms: number) => void;

/** One line in inputs.jsonl. */
export interface ScenarioInput {
  /**
   * What kind of event to drive at this point on the timeline.
   *
   * - `lifecycle` — funnel `payload` through `runOmxLifecycleEnvelope`. This is
   *   the same entry point production hooks call.
   * - `mcp` — record an MCP metric row so assertions can read it back.
   * - `task` — direct TaskThread action (relay, accept_relay, release_expired,
   *   claim_file). For multi-runtime flows where lifecycle envelopes alone
   *   can't express the cross-agent baton pass.
   * - `tick` — advance the fake clock without dispatching anything; useful for
   *   forcing expirations to fire on the next event.
   */
  kind: 'lifecycle' | 'mcp' | 'task' | 'tick';
  /**
   * Offset from BASE_TS in milliseconds. Inputs MUST be sorted by `at_ms`
   * within the file; the runner does not re-sort.
   */
  at_ms: number;
  payload: Record<string, unknown>;
}

export class ScenarioConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioConfigError';
  }
}

/**
 * Parse inputs.jsonl into structured envelopes. Empty lines and lines
 * starting with `#` are skipped so authors can leave comments in
 * fixtures.
 */
export function parseInputsJsonl(path: string): ScenarioInput[] {
  const raw = readFileSync(path, 'utf8');
  const out: ScenarioInput[] = [];
  let lineNo = 0;
  for (const line of raw.split('\n')) {
    lineNo += 1;
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new ScenarioConfigError(
        `inputs.jsonl line ${lineNo} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!isInput(parsed)) {
      throw new ScenarioConfigError(
        `inputs.jsonl line ${lineNo} missing kind | at_ms | payload`,
      );
    }
    out.push(parsed);
  }
  // Enforce monotonic at_ms so authors don't accidentally reorder events
  // and get a different live result than the fixture suggests. Fixing the
  // line order in the file is always less surprising than silent reorder.
  for (let i = 1; i < out.length; i += 1) {
    const current = out[i];
    const previous = out[i - 1];
    if (!current || !previous) continue;
    if (current.at_ms < previous.at_ms) {
      throw new ScenarioConfigError(
        `inputs.jsonl is not sorted by at_ms (line ${i + 1} t+${current.at_ms}ms < previous t+${previous.at_ms}ms)`,
      );
    }
  }
  return out;
}

function isInput(value: unknown): value is ScenarioInput {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    (v.kind === 'lifecycle' || v.kind === 'mcp' || v.kind === 'task' || v.kind === 'tick') &&
    typeof v.at_ms === 'number' &&
    typeof v.payload === 'object' &&
    v.payload !== null
  );
}

/**
 * Substitute path placeholders in an envelope before dispatch. Authors
 * write `<REPO_ROOT>` and `<REPO_ROOT>/src/x.ts`; the runner rewrites to
 * the live tempdir path. Done as a deep walk so nested `tool_input`
 * structures keep working.
 */
export function expandPlaceholders<T>(value: T, repoRoot: string): T {
  if (typeof value === 'string') {
    return value.replaceAll('<REPO_ROOT>', repoRoot) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandPlaceholders(item, repoRoot)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandPlaceholders(v, repoRoot);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Drive a single scenario. The caller has already opened a context
 * (setup.ts) and parsed inputs. Each input advances the fake clock to
 * BASE_TS + at_ms, then dispatches based on kind. Lifecycle envelopes
 * auto-fill `timestamp` from the fake clock so authors don't have to
 * keep two clocks in sync inside the JSON.
 */
export async function runScenarioInputs(
  ctx: ScenarioContext,
  inputs: ScenarioInput[],
  setSystemTime: SetSystemTime,
): Promise<void> {
  for (const input of inputs) {
    const at = BASE_TS + input.at_ms;
    setSystemTime(at);

    if (input.kind === 'tick') {
      // Advancing time alone surfaces TTL-driven side effects on the next
      // write. Nothing else to do.
      continue;
    }

    if (input.kind === 'mcp') {
      const payload = expandPlaceholders(input.payload, ctx.repoRoot) as Record<string, unknown>;
      ctx.store.storage.recordMcpMetric({
        ts: at,
        operation: requireString(payload, 'operation'),
        session_id: optionalString(payload, 'session_id'),
        repo_root: optionalString(payload, 'repo_root') ?? ctx.repoRoot,
        input_bytes: numberOr(payload, 'input_bytes', 0),
        output_bytes: numberOr(payload, 'output_bytes', 0),
        input_tokens: numberOr(payload, 'input_tokens', 0),
        output_tokens: numberOr(payload, 'output_tokens', 0),
        duration_ms: numberOr(payload, 'duration_ms', 0),
        ok: payload.ok !== false,
        error_code: optionalString(payload, 'error_code'),
        error_message: optionalString(payload, 'error_message'),
      });
      continue;
    }

    if (input.kind === 'lifecycle') {
      const payload = expandPlaceholders(input.payload, ctx.repoRoot) as Record<string, unknown>;
      const envelope: Record<string, unknown> = {
        source: 'omx',
        cwd: ctx.repoRoot,
        repo_root: ctx.repoRoot,
        // Authors omit `timestamp` and we fill from the fake clock so the
        // single source of truth stays `at_ms` in inputs.jsonl.
        timestamp: new Date(at).toISOString(),
        ...payload,
      };
      const result = await runOmxLifecycleEnvelope(envelope, { store: ctx.store });
      if (!result.ok) {
        throw new ScenarioConfigError(
          `lifecycle envelope failed at t+${input.at_ms}ms event_id=${String(payload.event_id ?? '<unknown>')}: ${result.error ?? 'unknown error'}`,
        );
      }
      continue;
    }

    if (input.kind === 'task') {
      const payload = expandPlaceholders(input.payload, ctx.repoRoot) as Record<string, unknown>;
      handleTaskAction(ctx, payload, input.at_ms);
      continue;
    }
  }
}

/**
 * Dispatch a `task` envelope. Each action targets a specific TaskThread
 * method so assertions and explain output can describe the operation
 * by name. `task_id` is required for relay/accept/release; we don't
 * infer it because scenarios should be explicit about which task they
 * touch.
 */
function handleTaskAction(
  ctx: ScenarioContext,
  payload: Record<string, unknown>,
  atMs: number,
): void {
  const action = requireString(payload, 'action');
  const taskId = numberOr(payload, 'task_id', NaN);
  if (!Number.isFinite(taskId)) {
    throw new ScenarioConfigError(`task envelope at t+${atMs}ms missing numeric task_id`);
  }
  const thread = new TaskThread(ctx.store, taskId);

  if (action === 'claim_file') {
    const note = optionalString(payload, 'note');
    thread.claimFile({
      session_id: requireString(payload, 'session_id'),
      file_path: requireString(payload, 'file_path'),
      ...(note !== null ? { note } : {}),
    });
    return;
  }

  if (action === 'relay') {
    const toAgent = optionalString(payload, 'to_agent');
    // Reason is one of a closed set in @colony/core; we cast after
    // validating the string is non-empty so the runner doesn't have to
    // re-list the union here.
    const reason = requireString(payload, 'reason') as
      | 'quota'
      | 'rate-limit'
      | 'turn-cap'
      | 'manual'
      | 'unspecified';
    thread.relay({
      from_session_id: requireString(payload, 'from_session_id'),
      from_agent: requireString(payload, 'from_agent'),
      reason,
      one_line: requireString(payload, 'one_line'),
      base_branch: requireString(payload, 'base_branch'),
      ...(typeof payload.expires_in_ms === 'number'
        ? { expires_in_ms: payload.expires_in_ms }
        : {}),
      ...(toAgent !== null ? { to_agent: toAgent as 'claude' | 'codex' | 'any' } : {}),
    });
    return;
  }

  if (action === 'accept_relay') {
    const explicit = numberOr(payload, 'relay_observation_id', NaN);
    const obsId = Number.isFinite(explicit)
      ? explicit
      : findLatestRelayId(ctx, taskId, atMs);
    thread.acceptRelay(obsId, requireString(payload, 'session_id'));
    return;
  }

  if (action === 'release_expired_quota') {
    const obsId = numberOr(payload, 'handoff_observation_id', NaN);
    thread.releaseExpiredQuotaClaims({
      session_id: requireString(payload, 'session_id'),
      ...(Number.isFinite(obsId) ? { handoff_observation_id: obsId } : {}),
    });
    return;
  }

  if (action === 'join') {
    thread.join(requireString(payload, 'session_id'), requireString(payload, 'agent'));
    return;
  }

  if (action === 'add_observation') {
    const metadata = (payload.metadata as Record<string, unknown> | undefined) ?? {};
    ctx.store.addObservation({
      session_id: requireString(payload, 'session_id'),
      task_id: taskId,
      kind: requireString(payload, 'kind'),
      content: optionalString(payload, 'content') ?? '',
      metadata,
    });
    return;
  }

  throw new ScenarioConfigError(`unknown task action "${action}" at t+${atMs}ms`);
}

/**
 * Look up the most recent `relay`-kind observation on the task so
 * scenarios can `accept_relay` without hard-coding a row id. Returns
 * the id of the newest matching row. Throws if none exists — that's a
 * fixture authoring bug, not a runner bug.
 */
function findLatestRelayId(ctx: ScenarioContext, taskId: number, atMs: number): number {
  const storageWithDb = ctx.store.storage as unknown as {
    db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } };
  };
  const row = storageWithDb.db
    .prepare(
      "SELECT id FROM observations WHERE task_id = ? AND kind = 'relay' ORDER BY id DESC LIMIT 1",
    )
    .get(taskId) as { id: number } | undefined;
  if (!row) {
    throw new ScenarioConfigError(
      `task accept_relay at t+${atMs}ms: no relay observation found on task ${taskId}`,
    );
  }
  return row.id;
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ScenarioConfigError(`mcp envelope missing required string field "${key}"`);
  }
  return value;
}

function optionalString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

function numberOr(payload: Record<string, unknown>, key: string, fallback: number): number {
  const value = payload[key];
  return typeof value === 'number' ? value : fallback;
}
