import { join } from 'node:path';
import { loadSettingsForCwd, resolveDataDir } from '@colony/config';
import { MemoryStore, inferIdeFromSessionId } from '@colony/core';
import { removeActiveSession, upsertActiveSession } from './active-session.js';
import { ensureWorkerRunning } from './auto-spawn.js';
import { postToolUse } from './handlers/post-tool-use.js';
import { preToolUseResult } from './handlers/pre-tool-use.js';
import { sessionEnd } from './handlers/session-end.js';
import { buildProposalPreface, buildTaskPreface, sessionStart } from './handlers/session-start.js';
import { stop } from './handlers/stop.js';
import { userPromptSubmit } from './handlers/user-prompt-submit.js';
import {
  recordTaskBindingLifecycleEvent,
  shouldEmitTaskBindingEvent,
  taskBindingSessionMetadata,
} from './task-binding.js';
import type { HookInput, HookName, HookResult } from './types.js';

export interface RunHookOptions {
  /**
   * Inject a pre-built MemoryStore (used by tests). When supplied, the runner
   * will not construct or close the store — the caller owns its lifecycle.
   */
  store?: MemoryStore;
}

export async function runHook(
  name: HookName,
  input: HookInput,
  opts: RunHookOptions = {},
): Promise<HookResult> {
  const start = performance.now();
  const injected = opts.store !== undefined;
  let store: MemoryStore;
  let settingsForSpawn: ReturnType<typeof loadSettingsForCwd> | undefined;
  if (opts.store) {
    store = opts.store;
  } else {
    const settings = loadSettingsForCwd(input.cwd);
    settingsForSpawn = settings;
    const dbPath = join(resolveDataDir(settings.dataDir), 'data.db');
    store = new MemoryStore({ dbPath, settings });
  }
  try {
    let bootstrapContext = '';
    let permissionDecision: HookResult['permissionDecision'];
    let permissionDecisionReason: string | undefined;
    if (name !== 'session-start') {
      materializeSession(store, input);
      if (name !== 'session-end') {
        bootstrapContext = ensureTaskBinding(store, input);
      }
    }

    let context: string | undefined;
    let extractedPaths: string[] | undefined;
    let warnings: string[] | undefined;
    switch (name) {
      case 'session-start':
        upsertActiveSession(input, name);
        context = await sessionStart(store, input);
        if (shouldEmitTaskBindingEvent(input)) {
          const binding = recordTaskBindingLifecycleEvent(store, input, 'session_start');
          upsertActiveSession(input, name, binding.cache);
        }
        break;
      case 'user-prompt-submit':
        if (
          shouldEmitTaskBindingEvent(input) &&
          store.storage.lastObservationTsForSession(input.session_id, 'user_prompt') === 0
        ) {
          const binding = recordTaskBindingLifecycleEvent(store, input, 'task_bind');
          upsertActiveSession(input, name, binding.cache);
        } else {
          upsertActiveSession(input, name);
        }
        context = joinContext(bootstrapContext, await userPromptSubmit(store, input));
        break;
      case 'pre-tool-use':
        upsertActiveSession(input, name);
        {
          const preToolUse = preToolUseResult(store, input);
          context = preToolUse.context;
          permissionDecision = preToolUse.permissionDecision;
          permissionDecisionReason = preToolUse.permissionDecisionReason;
          extractedPaths = preToolUse.extracted_paths;
          warnings = preToolUse.warnings;
        }
        break;
      case 'post-tool-use':
        upsertActiveSession(input, name);
        {
          const postToolUseResult = await postToolUse(store, input);
          extractedPaths = postToolUseResult.extracted_paths;
          warnings = postToolUseResult.warnings;
        }
        break;
      case 'stop':
        upsertActiveSession(input, name);
        await stop(store, input);
        break;
      case 'session-end':
        await sessionEnd(store, input);
        removeActiveSession(input);
        break;
    }
    // Fire-and-forget: ensure the worker is running so embeddings happen
    // in the background. <2 ms when already running (stat + kill probe).
    // Skipped entirely when a caller injects their own store (tests).
    if (settingsForSpawn && name !== 'session-end') {
      ensureWorkerRunning(settingsForSpawn);
    }
    const result: HookResult = { ok: true, ms: Math.round(performance.now() - start) };
    if (context !== undefined) result.context = context;
    if (permissionDecision !== undefined) result.permissionDecision = permissionDecision;
    if (permissionDecisionReason !== undefined)
      result.permissionDecisionReason = permissionDecisionReason;
    if (extractedPaths !== undefined) result.extracted_paths = extractedPaths;
    if (warnings !== undefined && warnings.length > 0) result.warnings = warnings;
    return result;
  } catch (err) {
    return {
      ok: false,
      ms: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (!injected) store.close();
  }
}

function materializeSession(store: MemoryStore, input: HookInput): void {
  store.startSession({
    id: input.session_id,
    ide: input.ide ?? inferIdeFromSessionId(input.session_id) ?? 'unknown',
    cwd: input.cwd ?? null,
    metadata: taskBindingSessionMetadata(input),
  });
}

function ensureTaskBinding(store: MemoryStore, input: HookInput): string {
  if (!input.cwd) return '';
  if (store.storage.findActiveTaskForSession(input.session_id) !== undefined) return '';
  return joinContext(buildTaskPreface(store, input), buildProposalPreface(store, input));
}

function joinContext(...parts: Array<string | undefined>): string {
  return parts
    .map((p) => p?.trim())
    .filter(Boolean)
    .join('\n\n');
}
