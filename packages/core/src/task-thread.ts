import type { ObservationRow, TaskClaimRow, TaskParticipantRow, TaskRow } from '@cavemem/storage';
import type { MemoryStore } from './memory-store.js';
import {
  type AgentProfile,
  type CandidateScore,
  loadProfile,
  rankCandidates,
} from './response-thresholds.js';

export type CoordinationKind =
  | 'claim'
  | 'question'
  | 'answer'
  | 'handoff'
  | 'decline'
  | 'decision'
  | 'blocker'
  | 'note';

export type HandoffStatus = 'pending' | 'accepted' | 'expired' | 'cancelled';
export type HandoffTarget = 'claude' | 'codex' | 'any';

/**
 * The structured payload stored inside observation.metadata for handoff
 * messages. Keeping this shape narrow and typed is what lets the SessionStart
 * hook re-render a handoff deterministically without re-parsing the
 * (possibly compressed) content body.
 */
export interface HandoffMetadata {
  kind: 'handoff';
  from_session_id: string;
  from_agent: string;
  to_agent: HandoffTarget;
  to_session_id: string | null;
  summary: string;
  next_steps: string[];
  blockers: string[];
  released_files: string[];
  transferred_files: string[];
  status: HandoffStatus;
  accepted_by_session_id: string | null;
  accepted_at: number | null;
  expires_at: number;
  /**
   * Ranking of candidate agents by capability fit against this handoff,
   * snapshotted at send time. Only populated when `to_agent === 'any'`;
   * for directed handoffs the target is already known. Agents viewing
   * the pending handoff in a preface can use this to decide whether
   * they are the best fit even though anyone could accept.
   */
  suggested_candidates?: CandidateScore[];
}

export interface HandoffObservation {
  id: number;
  ts: number;
  meta: HandoffMetadata;
}

export interface HandOffArgs {
  from_session_id: string;
  from_agent: string;
  to_agent: HandoffTarget;
  to_session_id?: string;
  summary: string;
  next_steps?: string[];
  blockers?: string[];
  released_files?: string[];
  transferred_files?: string[];
  expires_in_ms?: number;
}

const DEFAULT_HANDOFF_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * TaskThread wraps MemoryStore + Storage with task-scoped coordination
 * operations. Posts flow through MemoryStore so the compression + redaction
 * pipeline applies to coordination prose the same way it does to observations.
 */
export class TaskThread {
  constructor(
    private store: MemoryStore,
    public readonly task_id: number,
  ) {}

  /**
   * Find-or-create the task for a (repo_root, branch) pair. The first agent
   * to land on a branch creates; any later agent on the same branch joins
   * the existing row. `session_id` is recorded as `created_by` but does not
   * own the task — any participant can post, hand off, or accept.
   */
  static open(
    store: MemoryStore,
    opts: { repo_root: string; branch: string; title?: string; session_id: string },
  ): TaskThread {
    const row = store.storage.findOrCreateTask({
      title: opts.title ?? opts.branch,
      repo_root: opts.repo_root,
      branch: opts.branch,
      created_by: opts.session_id,
    });
    return new TaskThread(store, row.id);
  }

  task(): TaskRow | undefined {
    return this.store.storage.getTask(this.task_id);
  }

  join(session_id: string, agent: string): void {
    this.store.storage.addTaskParticipant({ task_id: this.task_id, session_id, agent });
  }

  participants(): TaskParticipantRow[] {
    return this.store.storage.listParticipants(this.task_id);
  }

  claims(): TaskClaimRow[] {
    return this.store.storage.listClaims(this.task_id);
  }

  timeline(limit = 50): ObservationRow[] {
    return this.store.storage.taskTimeline(this.task_id, limit);
  }

  updatesSince(since_ts: number, limit = 50): ObservationRow[] {
    return this.store.storage.taskObservationsSince(this.task_id, since_ts, limit);
  }

  /**
   * Post a coordination message. Handoffs must go through handOff() instead
   * because they have transactional side effects on claims.
   */
  post(p: {
    session_id: string;
    kind: Exclude<CoordinationKind, 'handoff'>;
    content: string;
    reply_to?: number;
    metadata?: Record<string, unknown>;
  }): number {
    const id = this.store.addObservation({
      session_id: p.session_id,
      kind: p.kind,
      content: p.content,
      task_id: this.task_id,
      reply_to: p.reply_to ?? null,
      metadata: { kind: p.kind, ...(p.metadata ?? {}) },
    });
    this.store.storage.touchTask(this.task_id);
    return id;
  }

