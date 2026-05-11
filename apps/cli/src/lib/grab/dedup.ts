import { createHash } from 'node:crypto';

interface Record {
  hash: string;
  task_id: number;
  ts: number;
}

/**
 * In-memory hash dedup for repeated react-grab submits. The same element +
 * extra_prompt within the configured window is appended as a `task_post` note
 * on the original task instead of cutting a new worktree.
 *
 * Per-process only. Crash loses the dedup state, which means the next submit
 * after a crash creates a fresh task — acceptable tradeoff for a dev tool.
 */
export class DedupCache {
  private records: Record[] = [];

  constructor(private readonly windowMs: number) {}

  hash(parts: ReadonlyArray<string | undefined | null>): string {
    return createHash('sha256')
      .update(parts.map((p) => p ?? '').join('|'))
      .digest('hex');
  }

  lookup(hash: string, now: number = Date.now()): number | null {
    this.evict(now);
    const hit = this.records.find((r) => r.hash === hash);
    return hit?.task_id ?? null;
  }

  record(hash: string, task_id: number, now: number = Date.now()): void {
    this.evict(now);
    this.records.push({ hash, task_id, ts: now });
  }

  private evict(now: number): void {
    if (this.records.length === 0) return;
    this.records = this.records.filter((r) => now - r.ts < this.windowMs);
  }
}
