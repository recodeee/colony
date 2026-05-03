import { compress, countTokens, expand, redactPrivate } from '@colony/compress';
import type { Settings } from '@colony/config';
import { type NewObservation, type ObservationRow, Storage } from '@colony/storage';
import { inferSessionIdentity, sessionIdentityMetadata } from './infer-ide.js';
import { cosine, hybridRank } from './ranker.js';
import type { GetObservationsOptions, Observation, SearchResult } from './types.js';

export interface MemoryStoreOptions {
  dbPath: string;
  settings: Settings;
  readonly?: boolean;
}

/**
 * Facade over storage + compression. All write paths go through here to
 * enforce: redact private tags → compress → persist.
 */
export class MemoryStore {
  readonly storage: Storage;
  readonly settings: Settings;

  constructor(opts: MemoryStoreOptions) {
    this.storage = new Storage(opts.dbPath, opts.readonly === true ? { readonly: true } : {});
    this.settings = opts.settings;
  }

  close(): void {
    this.storage.close();
  }

  // --- sessions ---

  startSession(p: {
    id: string;
    ide: string;
    cwd: string | null;
    startedAt?: number;
    metadata?: Record<string, unknown> | null;
  }): void {
    this.storage.createSession({
      id: p.id,
      ide: p.ide,
      cwd: p.cwd,
      started_at: p.startedAt ?? Date.now(),
      metadata: serializeSessionMetadata(p.metadata),
    });
  }

  endSession(id: string): void {
    this.storage.endSession(id);
  }

  // --- observations ---

  addObservation(p: {
    session_id: string;
    kind: string;
    content: string;
    metadata?: Record<string, unknown>;
    task_id?: number | null;
    reply_to?: number | null;
  }): number {
    const redacted = redactPrivate(p.content);
    if (!redacted.trim()) return -1;
    this.ensureSession(p.session_id, p.metadata);
    const intensity = this.settings.compression.intensity;
    const compressed = compress(redacted, { intensity });
    const metadata = {
      ...(p.metadata ?? {}),
      ...tokenReceiptMetadata(redacted, compressed, intensity),
    };
    const obs: NewObservation = {
      session_id: p.session_id,
      kind: p.kind,
      content: compressed,
      compressed: true,
      intensity,
      metadata,
      ...(p.task_id !== undefined ? { task_id: p.task_id } : {}),
      ...(p.reply_to !== undefined ? { reply_to: p.reply_to } : {}),
    };
    return this.storage.insertObservation(obs);
  }

  addSummary(p: { session_id: string; scope: 'turn' | 'session'; content: string }): number {
    const redacted = redactPrivate(p.content);
    this.ensureSession(p.session_id);
    const intensity = this.settings.compression.intensity;
    const out = compress(redacted, { intensity });
    return this.storage.insertSummary({
      session_id: p.session_id,
      scope: p.scope,
      content: out,
      compressed: true,
      intensity,
    });
  }

  /**
   * Idempotently materialise a sessions row before inserting child rows.
   * Claude Code does not guarantee that SessionStart fires before the first
   * UserPromptSubmit / PostToolUse — for example when colony is installed
   * mid-session, when a hook earlier in the chain fails, or when a user
   * resumes a session whose SessionStart was lost. Without this guard,
   * observations and summaries hit `FOREIGN KEY constraint failed`.
   */
  private ensureSession(id: string, metadata?: Record<string, unknown>): void {
    const identity = inferSessionIdentity({
      sessionId: id,
      ...(metadata !== undefined ? { metadata } : {}),
      sourceHint: 'observation',
    });
    this.storage.createSession({
      id,
      ide: identity.ide,
      cwd: null,
      started_at: Date.now(),
      metadata: serializeSessionMetadata(sessionIdentityMetadata(identity)),
    });
  }

  // --- reads ---

  getObservations(ids: number[], opts: GetObservationsOptions = {}): Observation[] {
    const want = opts.expand ?? this.settings.compression.expandForModel;
    return this.storage.getObservations(ids).map((r) => toObservation(r, want));
  }

  timeline(sessionId: string, aroundId?: number, limit?: number): Observation[] {
    return this.storage
      .timeline(sessionId, aroundId, limit)
      .map((r) => toObservation(r, /* expand */ false));
  }

  // --- search ---