  /**
   * Record an explicit file claim. Advisory only — edits are never blocked,
   * but the PostToolUse hook surfaces the overlap next turn.
   */
  claimFile(p: { session_id: string; file_path: string; note?: string }): number {
    return this.store.storage.transaction(() => {
      this.store.storage.claimFile({
        task_id: this.task_id,
        file_path: p.file_path,
        session_id: p.session_id,
      });
      return this.store.addObservation({
        session_id: p.session_id,
        kind: 'claim',
        content: p.note ? `claim ${p.file_path} — ${p.note}` : `claim ${p.file_path}`,
        task_id: this.task_id,
        metadata: { kind: 'claim', file_path: p.file_path },
      });
    });
  }

  /**
   * The handoff primitive. Three writes — release old claims, drop claims
   * earmarked for transfer, record the handoff observation — run inside a
   * single SQLite transaction so the baton can't get lost mid-pass. Claims
   * on transferred files are *dropped* here and *re-installed* only when
   * the receiver calls acceptHandoff; this prevents a third agent from
   * grabbing a transferred file in the gap.
   */
  handOff(args: HandOffArgs): number {
    const now = Date.now();
    const meta: HandoffMetadata = {
      kind: 'handoff',
      from_session_id: args.from_session_id,
      from_agent: args.from_agent,
      to_agent: args.to_agent,
      to_session_id: args.to_session_id ?? null,
      summary: args.summary,
      next_steps: args.next_steps ?? [],
      blockers: args.blockers ?? [],
      released_files: args.released_files ?? [],
      transferred_files: args.transferred_files ?? [],
      status: 'pending',
      accepted_by_session_id: null,
      accepted_at: null,
      expires_at: now + (args.expires_in_ms ?? DEFAULT_HANDOFF_TTL_MS),
    };
    // For broadcast handoffs, rank candidate agents by capability fit so
    // the preface can surface "best match" hints without each receiver
    // recomputing the score. We snapshot at send time because profiles
    // are mutable and we want the routing reasoning to be reproducible
    // from the observation alone.
    if (meta.to_agent === 'any') {
      const distinctAgents = Array.from(
        new Set(
          this.store.storage
            .listParticipants(this.task_id)
            .filter((p) => p.session_id !== args.from_session_id)
            .map((p) => p.agent),
        ),
      );
      if (distinctAgents.length > 0) {
        const profiles: AgentProfile[] = distinctAgents.map((a) =>
          loadProfile(this.store.storage, a),
        );
        meta.suggested_candidates = rankCandidates(
          { summary: meta.summary, next_steps: meta.next_steps, blockers: meta.blockers },
          profiles,
        );
      }
    }
    return this.store.storage.transaction(() => {
      for (const path of meta.released_files) {
        this.store.storage.releaseClaim({
          task_id: this.task_id,
          file_path: path,
          session_id: args.from_session_id,
        });
      }
      for (const path of meta.transferred_files) {
        this.store.storage.releaseClaim({
          task_id: this.task_id,
          file_path: path,
          session_id: args.from_session_id,
        });
      }
      const id = this.store.addObservation({
        session_id: args.from_session_id,
        kind: 'handoff',
        content: renderHandoffContent(meta),
        task_id: this.task_id,
        metadata: meta as unknown as Record<string, unknown>,
      });
      this.store.storage.touchTask(this.task_id, now);
      return id;
    });
  }

