import type { Storage } from '@colony/storage';

export interface PheromoneStrengthBySession {
  session_id: string;
  strength: number;
  age_ms: number;
}

export interface PheromoneTrail {
  file_path: string;
  total_strength: number;
  bySession: Array<{ session_id: string; strength: number }>;
}

/**
 * Pheromone-based file attention. Every tool-use that edits a file deposits
 * pheromone on (task_id, file_path, session_id); strength decays
 * exponentially with a fixed half-life. We never run a cleanup pass — the
 * decay is recomputed on every read from the stored (strength, deposited_at)
 * pair, so time does the evaporation for free.
 *
 * The model is additive: multiple deposits on the same cell accumulate
 * against the decayed current value and clamp at MAX_STRENGTH, so a
 * repeatedly-edited file ends up with a visibly stronger trail than a
 * once-touched one.
 */
export class PheromoneSystem {
  /**
   * Half-life of a single deposit. Ten minutes is the rough timescale on
   * which a human switches files; decay fast enough that stale trails
   * don't drown out fresh ones, slow enough that a 5-minute gap between
   * edits still shows up. Tune after real usage.
   */
  private static readonly HALF_LIFE_MS = 10 * 60_000;
  private static readonly DECAY_RATE = Math.LN2 / PheromoneSystem.HALF_LIFE_MS;

  /**
   * Cap so hot spots don't run away. Without this, a file edited 100 times
   * in a minute would dominate every trail query forever. Real ant trails
   * saturate for the same surface-area reason.
   */
  private static readonly MAX_STRENGTH = 10;
  private static readonly DEPOSIT = 1.0;

  constructor(private storage: Storage) {}

  /** Leave pheromone on a file. Called per write-tool invocation. */
  deposit(args: { task_id: number; file_path: string; session_id: string }): void {
    const now = Date.now();
    const existing = this.storage.getPheromone(args.task_id, args.file_path, args.session_id);

    let newStrength: number;
    if (existing) {
      const decayed = PheromoneSystem.decay(existing.strength, existing.deposited_at, now);
      newStrength = Math.min(decayed + PheromoneSystem.DEPOSIT, PheromoneSystem.MAX_STRENGTH);
    } else {
      newStrength = PheromoneSystem.DEPOSIT;
    }

    this.storage.upsertPheromone({
      task_id: args.task_id,
      file_path: args.file_path,
      session_id: args.session_id,
      strength: newStrength,
      deposited_at: now,
    });
  }

  /**
   * Current pheromone on a file, summed across sessions and decayed to now.
   * Returns the per-session breakdown so the caller can distinguish
   * "Claude has been here" from "Codex has been here" — both answers matter
   * for different rendering decisions.
   */
  sniff(args: { task_id: number; file_path: string }): {
    total: number;
    bySession: PheromoneStrengthBySession[];
  } {
    const now = Date.now();
    const rows = this.storage.listPheromonesForFile(args.task_id, args.file_path);
    const bySession = rows.map((r) => ({
      session_id: r.session_id,
      strength: PheromoneSystem.decay(r.strength, r.deposited_at, now),
      age_ms: now - r.deposited_at,
    }));
    const total = bySession.reduce((s, r) => s + r.strength, 0);
    return { total, bySession };
  }

  /**
   * Files on a task ranked by summed current strength, filtered below a
   * noise-floor. Default floor is 0.1 — anything weaker is "almost fully
   * evaporated" and shouldn't influence coordination decisions.
   */
  strongestTrails(task_id: number, minStrength = 0.1): PheromoneTrail[] {
    const now = Date.now();
    const rows = this.storage.listPheromonesForTask(task_id);

    const byFile = new Map<string, Array<{ session_id: string; strength: number }>>();
    for (const r of rows) {
      const strength = PheromoneSystem.decay(r.strength, r.deposited_at, now);
      if (strength < minStrength) continue;
      const list = byFile.get(r.file_path) ?? [];
      list.push({ session_id: r.session_id, strength });
      byFile.set(r.file_path, list);
    }

    return Array.from(byFile.entries())
      .map(([file_path, bySession]) => ({
        file_path,
        total_strength: bySession.reduce((s, r) => s + r.strength, 0),
        bySession: bySession.sort((a, b) => b.strength - a.strength),
      }))
      .sort((a, b) => b.total_strength - a.total_strength);
  }

  /**
   * strength(t) = deposit * exp(-rate * elapsed). Exposed as a static so
   * tests can compare against the formula directly instead of mocking time.
   */
  static decay(deposit: number, depositedAt: number, now: number): number {
    const elapsed = now - depositedAt;
    if (elapsed <= 0) return deposit;
    return deposit * Math.exp(-PheromoneSystem.DECAY_RATE * elapsed);
  }

  /** Exposed for tests so parameters don't have to be duplicated. */
  static get halfLifeMs(): number {
    return PheromoneSystem.HALF_LIFE_MS;
  }
  static get maxStrength(): number {
    return PheromoneSystem.MAX_STRENGTH;
  }
  static get depositAmount(): number {
    return PheromoneSystem.DEPOSIT;
  }
}
