import { compress, countTokens, expand, redactPrivate } from '@colony/compress';
import type { Settings } from '@colony/config';
import { type NewObservation, type ObservationRow, Storage } from '@colony/storage';
import { inferSessionIdentity, sessionIdentityMetadata } from './infer-ide.js';
import { cosine, hybridRank } from './ranker.js';
import { type RustSearchOptions, searchWithRust } from './rust-search.js';
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
  readonly dbPath: string;
  readonly storage: Storage;
  readonly settings: Settings;

  constructor(opts: MemoryStoreOptions) {
    this.dbPath = opts.dbPath;
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
    options: RustSearchOptions = {},
  ): Promise<SearchResult[]> {
    const cap = limit ?? this.settings.search.defaultLimit;
    const alpha = this.settings.search.alpha;
    const keyword = await this.keywordSearch(query, cap * 2, filter, options);
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
    // Normal searches already have enough FTS candidates. Bound vector work to
    // those candidates so semantic reranking does not load every stored vector.
    const vectors =
      keyword.length >= cap
        ? this.storage.embeddingsForObservations(
            keyword.map((hit) => hit.id),
            { model: embedder.model, dim: embedder.dim },
          )
        : this.storage.allEmbeddings({ model: embedder.model, dim: embedder.dim });
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

  // --- pure-vector semantic search ---
  //
  // The hybrid `search` above starts with a BM25 candidate pool, then vector-
  // reranks it. That works great when the query shares keywords with the
  // stored content, but fails for cross-language queries, novel-phrase
  // queries, and concept-level recall where no FTS candidate ever surfaces.
  // `semanticSearch` is the escape hatch: skip FTS entirely, score every
  // stored vector by cosine, return top-K.
  //
  // Cost: O(N) cosine evaluations over all observations matching the
  // embedder's (model, dim). For ≤ 50k observations on the dev box this is
  // ~5–25 ms in JS — well inside the 50 ms p95 budget for `search`.
  // Beyond that we'd reach for an ANN index (sqlite-vss / HNSW); the storage
  // schema already has `idx_embeddings_model` keyed on (model, dim) so the
  // upgrade path doesn't touch this method's signature.
  async semanticSearch(
    query: string,
    limit: number | undefined,
    embedder: Embedder,
    filter?: { kind?: string; metadata?: Record<string, string> },
  ): Promise<SearchResult[]> {
    const cap = limit ?? this.settings.search.defaultLimit;
    const qvec = await embedder.embed(query);
    if (qvec.length !== embedder.dim) {
      // Provider lied about dim — cannot meaningfully compare. Return empty
      // rather than mix dimensions and produce garbage scores.
      return [];
    }

    const vectors = this.storage.allEmbeddings({ model: embedder.model, dim: embedder.dim });
    if (vectors.length === 0) return [];

    const scored = vectors.map((v) => ({ id: v.observation_id, score: cosine(qvec, v.vec) }));
    scored.sort((a, b) => b.score - a.score);

    // Over-fetch when a filter is set so the post-rank filter can drop
    // non-matching rows without dropping below `cap`. Bounded so a tiny
    // filter set on a huge corpus still terminates quickly.
    const overFetch = filter && (filter.kind || filter.metadata) ? cap * 4 : cap;
    const candidateIds = scored.slice(0, overFetch).map((s) => s.id);
    const rows = this.storage.getObservations(candidateIds);
    const byId = new Map<number, ObservationRow>(rows.map((r) => [r.id, r]));

    const out: SearchResult[] = [];
    for (const s of scored) {
      if (out.length >= cap) break;
      const row = byId.get(s.id);
      if (!row) continue;
      if (filter?.kind && row.kind !== filter.kind) continue;
      if (filter?.metadata) {
        // ObservationRow stores metadata as a JSON string. Parse lazily so
        // the no-filter path stays free of JSON cost.
        let parsedMeta: Record<string, unknown> | null = null;
        if (row.metadata) {
          try {
            parsedMeta = JSON.parse(row.metadata) as Record<string, unknown>;
          } catch {
            parsedMeta = null;
          }
        }
        let mismatch = false;
        for (const [k, want] of Object.entries(filter.metadata)) {
          const got = parsedMeta?.[k];
          if (typeof got !== 'string' || got !== want) {
            mismatch = true;
            break;
          }
        }
        if (mismatch) continue;
      }
      out.push({
        id: s.id,
        session_id: row.session_id,
        kind: row.kind,
        snippet: row.content.slice(0, 120),
        score: s.score,
        ts: row.ts,
        task_id: row.task_id,
      });
    }
    return out;
  }

  // --- cluster observations by semantic similarity ---
  //
  // Greedy single-linkage clustering by cosine threshold over a caller-
  // supplied set of observation IDs. The intended consumer is handoff /
  // attention_inbox dedupe: an agent collects a list of pending handoff
  // observation_ids, calls clusterObservations(ids, 0.85), and groups
  // near-duplicate reports under a single canonical row.
  //
  // The algorithm:
  //   1. Load the embedding for every input id that has one stored.
  //   2. Sort the survivors by id ascending (deterministic + the earlier
  //      observation is the natural canonical).
  //   3. Walk the list. Each unassigned id starts a new cluster; every
  //      later id whose cosine to the canonical is >= `threshold` joins it.
  //
  // Cost: O(N^2) cosine evaluations. Typical attention_inbox payloads are
  // < 100 IDs, so this is fractions of a millisecond. If a caller asks
  // for thousands of IDs the budget gets enforced at the MCP-tool layer
  // (input cap of 500 in the tool's zod schema).
  //
  // Items whose embeddings are missing or whose dim does not match the
  // embedder are reported in `unembedded` and left out of clusters; the
  // caller decides whether to keep them as singleton entries or skip.
  async clusterObservations(
    ids: number[],
    threshold: number,
    embedder: Embedder,
  ): Promise<{ clusters: { canonical_id: number; member_ids: number[] }[]; unembedded: number[] }> {
    if (ids.length === 0) {
      return { clusters: [], unembedded: [] };
    }
    if (!Number.isFinite(threshold) || threshold <= -1 || threshold > 1) {
      throw new Error(`clusterObservations: threshold must be in (-1, 1], got ${threshold}`);
    }

    const stored = this.storage.embeddingsForObservations(ids, {
      model: embedder.model,
      dim: embedder.dim,
    });
    const byId = new Map<number, Float32Array>(stored.map((r) => [r.observation_id, r.vec]));

    const unembedded: number[] = [];
    const embedded: { id: number; vec: Float32Array }[] = [];
    // Preserve input order for unembedded reporting; sort the embedded
    // subset by id ascending so the earliest observation in each cluster
    // becomes the canonical representative.
    const seen = new Set<number>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const vec = byId.get(id);
      if (!vec || vec.length !== embedder.dim) {
        unembedded.push(id);
        continue;
      }
      embedded.push({ id, vec });
    }
    embedded.sort((a, b) => a.id - b.id);

    const clusters: { canonical_id: number; member_ids: number[] }[] = [];
    const assigned = new Set<number>();
    for (const item of embedded) {
      if (assigned.has(item.id)) continue;
      const cluster = { canonical_id: item.id, member_ids: [item.id] };
      assigned.add(item.id);
      for (const other of embedded) {
        if (assigned.has(other.id)) continue;
        if (cosine(item.vec, other.vec) >= threshold) {
          cluster.member_ids.push(other.id);
          assigned.add(other.id);
        }
      }
      clusters.push(cluster);
    }
    return { clusters, unembedded };
  }

  private async keywordSearch(
    query: string,
    limit: number,
    filter: { kind?: string; metadata?: Record<string, string> } | undefined,
    options: RustSearchOptions,
  ): Promise<SearchResult[]> {
    // Rust search is a read-side accelerator only. Filtered FTS stays on
    // SQLite until the sidecar learns the same metadata/kind contract.
    if (
      !filter ||
      (!filter.kind && (!filter.metadata || Object.keys(filter.metadata).length === 0))
    ) {
      const rustHits = await searchWithRust({
        dbPath: this.dbPath,
        settings: this.settings,
        query,
        limit,
        mode: options.rust ?? 'auto',
      });
      if (rustHits) return rustHits.slice(0, limit);
    }
    return this.storage.searchFts(query, limit, filter);
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
  embedBatch?(texts: readonly string[]): Promise<Float32Array[]>;
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
