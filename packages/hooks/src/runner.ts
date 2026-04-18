import { join } from 'node:path';
import { loadSettings, resolveDataDir } from '@cavemem/config';
import { MemoryStore } from '@cavemem/core';
import { ensureWorkerRunning } from './auto-spawn.js';
import { postToolUse } from './handlers/post-tool-use.js';
import { sessionEnd } from './handlers/session-end.js';
import { sessionStart } from './handlers/session-start.js';
import { stop } from './handlers/stop.js';
import { userPromptSubmit } from './handlers/user-prompt-submit.js';
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
  let settingsForSpawn: ReturnType<typeof loadSettings> | undefined;
  if (opts.store) {
    store = opts.store;
  } else {
    const settings = loadSettings();
    settingsForSpawn = settings;
    const dbPath = join(resolveDataDir(settings.dataDir), 'data.db');
    store = new MemoryStore({ dbPath, settings });
  }
  try {
    let context: string | undefined;
    switch (name) {
      case 'session-start':
        context = await sessionStart(store, input);
        break;
      case 'user-prompt-submit':
        context = await userPromptSubmit(store, input);
        break;
      case 'post-tool-use':
        await postToolUse(store, input);
        break;
      case 'stop':
        await stop(store, input);
        break;
      case 'session-end':
        await sessionEnd(store, input);
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