  /**
   * Receiver-side of the baton pass. Validates targeting + TTL, installs the
   * transferred claims under the new owner, and flips the handoff status to
   * `accepted`. The sender's next turn will see the accepted status via the
   * UserPromptSubmit hook injection.
   */
  acceptHandoff(handoff_observation_id: number, session_id: string): void {
    const obs = this.store.storage.getObservation(handoff_observation_id);
    if (!obs || obs.kind !== 'handoff') {
      throw new Error(`observation ${handoff_observation_id} is not a handoff`);
    }
    if (obs.task_id !== this.task_id) {
      throw new Error(`handoff belongs to task ${obs.task_id}, not ${this.task_id}`);
    }
    const meta = parseHandoff(obs.metadata);
    if (!meta) throw new Error('handoff metadata missing');
    if (meta.status !== 'pending') throw new Error(`handoff is ${meta.status}, cannot accept`);
    if (Date.now() > meta.expires_at) {
      meta.status = 'expired';
      this.store.storage.updateObservationMetadata(handoff_observation_id, JSON.stringify(meta));
      throw new Error('handoff expired');
    }
    if (meta.to_session_id && meta.to_session_id !== session_id) {
      throw new Error('handoff is addressed to a different session');
    }
    const myAgent = this.store.storage.getParticipantAgent(this.task_id, session_id);
    if (meta.to_agent !== 'any' && myAgent && meta.to_agent !== myAgent) {
      throw new Error(`handoff is for ${meta.to_agent}, not ${myAgent}`);
    }

    this.store.storage.transaction(() => {
      for (const path of meta.transferred_files) {
        this.store.storage.claimFile({
          task_id: this.task_id,
          file_path: path,
          session_id,
        });
      }
      meta.status = 'accepted';
      meta.accepted_by_session_id = session_id;
      meta.accepted_at = Date.now();
      this.store.storage.updateObservationMetadata(handoff_observation_id, JSON.stringify(meta));
      this.store.storage.touchTask(this.task_id);
    });
  }

  /** Explicitly decline a pending handoff. Records a `decline` observation
   *  and flips the handoff status to `cancelled`. No claims are touched. */
  declineHandoff(handoff_observation_id: number, session_id: string, reason?: string): void {
    const obs = this.store.storage.getObservation(handoff_observation_id);
    if (!obs || obs.kind !== 'handoff') throw new Error('not a handoff');
    if (obs.task_id !== this.task_id) throw new Error('handoff belongs to a different task');
    const meta = parseHandoff(obs.metadata);
    if (!meta) throw new Error('handoff metadata missing');
    if (meta.status !== 'pending') throw new Error(`handoff is ${meta.status}`);
    this.store.storage.transaction(() => {
      meta.status = 'cancelled';
      this.store.storage.updateObservationMetadata(handoff_observation_id, JSON.stringify(meta));
      this.store.addObservation({
        session_id,
        kind: 'decline',
        content: reason
          ? `declined handoff #${handoff_observation_id}: ${reason}`
          : `declined handoff #${handoff_observation_id}`,
        task_id: this.task_id,
        reply_to: handoff_observation_id,
        metadata: { kind: 'decline', declined_handoff: handoff_observation_id },
      });
      this.store.storage.touchTask(this.task_id);
    });
  }

  /** Pending, unexpired handoffs visible to `session_id` / `agent`. */
  pendingHandoffsFor(session_id: string, agent: string): HandoffObservation[] {
    const now = Date.now();
    return this.store.storage
      .taskObservationsByKind(this.task_id, 'handoff')
      .map((row) => {
        const meta = parseHandoff(row.metadata);
        return meta ? { id: row.id, ts: row.ts, meta } : null;
      })
      .filter((x): x is HandoffObservation => x !== null)
      .filter(
        ({ meta }) =>
          meta.status === 'pending' &&
          now < meta.expires_at &&
          meta.from_session_id !== session_id &&
          (meta.to_session_id === session_id || meta.to_agent === 'any' || meta.to_agent === agent),
      );
  }
}

function parseHandoff(metadata: string | null): HandoffMetadata | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const m = parsed as Partial<HandoffMetadata>;
    if (m.kind !== 'handoff' || typeof m.status !== 'string') return null;
    return parsed as HandoffMetadata;
  } catch {
    return null;
  }
}

function renderHandoffContent(m: HandoffMetadata): string {
  const lines = [
    `HANDOFF from ${m.from_agent} -> ${m.to_session_id ?? m.to_agent}`,
    `Summary: ${m.summary}`,
  ];
  if (m.next_steps.length) {
    lines.push(`Next steps:\n${m.next_steps.map((s) => `  - ${s}`).join('\n')}`);
  }
  if (m.blockers.length) {
    lines.push(`Blockers:\n${m.blockers.map((s) => `  - ${s}`).join('\n')}`);
  }
  if (m.transferred_files.length) {
    lines.push(`Claims transferred: ${m.transferred_files.join(', ')}`);
  }
  if (m.released_files.length) {
    lines.push(`Claims released: ${m.released_files.join(', ')}`);
  }
  return lines.join('\n');
}
