// Periodic coordination-sweep so health metrics self-heal without
// manual `colony coordination sweep` invocations. The infrastructure
// (buildCoordinationSweep + Storage.sweepStaleClaims) already exists;
// this file is the missing background trigger.
//
// Why: orphaned claims accumulate from sessions that exit without
// releasing — quota crash, SIGKILL, normal exit without cleanup. Each
// pass downgrades stale claims (>= claimStaleMinutes) to weak ownership
// and releases expired quota-pending handoffs. Effects are append-only
// observation rows so audit history is preserved.
//
// Safe defaults: only release_safe_stale_claims and
// release_expired_quota_claims are enabled. Aged-quota cleanup,
// same-branch dedup, and stale-blocker release stay manual — they
// touch sessions that may still be reachable.

import type { Settings } from '@colony/config';
import {
  type CoordinationSweepResult,
  type MemoryStore,
  buildCoordinationSweep,
} from '@colony/core';

export interface CoordinationSweepLoopHandle {
  stop: () => Promise<void>;
  lastResult: () => CoordinationSweepResult | null;
  runNow: () => Promise<CoordinationSweepResult>;
}

export interface CoordinationSweepLoopOptions {
  store: MemoryStore;
  settings: Settings;
  intervalMs?: number;
  log?: (line: string) => void;
}

export function startCoordinationSweepLoop(
  opts: CoordinationSweepLoopOptions,
): CoordinationSweepLoopHandle {
  const { store, settings } = opts;
  const intervalMinutes = settings.coordinationSweepIntervalMinutes;
  const intervalMs = opts.intervalMs ?? intervalMinutes * 60_000;
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  let stopped = false;
  let inFlight: Promise<CoordinationSweepResult | undefined> | null = null;
  let latest: CoordinationSweepResult | null = null;

  const runOnce = (): CoordinationSweepResult => {
    const result = buildCoordinationSweep(store, {
      release_safe_stale_claims: true,
      release_expired_quota_claims: true,
    });
    latest = result;
    logRun(log, result);
    return result;
  };

  const tick = async (): Promise<CoordinationSweepResult | undefined> => {
    if (stopped) return;
    try {
      return runOnce();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[colony worker] coordination-sweep error: ${message}`);
    }
  };

  // Disabled = configured to 0. We honor it strictly so e2e tests and
  // ops can opt out without patching code.
  const disabled = intervalMs === 0;
  let timer: NodeJS.Timeout | null = null;
  if (!disabled) {
    // Defer the first run a few seconds after worker boot so it doesn't
    // race with embed-loop startup or initial DB warmup.
    const firstRunDelay = Math.min(5_000, intervalMs);
    timer = setTimeout(function loop() {
      if (stopped) return;
      inFlight = tick();
      void inFlight.finally(() => {
        if (stopped) return;
        timer = setTimeout(loop, intervalMs);
      });
    }, firstRunDelay);
  }

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          /* swallow — loop already logged */
        }
      }
    },
    lastResult: () => latest,
    runNow: async () => {
      const result = runOnce();
      latest = result;
      return result;
    },
  };
}

function logRun(log: (line: string) => void, result: CoordinationSweepResult): void {
  const s = result.summary;
  const released = s.released_stale_claim_count + s.released_expired_quota_pending_claim_count;
  if (released === 0 && s.downgraded_stale_claim_count === 0) return;
  log(
    `[colony worker] coordination-sweep released stale=${s.released_stale_claim_count} ` +
      `expired_quota=${s.released_expired_quota_pending_claim_count} ` +
      `downgraded=${s.downgraded_stale_claim_count}`,
  );
}
