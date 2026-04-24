import { join } from 'node:path';
import { type Settings, resolveDataDir } from '@colony/config';
import { isAlive, readPidFile, spawnNodeScript } from '@colony/process';

/**
 * Ensure the worker daemon is running. Called from the hook runner after
 * every successful hook (sessionStart, postToolUse, ...) so embeddings
 * happen without the user ever typing `colony start`.
 *
 * Hard invariants:
 *   - Must complete in < 2 ms when the worker is already running (the hot path).
 *     We achieve this with one stat + one process.kill(pid, 0) probe.
 *   - Must never block the hook on worker start — spawn is detached + unref.
 *   - Must not spawn if COLONY_NO_AUTOSTART is set (e2e tests need
 *     deterministic lifecycle).
 *   - Must not spawn if autoStart is false or provider is 'none'.
 *   - If the CLI path cannot be resolved (e.g., we're imported from a
 *     library context with no argv[1]), skip — silent no-op.
 */
export function ensureWorkerRunning(settings: Settings): void {
  if (process.env.COLONY_NO_AUTOSTART || process.env.CAVEMEM_NO_AUTOSTART) return;
  if (!settings.embedding.autoStart) return;
  if (settings.embedding.provider === 'none') return;

  const pidFile = join(resolveDataDir(settings.dataDir), 'worker.pid');
  const pid = readPidFile(pidFile);
  if (pid !== null && isAlive(pid)) return;

  const cli = resolveCli();
  if (!cli) return;

  try {
    spawnNodeScript(cli, ['worker', 'start']);
  } catch {
    // Best-effort — if spawn fails, the hook still succeeds. Next hook will retry.
  }
}

function resolveCli(): string | null {
  // argv[1] is the CLI binary when the hook handler runs through `colony hook`.
  const argv1 = process.argv[1];
  if (argv1) return argv1;
  return null;
}
