import { type ChildProcess, spawn } from 'node:child_process';

export interface CaffeinateHandle {
  stop: () => void;
}

/**
 * Hold a `caffeinate -i` assertion on macOS while the worker is running, so a
 * laptop lid-close or system idle doesn't suspend the long-running embedding
 * backfill loop. `-i` blocks idle sleep only — display sleep and lid-close
 * sleep on battery still work, matching the agent-orchestrator approach.
 *
 * On non-darwin platforms this is a no-op. If the binary is missing (rare —
 * darwin always ships it under `/usr/bin/caffeinate`) we log once and return
 * a no-op handle so the worker still boots.
 */
export function startCaffeinate(log: (line: string) => void): CaffeinateHandle {
  if (process.platform !== 'darwin') {
    return { stop: () => {} };
  }

  let child: ChildProcess | null = null;
  try {
    child = spawn('caffeinate', ['-i', '-w', String(process.pid)], {
      stdio: 'ignore',
      detached: false,
    });
  } catch (err) {
    log(
      `[colony worker] caffeinate unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { stop: () => {} };
  }

  child.on('error', (err) => {
    // ENOENT or permission denied — surface once, don't crash the worker.
    log(`[colony worker] caffeinate spawn error: ${err.message}`);
  });

  return {
    stop: () => {
      if (!child || child.killed) return;
      try {
        child.kill('SIGTERM');
      } catch {
        // Process already exited or PID reused — nothing to clean up.
      }
    },
  };
}