  async search(
    query: string,
    limit?: number,
    embedder?: Embedder,
    filter?: { kind?: string; metadata?: Record<string, string> },
  ): Promise<SearchResult[]> {
    const cap = limit ?? this.settings.search.defaultLimit;
    const alpha = this.settings.search.alpha;
    const keyword = this.storage.searchFts(query, cap * 2, filter);
    // When the caller scopes the result to a `kind` / `metadata` pair,
    // skip vector ranking: the embedding index has no kind filter, so
    // mixing vector hits would bring back observations from other kinds
    // and force a second pass to drop them. The filtered FTS output is
    // already scoped correctly — keyword-only is faster and cleaner.
    if (filter && (filter.kind || (filter.metadata && Object.keys(filter.metadata).length > 0))) {
      return keyword.slice(0, cap);
    }
    if (!embedder || this.settings.embedding.provider === 'none') {
      return keyword.slice(0, cap);
    }
    const vectors = this.storage.allEmbeddings({ model: embedder.model, dim: embedder.dim });
    if (vectors.length === 0) return keyword.slice(0, cap);
    const qvec = await embedder.embed(query);
    if (qvec.length !== embedder.dim) {
      // Provider lied about dim — skip vector ranking rather than mix dims.
      return keyword.slice(0, cap);
    }
    const scored = vectors.map((v) => ({
      id: v.observation_id,
      cosine: cosine(qvec, v.vec),
    }));
    const merged = new Map<number, { bm25?: number; cosine?: number }>();
    for (const k of keyword) merged.set(k.id, { bm25: k.score });
    for (const s of scored) {
      const cur = merged.get(s.id) ?? {};
      cur.cosine = s.cosine;
      merged.set(s.id, cur);
    }
    const ranked = hybridRank(
      Array.from(merged, ([id, v]) => ({ id, ...v })),
      alpha,
    ).slice(0, cap);
    const infoById = new Map<
      number,
      { session_id: string; kind: string; snippet: string; ts: number; task_id: number | null }
    >(
      keyword.map((k) => [
        k.id,
        {
          session_id: k.session_id,
          kind: k.kind,
          snippet: k.snippet,
          ts: k.ts,
          task_id: k.task_id,
        },
      ]),
    );
    // For vector-only hits we still need snippet/session info; fetch them.
    const missing = ranked.filter((r) => !infoById.has(r.id)).map((r) => r.id);
    if (missing.length) {
      for (const row of this.storage.getObservations(missing)) {
        infoById.set(row.id, {
          session_id: row.session_id,
          kind: row.kind,
          snippet: row.content.slice(0, 120),
          ts: row.ts,
          task_id: row.task_id,
        });
      }
    }
    return ranked.map((r) => {
      const info = infoById.get(r.id);
      return {
        id: r.id,
        session_id: info?.session_id ?? '',
        kind: info?.kind ?? '',
        snippet: info?.snippet ?? '',
        score: r.score,
        ts: info?.ts ?? 0,
        task_id: info?.task_id ?? null,
      };
    });
  }
}

function serializeSessionMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  return metadata ? JSON.stringify(metadata) : null;
}

function tokenReceiptMetadata(
  before: string,
  after: string,
  intensity: string,
): Record<string, unknown> {
  const tokens_before = countTokens(before);
  const tokens_after = countTokens(after);
  const saved_tokens = tokens_before - tokens_after;
  const saved_ratio =
    tokens_before === 0 ? 0 : normalizeRatio(Number((saved_tokens / tokens_before).toFixed(3)));
  return {
    tokens_before,
    tokens_after,
    saved_tokens,
    saved_ratio,
    compression_intensity: intensity,
  };
}

function normalizeRatio(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

export interface Embedder {
  readonly model: string;
  readonly dim: number;
  embed(text: string): Promise<Float32Array>;
}

function toObservation(r: ObservationRow, expandText: boolean): Observation {
  const raw = r.content;
  const content = expandText ? expand(raw) : raw;
  return {
    id: r.id,
    session_id: r.session_id,
    kind: r.kind,
    content,
    compressed: !expandText && r.compressed === 1,
    intensity: r.intensity,
    ts: r.ts,
    metadata: r.metadata ? safeParse(r.metadata) : null,
    task_id: r.task_id,
    reply_to: r.reply_to,
  };
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}
