import type {
  LinkedTask,
  ObservationRow,
  TaskClaimRow,
  TaskLinkRow,
  TaskParticipantRow,
  TaskRow,
} from '@colony/storage';
import { classifyClaimAge, isStrongClaimAge } from './claim-age.js';
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
  | NegativeCoordinationKind
  | 'note'
  | 'wake_request'
  | 'wake_ack'
  | 'wake_cancel'
  | 'message'
  | 'message_read'
  | 'message_retract'
  | 'relay';

export const NEGATIVE_COORDINATION_KINDS = [
  'failed_approach',
  'blocked_path',
  'conflict_warning',
  'reverted_solution',
] as const;

export type NegativeCoordinationKind = (typeof NEGATIVE_COORDINATION_KINDS)[number];

export function isNegativeCoordinationKind(kind: string): kind is NegativeCoordinationKind {
  return (NEGATIVE_COORDINATION_KINDS as readonly string[]).includes(kind);
}

export type HandoffStatus = 'pending' | 'accepted' | 'expired' | 'cancelled';
export type HandoffTarget = 'claude' | 'codex' | 'any';
export type HandoffReason = 'quota_exhausted' | string;
export type HandoffRuntimeStatus = 'blocked_by_runtime_limit' | string;

export type WakeStatus = 'pending' | 'acknowledged' | 'expired' | 'cancelled';
export type WakeTarget = 'claude' | 'codex' | 'any';

export type MessageStatus = 'unread' | 'read' | 'replied' | 'expired' | 'retracted';
export type MessageTarget = 'claude' | 'codex' | 'any';
export type MessageUrgency = 'fyi' | 'needs_reply' | 'blocking';

export type RelayStatus = 'pending' | 'accepted' | 'expired' | 'cancelled';
export type RelayTarget = 'claude' | 'codex' | 'any';
export type RelayReason = 'quota' | 'rate-limit' | 'turn-cap' | 'manual' | 'unspecified';

export const TASK_THREAD_ERROR_CODES = {
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  OBSERVATION_NOT_ON_TASK: 'OBSERVATION_NOT_ON_TASK',
  NOT_HANDOFF: 'NOT_HANDOFF',
  NOT_WAKE_REQUEST: 'NOT_WAKE_REQUEST',
  NOT_MESSAGE: 'NOT_MESSAGE',
  TASK_MISMATCH: 'TASK_MISMATCH',
  METADATA_MISSING: 'METADATA_MISSING',
  ALREADY_ACCEPTED: 'ALREADY_ACCEPTED',
  ALREADY_ACKNOWLEDGED: 'ALREADY_ACKNOWLEDGED',
  ALREADY_CANCELLED: 'ALREADY_CANCELLED',
  ALREADY_REPLIED: 'ALREADY_REPLIED',
  ALREADY_RETRACTED: 'ALREADY_RETRACTED',
  ALREADY_CLAIMED: 'ALREADY_CLAIMED',
  HANDOFF_EXPIRED: 'HANDOFF_EXPIRED',
  WAKE_EXPIRED: 'WAKE_EXPIRED',
  MESSAGE_EXPIRED: 'MESSAGE_EXPIRED',
  RELAY_EXPIRED: 'RELAY_EXPIRED',
  NOT_BROADCAST: 'NOT_BROADCAST',
  NOT_SENDER: 'NOT_SENDER',
  NOT_TARGET_SESSION: 'NOT_TARGET_SESSION',
  NOT_PARTICIPANT: 'NOT_PARTICIPANT',
  NOT_TARGET_AGENT: 'NOT_TARGET_AGENT',
  NOT_RELAY: 'NOT_RELAY',
  CLAIM_NOT_FOUND: 'CLAIM_NOT_FOUND',
  CLAIM_NOT_QUOTA_PENDING: 'CLAIM_NOT_QUOTA_PENDING',
  CLAIM_BATON_MISSING: 'CLAIM_BATON_MISSING',
  CLAIM_BATON_CONFLICT: 'CLAIM_BATON_CONFLICT',
  INVALID_CLAIM_PATH: 'INVALID_CLAIM_PATH',
} as const;

export type TaskThreadErrorCode =
  (typeof TASK_THREAD_ERROR_CODES)[keyof typeof TASK_THREAD_ERROR_CODES];

export class TaskThreadError extends Error {
  readonly code: TaskThreadErrorCode;

  constructor(code: TaskThreadErrorCode, message: string) {
    super(message);
    this.name = 'TaskThreadError';
    this.code = code;
  }
}

function taskError(code: TaskThreadErrorCode, message: string): TaskThreadError {
  return new TaskThreadError(code, message);
}

function statusErrorCode(
  status: HandoffStatus | WakeStatus | RelayStatus,
  kind: 'handoff' | 'wake' | 'relay',
): TaskThreadErrorCode {
  if (status === 'accepted') return TASK_THREAD_ERROR_CODES.ALREADY_ACCEPTED;
  if (status === 'acknowledged') return TASK_THREAD_ERROR_CODES.ALREADY_ACKNOWLEDGED;
  if (status === 'cancelled') return TASK_THREAD_ERROR_CODES.ALREADY_CANCELLED;
  if (status === 'expired') {
    if (kind === 'handoff') return TASK_THREAD_ERROR_CODES.HANDOFF_EXPIRED;
    if (kind === 'wake') return TASK_THREAD_ERROR_CODES.WAKE_EXPIRED;
    return TASK_THREAD_ERROR_CODES.RELAY_EXPIRED;
  }
  return TASK_THREAD_ERROR_CODES.METADATA_MISSING;
}

/**
 * Structured payload for a wake_request observation. Kept in metadata so the
 * hook preface can render it without decompressing content. Mirrors the
 * HandoffMetadata shape on purpose — the two primitives have symmetric
 * lifecycle (pending → terminal) and symmetric eligibility rules. A wake is
 * a lighter-weight nudge: no claim transfer, no baton pass, just "please
 * attend to this on your next turn".
 */
export interface WakeRequestMetadata {
  kind: 'wake_request';
  from_session_id: string;
  from_agent: string;
  to_agent: WakeTarget;
  to_session_id: string | null;
  reason: string;
  next_step: string;
  status: WakeStatus;
  acknowledged_by_session_id: string | null;
  acknowledged_at: number | null;
  expires_at: number;
}

export interface WakeRequestObservation {
  id: number;
  ts: number;
  meta: WakeRequestMetadata;
}

export interface RequestWakeArgs {
  from_session_id: string;
  from_agent: string;
  to_agent: WakeTarget;
  to_session_id?: string;
  reason: string;
  next_step?: string;
  expires_in_ms?: number;
}

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
  handoff_ttl_ms: number;
  reason?: HandoffReason;
  runtime_status?: HandoffRuntimeStatus;
  quota_context?: QuotaExhaustedHandoffContext;
  /**
   * Ranking of candidate agents by capability fit against this handoff,
   * snapshotted at send time. Only populated when `to_agent === 'any'`;
   * for directed handoffs the target is already known. Agents viewing
   * the pending handoff in a preface can use this to decide whether
   * they are the best fit even though anyone could accept.
   */
  suggested_candidates?: CandidateScore[];
  quota_claim_declines?: QuotaClaimDecline[];
}

export interface QuotaClaimDecline {
  session_id: string;
  reason: string | null;
  declined_at: number;
  file_paths: string[];
}

export interface QuotaExhaustedHandoffContext {
  agent: string;
  session_id: string;
  repo_root: string | null;
  branch: string | null;
  worktree_path: string | null;
  task_id: number | null;
  claimed_files: string[];
  dirty_files: string[];
  last_command: string | null;
  last_tool: string | null;
  last_verification: {
    command: string | null;
    result: string | null;
  } | null;
  suggested_next_step: string;
  handoff_ttl_ms: number;
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
  reason?: HandoffReason;
  runtime_status?: HandoffRuntimeStatus;
  quota_context?: QuotaExhaustedHandoffContext;
}

/**
 * Direct-message metadata persisted on an observation with kind='message'.
 * Reuses the task_post storage path with explicit addressing + a read/reply
 * lifecycle, kept parallel to Handoff/Wake so the preface renderer can treat
 * all three coordination primitives uniformly. No schema migration: the
 * content body goes through `MemoryStore.addObservation` (compressed), while
 * the structured fields below live in `observations.metadata` as JSON.
 *
 * `status` transitions:
 *   - `unread`    → set at send time
 *   - `read`      → set by `markMessageRead` on the recipient's fetch (advisory)
 *   - `replied`   → set on *write* when someone posts with `reply_to=<this id>`;
 *                   authoritative — overrides `read`. Flipping on write (not
 *                   read) avoids a race where the sender could see their own
 *                   reply round-tripped as still-unread.
 *   - `expired`   → set by `markMessageRead`/`retractMessage`/`postMessage(reply_to=…)`
 *                   when the message's `expires_at` is in the past. Lazy: list
 *                   queries simply hide expired rows by computing the predicate
 *                   client-side, mirroring the `pendingHandoffsFor` pattern.
 *   - `retracted` → set by `retractMessage` when the original sender retracts.
 *                   The body stays in storage (still searchable, still in
 *                   timeline) but the inbox view shows a terse retraction
 *                   stub instead of the original preview.
 *
 * Reply-chain depth: `reply_to` is **1-deep authoritative**. We flip *only*
 * the immediate parent's status, never a transitively-referenced ancestor.
 * Replies-to-replies are allowed but only the immediate parent's status
 * changes, and there is no thread-root tracking. If you want a long thread,
 * model it as `task_post` notes; messages are for short directed exchanges.
 *
 * Broadcast claim: `to_agent='any' && to_session_id===null` messages are
 * visible to every non-sender participant by default. Once any agent calls
 * `claimBroadcastMessage` (or replies to it), `claimed_by_session_id` /
 * `claimed_by_agent` / `claimed_at` are set and the message drops out of
 * other agents' inboxes — only the claimer keeps seeing it. Replying to a
 * still-unclaimed broadcast auto-claims for the replier.
 */
export interface MessageMetadata {
  kind: 'message';
  from_session_id: string;
  from_agent: string;
  to_agent: MessageTarget;
  to_session_id: string | null;
  urgency: MessageUrgency;
  status: MessageStatus;
  read_by_session_id: string | null;
  read_at: number | null;
  replied_by_observation_id: number | null;
  replied_at: number | null;
  /** Absolute ms-epoch when this message stops surfacing in inbox queries.
   *  null = no TTL; the message is visible until explicitly read/replied/retracted. */
  expires_at: number | null;
  retracted_at: number | null;
  retract_reason: string | null;
  /** Set when an agent claims (or auto-claims via reply) a `to_agent=any`
   *  broadcast. Hides the message from other agents' inboxes; the claimer
   *  keeps seeing it. Always null on directed messages. */
  claimed_by_session_id: string | null;
  claimed_by_agent: string | null;
  claimed_at: number | null;
}

export interface MessageObservation {
  id: number;
  ts: number;
  meta: MessageMetadata;
}

export interface PostMessageArgs {
  from_session_id: string;
  from_agent: string;
  to_agent: MessageTarget;
  to_session_id?: string;
  content: string;
  reply_to?: number;
  urgency?: MessageUrgency;
  /** Optional TTL in ms. If omitted, the message has no expiry. Mirrors the
   *  handoff/wake `expires_in_ms` shape so MCP tool layers can present a
   *  uniform "expires_in_minutes" affordance. */
  expires_in_ms?: number;
}

export function isMessageAddressedTo(
  meta: MessageMetadata,
  session_id: string,
  agent: string,
): boolean {
  if (meta.to_session_id !== null) return meta.to_session_id === session_id;
  if (meta.to_agent === 'any') return true;
  return meta.to_agent === agent;
}

/**
 * Structured payload for a relay observation. Relays are what happens when
 * an agent has to stop mid-task — quota cut, rate limit, turn cap — and
 * another agent needs to continue without rebuilding context. The sender
 * writes a one-line reason; the rest is auto-synthesized from the task
 * thread so a hook firing seconds before the process dies still produces a
 * resumable packet.
 *
 * Difference from HandoffMetadata: handoffs assume the sender can write
 * `next_steps`; relays assume the sender is gone, weaken their claims into
 * handoff-pending ownership (no recipient is bound at emit time), and bundle
 * a `worktree_recipe` so a receiver in a different worktree knows how to set
 * up their tree before editing.
 */
export interface RelayMetadata {
  kind: 'relay';
  from_session_id: string;
  from_agent: string;
  to_agent: RelayTarget;
  to_session_id: string | null;
  reason: RelayReason;
  /** One sentence the sender provides; everything else is synthesized. */
  one_line: string;
  /**
   * Snapshot of recent task activity, built once at emit time so the
   * receiver sees a stable view rather than racing concurrent writes.
   */
  resumable_state: {
    last_files_edited: Array<{ file_path: string; ts: number; session_id: string }>;
    active_claims: Array<{ file_path: string; held_by: string }>;
    /** Last handoff summary or relay one_line, whichever is more recent. */
    last_handoff_summary: string | null;
    recent_decisions: Array<{ id: number; content: string; ts: number }>;
    open_blockers: Array<{ id: number; content: string; ts: number }>;
    relevant_search_seeds: string[];
  };
  /**
   * Recipe for setting up an equivalent worktree. `fetch_files_at` is the
   * git sha the sender was at when their work was committed; null means the
   * work was uncommitted and `untracked_files_warning` lists paths the
   * receiver cannot reproduce from git alone.
   */
  worktree_recipe: {
    base_branch: string;
    inherit_claims: string[];
    fetch_files_at: string | null;
    untracked_files_warning: string[];
  };
  status: RelayStatus;
  accepted_by_session_id: string | null;
  accepted_at: number | null;
  expires_at: number;
  quota_claim_declines?: QuotaClaimDecline[];
}

export interface RelayObservation {
  id: number;
  ts: number;
  meta: RelayMetadata;
}

export interface RelayArgs {
  from_session_id: string;
  from_agent: string;
  reason: RelayReason;
  one_line: string;
  base_branch: string;
  to_agent?: RelayTarget;
  to_session_id?: string;
  fetch_files_at?: string;
  expires_in_ms?: number;
}

export interface QuotaClaimResolveArgs {
  session_id: string;
  file_path?: string | undefined;
  handoff_observation_id?: number | undefined;
  reason?: string | undefined;
  now?: number | undefined;
}

export interface QuotaClaimAcceptResult {
  status: 'accepted';
  task_id: number;
  handoff_observation_id: number;
  baton_kind: 'handoff' | 'relay';
  accepted_by_session_id: string;
  accepted_files: string[];
  previous_session_ids: string[];
  audit_observation_id: number;
}

export interface QuotaClaimDeclineResult {
  status: 'declined';
  task_id: number;
  handoff_observation_id: number;
  baton_kind: 'handoff' | 'relay';
  declined_by_session_id: string;
  declined_files: string[];
  still_visible: true;
  audit_observation_id: number;
}

export interface QuotaClaimReleaseExpiredResult {
  status: 'released_expired';
  task_id: number;
  released_claims: Array<{
    file_path: string;
    previous_session_id: string;
    handoff_observation_id: number | null;
    state: 'weak_expired';
  }>;
  audit_observation_ids: number[];
}

/** True when this message was sent as a broadcast (`to_agent='any'`,
 *  no specific `to_session_id`). Broadcasts can be claimed; directed
 *  messages cannot. */
export function isBroadcastMessage(meta: MessageMetadata): boolean {
  return meta.to_agent === 'any' && meta.to_session_id === null;
}

const DEFAULT_HANDOFF_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_WAKE_TTL_MS = 24 * 60 * 60 * 1000;
// Relays expire faster than handoffs because the work they describe goes
// stale fast. A relay 6+ hours old usually means the codebase has moved and
// a fresh agent should re-plan, not pick up.
const DEFAULT_RELAY_TTL_MS = 4 * 60 * 60 * 1000;

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

  /**
   * Tasks linked to this one, in either direction. Cross-task links let an
   * agent on a "frontend" task see decisions/blockers from a paired
   * "backend" task without copy-paste — the inbox / preface scans
   * linkedTimeline() the same way it scans this task's own timeline.
   */
  linkedTasks(): LinkedTask[] {
    return this.store.storage.linkedTasks(this.task_id);
  }

  /**
   * Symmetric link operation. Either side can call; the storage layer
   * normalises (low_id, high_id) so re-links are idempotent. Note is
   * optional and renders next to the link in attention prefaces.
   */
  link(other_task_id: number, created_by: string, note?: string): TaskLinkRow {
    return this.store.storage.linkTasks({
      task_id_a: this.task_id,
      task_id_b: other_task_id,
      created_by,
      ...(note !== undefined ? { note } : {}),
    });
  }

  unlink(other_task_id: number): boolean {
    return this.store.storage.unlinkTasks(this.task_id, other_task_id);
  }

  timeline(limit = 50): ObservationRow[] {
    return this.store.storage.taskTimeline(this.task_id, limit);
  }

  updatesSince(since_ts: number, limit = 50): ObservationRow[] {
    return this.store.storage.taskObservationsSince(this.task_id, since_ts, limit);
  }

  /**
   * Post a coordination message. Handoffs and direct messages have dedicated
   * paths (handOff, postMessage) because they carry typed metadata the
   * preface renderer relies on — routing both through the generic post()
   * would let a caller accidentally write a raw message-kind row without the
   * addressing/status fields that downstream inbox queries expect.
   */
  post(p: {
    session_id: string;
    kind: Exclude<CoordinationKind, 'handoff' | 'message' | 'relay'>;
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
  claimFile(p: {
    session_id: string;
    file_path: string;
    note?: string;
    metadata?: Record<string, unknown>;
  }): number {
    const filePath = this.store.storage.normalizeTaskFilePath(this.task_id, p.file_path);
    if (filePath === null)
      throw taskError(TASK_THREAD_ERROR_CODES.INVALID_CLAIM_PATH, 'claim path is not claimable');
    return this.store.storage.transaction(() => {
      this.store.storage.claimFile({
        task_id: this.task_id,
        file_path: filePath,
        session_id: p.session_id,
      });
      return this.store.addObservation({
        session_id: p.session_id,
        kind: 'claim',
        content: p.note ? `claim ${filePath} — ${p.note}` : `claim ${filePath}`,
        task_id: this.task_id,
        metadata: { kind: 'claim', file_path: filePath, ...(p.metadata ?? {}) },
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
    const handoff_ttl_ms = args.expires_in_ms ?? DEFAULT_HANDOFF_TTL_MS;
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
      expires_at: now + handoff_ttl_ms,
      handoff_ttl_ms,
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
      ...(args.runtime_status !== undefined ? { runtime_status: args.runtime_status } : {}),
      ...(args.quota_context !== undefined ? { quota_context: args.quota_context } : {}),
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
    const quotaPendingClaimFiles =
      meta.reason === 'quota_exhausted'
        ? Array.from(
            new Set(
              this.claims()
                .filter((claim) => claim.session_id === args.from_session_id)
                .filter((claim) => claim.state === 'active')
                .map((claim) => claim.file_path)
                .filter((path) => !meta.released_files.includes(path))
                .filter((path) => !meta.transferred_files.includes(path)),
            ),
          )
        : [];
    if (meta.reason === 'quota_exhausted' && meta.quota_context) {
      meta.quota_context = {
        ...meta.quota_context,
        claimed_files: Array.from(
          new Set([...meta.quota_context.claimed_files, ...quotaPendingClaimFiles]),
        ),
      };
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
      for (const path of quotaPendingClaimFiles) {
        this.store.storage.markClaimHandoffPending({
          task_id: this.task_id,
          file_path: path,
          session_id: args.from_session_id,
          expires_at: meta.expires_at,
          handoff_observation_id: id,
        });
        this.store.addObservation({
          session_id: args.from_session_id,
          kind: 'claim-weakened',
          content: `claim ${path} weakened to handoff_pending by quota_exhausted handoff #${id}`,
          task_id: this.task_id,
          reply_to: id,
          metadata: {
            kind: 'claim-weakened',
            file_path: path,
            ownership_strength: 'weak',
            state: 'handoff_pending',
            reason: 'quota_exhausted',
            handoff_observation_id: id,
            expires_at: meta.expires_at,
          },
        });
      }
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
      throw taskError(
        TASK_THREAD_ERROR_CODES.NOT_HANDOFF,
        `observation ${handoff_observation_id} is not a handoff`,
      );
    }
    if (obs.task_id !== this.task_id) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.TASK_MISMATCH,
        `handoff belongs to task ${obs.task_id}, not ${this.task_id}`,
      );
    }
    const meta = parseHandoff(obs.metadata, obs.ts);
    if (!meta) {
      throw taskError(TASK_THREAD_ERROR_CODES.METADATA_MISSING, 'handoff metadata missing');
    }
    if (meta.status !== 'pending') {
      throw taskError(
        statusErrorCode(meta.status, 'handoff'),
        `handoff is ${meta.status}, cannot accept`,
      );
    }
    if (handoffExpired(meta)) {
      meta.status = 'expired';
      this.store.storage.updateObservationMetadata(handoff_observation_id, JSON.stringify(meta));
      throw taskError(TASK_THREAD_ERROR_CODES.HANDOFF_EXPIRED, 'handoff expired');
    }
    if (meta.to_session_id && meta.to_session_id !== session_id) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.NOT_TARGET_SESSION,
        'handoff is addressed to a different session',
      );
    }
    const myAgent = this.store.storage.getParticipantAgent(this.task_id, session_id);
    if (!myAgent) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.NOT_PARTICIPANT,
        'session is not a participant on this task',
      );
    }
    if (meta.to_agent !== 'any' && myAgent && meta.to_agent !== myAgent) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.NOT_TARGET_AGENT,
        `handoff is for ${meta.to_agent}, not ${myAgent}`,
      );
    }

    const inheritedQuotaPendingFiles =
      meta.reason === 'quota_exhausted'
        ? this.claims()
            .filter((claim) => claim.session_id === meta.from_session_id)
            .filter((claim) => claim.state === 'handoff_pending')
            .filter((claim) => claim.handoff_observation_id === handoff_observation_id)
            .map((claim) => claim.file_path)
        : [];
    const filesToClaim = Array.from(
      new Set([...meta.transferred_files, ...inheritedQuotaPendingFiles]),
    );

    this.store.storage.transaction(() => {
      for (const path of filesToClaim) {
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
    if (!obs || obs.kind !== 'handoff') {
      throw taskError(TASK_THREAD_ERROR_CODES.NOT_HANDOFF, 'not a handoff');
    }
    if (obs.task_id !== this.task_id) {
      throw taskError(TASK_THREAD_ERROR_CODES.TASK_MISMATCH, 'handoff belongs to a different task');
    }
    const meta = parseHandoff(obs.metadata, obs.ts);
    if (!meta) {
      throw taskError(TASK_THREAD_ERROR_CODES.METADATA_MISSING, 'handoff metadata missing');
    }
    if (meta.status !== 'pending') {
      throw taskError(statusErrorCode(meta.status, 'handoff'), `handoff is ${meta.status}`);
    }
    if (handoffExpired(meta)) {
      meta.status = 'expired';
      this.store.storage.updateObservationMetadata(handoff_observation_id, JSON.stringify(meta));
      throw taskError(TASK_THREAD_ERROR_CODES.HANDOFF_EXPIRED, 'handoff expired');
    }
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
  pendingHandoffsFor(session_id: string, agent: string, now = Date.now()): HandoffObservation[] {
    return this.store.storage
      .taskObservationsByKind(this.task_id, 'handoff')
      .map((row) => {
        const meta = parseHandoff(row.metadata, row.ts);
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

  expiredQuotaHandoffsFor(
    session_id: string,
    agent: string,
    now = Date.now(),
  ): HandoffObservation[] {
    return this.store.storage
      .taskObservationsByKind(this.task_id, 'handoff')
      .map((row) => {
        const meta = parseHandoff(row.metadata, row.ts);
        return meta ? { id: row.id, ts: row.ts, meta } : null;
      })
      .filter((x): x is HandoffObservation => x !== null)
      .filter(
        ({ meta }) =>
          meta.reason === 'quota_exhausted' &&
          meta.status === 'pending' &&
          now >= meta.expires_at &&
          meta.from_session_id !== session_id &&
          (meta.to_session_id === session_id || meta.to_agent === 'any' || meta.to_agent === agent),
      );
  }

  /**
   * Post a wake request. A wake is a lightweight nudge — no claim transfer,
   * no baton pass — that surfaces to the target on their next SessionStart
   * or UserPromptSubmit turn. Use when an idle/stalled session needs to
   * attend to something but a full handoff would be the wrong shape
   * (e.g. review is needed, not ownership transfer).
   */
  requestWake(args: RequestWakeArgs): number {
    const now = Date.now();
    const meta: WakeRequestMetadata = {
      kind: 'wake_request',
      from_session_id: args.from_session_id,
      from_agent: args.from_agent,
      to_agent: args.to_agent,
      to_session_id: args.to_session_id ?? null,
      reason: args.reason,
      next_step: args.next_step ?? '',
      status: 'pending',
      acknowledged_by_session_id: null,
      acknowledged_at: null,
      expires_at: now + (args.expires_in_ms ?? DEFAULT_WAKE_TTL_MS),
    };
    const id = this.store.addObservation({
      session_id: args.from_session_id,
      kind: 'wake_request',
      content: renderWakeContent(meta),
      task_id: this.task_id,
      metadata: meta as unknown as Record<string, unknown>,
    });
    this.store.storage.touchTask(this.task_id, now);
    return id;
  }

  /**
   * Acknowledge a pending wake request. Flips status to `acknowledged` and
   * records a wake_ack observation replying to the original. The sender
   * sees the ack in their next task-updates preface. Unlike handoffs no
   * claim state moves.
   */
  acknowledgeWake(wake_observation_id: number, session_id: string): void {
    const obs = this.store.storage.getObservation(wake_observation_id);
    if (!obs || obs.kind !== 'wake_request') {
      throw taskError(
        TASK_THREAD_ERROR_CODES.NOT_WAKE_REQUEST,
        `observation ${wake_observation_id} is not a wake_request`,
      );
    }
    if (obs.task_id !== this.task_id) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.TASK_MISMATCH,
        `wake belongs to task ${obs.task_id}, not ${this.task_id}`,
      );
    }
    const meta = parseWake(obs.metadata);
    if (!meta) throw taskError(TASK_THREAD_ERROR_CODES.METADATA_MISSING, 'wake metadata missing');
    if (meta.status !== 'pending') {
      throw taskError(
        statusErrorCode(meta.status, 'wake'),
        `wake is ${meta.status}, cannot acknowledge`,
      );
    }
    if (Date.now() > meta.expires_at) {
      meta.status = 'expired';
      this.store.storage.updateObservationMetadata(wake_observation_id, JSON.stringify(meta));
      throw taskError(TASK_THREAD_ERROR_CODES.WAKE_EXPIRED, 'wake expired');
    }
    if (meta.to_session_id && meta.to_session_id !== session_id) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.NOT_TARGET_SESSION,
        'wake is addressed to a different session',
      );
    }
    const myAgent = this.store.storage.getParticipantAgent(this.task_id, session_id);
    if (!myAgent) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.NOT_PARTICIPANT,
        'session is not a participant on this task',
      );
    }
    if (meta.to_agent !== 'any' && myAgent && meta.to_agent !== myAgent) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.NOT_TARGET_AGENT,
        `wake is for ${meta.to_agent}, not ${myAgent}`,
      );
    }

    this.store.storage.transaction(() => {
      meta.status = 'acknowledged';
      meta.acknowledged_by_session_id = session_id;
      meta.acknowledged_at = Date.now();
      this.store.storage.updateObservationMetadata(wake_observation_id, JSON.stringify(meta));
      this.store.addObservation({
        session_id,
        kind: 'wake_ack',
        content: `acknowledged wake #${wake_observation_id}`,
        task_id: this.task_id,
        reply_to: wake_observation_id,
        metadata: { kind: 'wake_ack', wake_observation_id },
      });
      this.store.storage.touchTask(this.task_id);
    });
  }

  /**
   * Sender-side cancel. Only the original sender may cancel; target can
   * decline via a separate path (currently surfaced as an explicit cancel
   * from the target too — we accept both sides to keep the surface small).
   */
  cancelWake(wake_observation_id: number, session_id: string, reason?: string): void {
    const obs = this.store.storage.getObservation(wake_observation_id);
    if (!obs || obs.kind !== 'wake_request') {
      throw taskError(TASK_THREAD_ERROR_CODES.NOT_WAKE_REQUEST, 'not a wake_request');
    }
    if (obs.task_id !== this.task_id) {
      throw taskError(TASK_THREAD_ERROR_CODES.TASK_MISMATCH, 'wake belongs to a different task');
    }
    const meta = parseWake(obs.metadata);
    if (!meta) throw taskError(TASK_THREAD_ERROR_CODES.METADATA_MISSING, 'wake metadata missing');
    if (meta.status !== 'pending') {
      throw taskError(statusErrorCode(meta.status, 'wake'), `wake is ${meta.status}`);
    }
    this.store.storage.transaction(() => {
      meta.status = 'cancelled';
      this.store.storage.updateObservationMetadata(wake_observation_id, JSON.stringify(meta));
      this.store.addObservation({
        session_id,
        kind: 'wake_cancel',
        content: reason
          ? `cancelled wake #${wake_observation_id}: ${reason}`
          : `cancelled wake #${wake_observation_id}`,
        task_id: this.task_id,
        reply_to: wake_observation_id,
        metadata: { kind: 'wake_cancel', wake_observation_id },
      });
      this.store.storage.touchTask(this.task_id);
    });
  }

  /** Pending, unexpired wake requests visible to `session_id` / `agent`. */
  pendingWakesFor(session_id: string, agent: string): WakeRequestObservation[] {
    const now = Date.now();
    return this.store.storage
      .taskObservationsByKind(this.task_id, 'wake_request')
      .map((row) => {
        const meta = parseWake(row.metadata);
        return meta ? { id: row.id, ts: row.ts, meta } : null;
      })
      .filter((x): x is WakeRequestObservation => x !== null)
      .filter(
        ({ meta }) =>
          meta.status === 'pending' &&
          now < meta.expires_at &&
          meta.from_session_id !== session_id &&
          (meta.to_session_id === session_id || meta.to_agent === 'any' || meta.to_agent === agent),
      );
  }

  /**
   * Post a direct message on this task thread. A message is a task_post with
   * explicit addressing (to_agent / to_session_id) plus a read/reply
   * lifecycle. If `reply_to` points at another message, we flip the parent's
   * status to `replied` in the same transaction — authoritative on the
   * sender side so the sender sees resolution on their next read.
   *
   * If the parent is a still-unclaimed broadcast (`to_agent='any'`), the
   * reply also auto-claims it for this session — silent ownership take so
   * other participants stop seeing the broadcast in their inboxes.
   */
  postMessage(args: PostMessageArgs): number {
    const now = Date.now();
    const meta: MessageMetadata = {
      kind: 'message',
      from_session_id: args.from_session_id,
      from_agent: args.from_agent,
      to_agent: args.to_agent,
      to_session_id: args.to_session_id ?? null,
      urgency: args.urgency ?? 'fyi',
      status: 'unread',
      read_by_session_id: null,
      read_at: null,
      replied_by_observation_id: null,
      replied_at: null,
      expires_at: args.expires_in_ms !== undefined ? now + args.expires_in_ms : null,
      retracted_at: null,
      retract_reason: null,
      claimed_by_session_id: null,
      claimed_by_agent: null,
      claimed_at: null,
    };
    return this.store.storage.transaction(() => {
      const id = this.store.addObservation({
        session_id: args.from_session_id,
        kind: 'message',
        content: args.content,
        task_id: this.task_id,
        ...(args.reply_to !== undefined ? { reply_to: args.reply_to } : {}),
        metadata: meta as unknown as Record<string, unknown>,
      });
      if (args.reply_to !== undefined) {
        const parent = this.store.storage.getObservation(args.reply_to);
        // Guard on same-task before mutating parent metadata. A reply_to
        // pointing at another task would otherwise silently flip a foreign
        // message's status to 'replied' — the same asymmetry markMessageRead
        // already rejects via TASK_MISMATCH. Only message→message replies
        // flip status; replies onto non-message kinds (a reply to a
        // decline/note) are left alone so other primitives stay
        // authoritative over their own lifecycle.
        const parentMeta =
          parent && parent.task_id === this.task_id ? parseMessage(parent.metadata) : null;
        // Reply-chain depth is 1-deep: only the immediate parent flips. If
        // the parent is itself a reply, we do NOT walk up to flip the root.
        if (parentMeta && isReplyableStatus(parentMeta.status)) {
          parentMeta.status = 'replied';
          parentMeta.replied_by_observation_id = id;
          parentMeta.replied_at = now;
          // Auto-claim a still-unclaimed broadcast on reply. Replying *is*
          // engagement, so we don't make agents call task_message_claim
          // separately; explicit claim is for the silent-ownership case.
          if (
            isBroadcastMessage(parentMeta) &&
            parentMeta.claimed_by_session_id === null &&
            parentMeta.from_session_id !== args.from_session_id
          ) {
            parentMeta.claimed_by_session_id = args.from_session_id;
            parentMeta.claimed_by_agent = args.from_agent;
            parentMeta.claimed_at = now;
          }
          this.store.storage.updateObservationMetadata(args.reply_to, JSON.stringify(parentMeta));
        }
      }
      this.store.storage.touchTask(this.task_id);
      return id;
    });
  }

  /**
   * Mark a message as read by this session. Idempotent — re-marking a
   * already-read (or replied) message is a no-op so concurrent fetches from
   * the same recipient don't clobber the first reader's `read_at`. Returns
   * the resulting status for callers that want to short-circuit.
   *
   * Side effect: when this transitions `unread → read`, we also write a
   * sibling `message_read` observation. The original sender's preface
   * scans those siblings (filtering `original_sender_session_id === me`)
   * to surface read receipts without polling.
   *
   * Past-TTL messages flip to `expired` here and throw `MESSAGE_EXPIRED`.
   * Retracted messages throw `ALREADY_RETRACTED`. Both stay terminal.
   */
  markMessageRead(message_observation_id: number, session_id: string): MessageStatus {
    const obs = this.store.storage.getObservation(message_observation_id);
    if (!obs || obs.kind !== 'message') {
      throw taskError(
        TASK_THREAD_ERROR_CODES.NOT_MESSAGE,
        `observation ${message_observation_id} is not a message`,
      );
    }
    if (obs.task_id !== this.task_id) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.TASK_MISMATCH,
        `message belongs to task ${obs.task_id}, not ${this.task_id}`,
      );
    }
    const meta = parseMessage(obs.metadata);
    if (!meta) {
      throw taskError(TASK_THREAD_ERROR_CODES.METADATA_MISSING, 'message metadata missing');
    }
    const myAgent = this.store.storage.getParticipantAgent(this.task_id, session_id);
    if (!myAgent) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.NOT_PARTICIPANT,
        'session is not a participant on this task',
      );
    }
    if (meta.from_session_id === session_id) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.NOT_TARGET_SESSION,
        'message was sent by this session',
      );
    }
    if (meta.to_session_id !== null && meta.to_session_id !== session_id) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.NOT_TARGET_SESSION,
        'message is addressed to a different session',
      );
    }
    if (meta.to_session_id === null && meta.to_agent !== 'any' && meta.to_agent !== myAgent) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.NOT_TARGET_AGENT,
        `message is for ${meta.to_agent}, not ${myAgent}`,
      );
    }
    if (meta.status === 'retracted') {
      throw taskError(
        TASK_THREAD_ERROR_CODES.ALREADY_RETRACTED,
        'message has been retracted by the sender',
      );
    }
    if (meta.status === 'expired') {
      throw taskError(TASK_THREAD_ERROR_CODES.MESSAGE_EXPIRED, 'message expired before read');
    }
    if (meta.expires_at !== null && Date.now() > meta.expires_at && meta.status === 'unread') {
      meta.status = 'expired';
      this.store.storage.updateObservationMetadata(message_observation_id, JSON.stringify(meta));
      throw taskError(TASK_THREAD_ERROR_CODES.MESSAGE_EXPIRED, 'message expired before read');
    }
    if (meta.status === 'unread') {
      const now = Date.now();
      meta.status = 'read';
      meta.read_by_session_id = session_id;
      meta.read_at = now;
      this.store.storage.transaction(() => {
        this.store.storage.updateObservationMetadata(message_observation_id, JSON.stringify(meta));
        // Sibling read-receipt observation: lets the original sender's
        // preface render "B read your message at T (no reply yet)" without
        // a polling channel. Compressed like every other observation; the
        // structured fields live in metadata so the renderer can scan
        // without decompressing content.
        this.store.addObservation({
          session_id,
          kind: 'message_read',
          content: `read message #${message_observation_id} from ${meta.from_agent}`,
          task_id: this.task_id,
          reply_to: message_observation_id,
          metadata: {
            kind: 'message_read',
            read_message_id: message_observation_id,
            read_by_session_id: session_id,
            read_by_agent: myAgent,
            original_sender_session_id: meta.from_session_id,
            urgency: meta.urgency,
            ts: now,
          },
        });
        this.store.storage.touchTask(this.task_id, now);
      });
    }
    return meta.status;
  }

  /**
   * Sender-side retraction. Flips status to `retracted` and stamps a
   * reason; the body stays in storage (still searchable) but inbox views
   * render a stub instead of the original preview. Cannot retract a
   * message that has already been replied to — at that point the
   * recipient has invested response work and silently rewriting the
   * sender's intent would be deceptive.
   */
  retractMessage(message_observation_id: number, session_id: string, reason?: string): void {
    const obs = this.store.storage.getObservation(message_observation_id);
    if (!obs || obs.kind !== 'message') {
      throw taskError(
        TASK_THREAD_ERROR_CODES.NOT_MESSAGE,
        `observation ${message_observation_id} is not a message`,
      );
    }
    if (obs.task_id !== this.task_id) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.TASK_MISMATCH,
        `message belongs to task ${obs.task_id}, not ${this.task_id}`,
      );
    }
    const meta = parseMessage(obs.metadata);
    if (!meta) {
      throw taskError(TASK_THREAD_ERROR_CODES.METADATA_MISSING, 'message metadata missing');
    }
    if (meta.from_session_id !== session_id) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.NOT_SENDER,
        'only the original sender can retract this message',
      );
    }
    if (meta.status === 'retracted') {
      throw taskError(TASK_THREAD_ERROR_CODES.ALREADY_RETRACTED, 'message already retracted');
    }
    if (meta.status === 'replied') {
      throw taskError(
        TASK_THREAD_ERROR_CODES.ALREADY_REPLIED,
        'message has been replied to and cannot be retracted',
      );
    }
    const now = Date.now();
    meta.status = 'retracted';
    meta.retracted_at = now;
    meta.retract_reason = reason ?? null;
    this.store.storage.transaction(() => {
      this.store.storage.updateObservationMetadata(message_observation_id, JSON.stringify(meta));
      this.store.addObservation({
        session_id,
        kind: 'message_retract',
        content: reason
          ? `retracted message #${message_observation_id}: ${reason}`
          : `retracted message #${message_observation_id}`,
        task_id: this.task_id,
        reply_to: message_observation_id,
        metadata: {
          kind: 'message_retract',
          retracted_message_id: message_observation_id,
          retracted_by_session_id: session_id,
          ts: now,
        },
      });
      this.store.storage.touchTask(this.task_id, now);
    });
  }

  /**
   * Claim a `to_agent='any'` broadcast. Once claimed, the message drops
   * out of every other recipient's inbox; only the claimer keeps seeing
   * it. Directed messages cannot be claimed (NOT_BROADCAST). Replying to
   * a still-unclaimed broadcast auto-claims via `postMessage`, so this
   * call is for the "silently take ownership without yet replying" case.
   */
  claimBroadcastMessage(
    message_observation_id: number,
    session_id: string,
    agent: string,
  ): MessageMetadata {
    const obs = this.store.storage.getObservation(message_observation_id);
    if (!obs || obs.kind !== 'message') {
      throw taskError(
        TASK_THREAD_ERROR_CODES.NOT_MESSAGE,
        `observation ${message_observation_id} is not a message`,
      );
    }
    if (obs.task_id !== this.task_id) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.TASK_MISMATCH,
        `message belongs to task ${obs.task_id}, not ${this.task_id}`,
      );
    }
    const meta = parseMessage(obs.metadata);
    if (!meta) {
      throw taskError(TASK_THREAD_ERROR_CODES.METADATA_MISSING, 'message metadata missing');
    }
    if (!isBroadcastMessage(meta)) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.NOT_BROADCAST,
        'only to_agent=any broadcasts can be claimed',
      );
    }
    if (meta.from_session_id === session_id) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.NOT_TARGET_SESSION,
        'sender cannot claim their own broadcast',
      );
    }
    const myAgent = this.store.storage.getParticipantAgent(this.task_id, session_id);
    if (!myAgent) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.NOT_PARTICIPANT,
        'session is not a participant on this task',
      );
    }
    if (meta.status === 'retracted') {
      throw taskError(TASK_THREAD_ERROR_CODES.ALREADY_RETRACTED, 'message has been retracted');
    }
    if (meta.expires_at !== null && Date.now() > meta.expires_at) {
      throw taskError(TASK_THREAD_ERROR_CODES.MESSAGE_EXPIRED, 'broadcast expired');
    }
    if (meta.claimed_by_session_id !== null) {
      if (meta.claimed_by_session_id === session_id) return meta; // idempotent
      throw taskError(
        TASK_THREAD_ERROR_CODES.ALREADY_CLAIMED,
        `broadcast already claimed by ${meta.claimed_by_agent ?? meta.claimed_by_session_id}`,
      );
    }
    meta.claimed_by_session_id = session_id;
    meta.claimed_by_agent = agent;
    meta.claimed_at = Date.now();
    this.store.storage.updateObservationMetadata(message_observation_id, JSON.stringify(meta));
    this.store.storage.touchTask(this.task_id);
    return meta;
  }

  /** Unread messages addressed to `session_id` / `agent`. Broadcast
   *  messages (to_agent='any') are visible to every participant but the
   *  sender, except once a broadcast has been claimed only the claimer
   *  keeps seeing it. Past-TTL messages and retracted messages are also
   *  hidden — list reads are pure filters and do not mutate storage. */
  pendingMessagesFor(session_id: string, agent: string): MessageObservation[] {
    const now = Date.now();
    return this.store.storage
      .taskObservationsByKind(this.task_id, 'message')
      .map((row) => {
        const meta = parseMessage(row.metadata);
        return meta ? { id: row.id, ts: row.ts, meta } : null;
      })
      .filter((x): x is MessageObservation => x !== null)
      .filter(
        ({ meta }) =>
          meta.status === 'unread' &&
          (meta.expires_at === null || now < meta.expires_at) &&
          meta.from_session_id !== session_id &&
          isMessageAddressedTo(meta, session_id, agent) &&
          isVisibleToBroadcastClaimant(meta, session_id),
      );
  }

  /**
   * Emit a relay. Sender provides only `reason` + `one_line` + worktree
   * basics; everything else is synthesized from the last 30 minutes of task
   * activity so a Stop / SessionEnd hook firing seconds before the process
   * dies still produces something the receiver can resume from. Sender's
   * existing fresh claims become `handoff_pending` with the relay TTL instead
   * of staying strong forever. The receiver re-claims via
   * `worktree_recipe.inherit_claims` on accept, which replaces the pending row
   * without leaving a competing strong owner.
   */
  relay(args: RelayArgs): number {
    const now = Date.now();
    const since = now - RELAY_LOOKBACK_MS;
    const resumable_state = this.synthesizeRelayState(args.from_session_id, since);
    const worktree_recipe = synthesizeRelayRecipe(args, resumable_state);
    const meta: RelayMetadata = {
      kind: 'relay',
      from_session_id: args.from_session_id,
      from_agent: args.from_agent,
      to_agent: args.to_agent ?? 'any',
      to_session_id: args.to_session_id ?? null,
      reason: args.reason,
      one_line: args.one_line,
      resumable_state,
      worktree_recipe,
      status: 'pending',
      accepted_by_session_id: null,
      accepted_at: null,
      expires_at: now + (args.expires_in_ms ?? DEFAULT_RELAY_TTL_MS),
    };
    return this.store.storage.transaction(() => {
      const id = this.store.addObservation({
        session_id: args.from_session_id,
        kind: 'relay',
        content: renderRelayContent(meta),
        task_id: this.task_id,
        metadata: meta as unknown as Record<string, unknown>,
      });
      for (const claim of resumable_state.active_claims) {
        if (claim.held_by !== args.from_session_id) continue;
        this.store.storage.markClaimHandoffPending({
          task_id: this.task_id,
          file_path: claim.file_path,
          session_id: args.from_session_id,
          expires_at: meta.expires_at,
          handoff_observation_id: id,
        });
        this.store.addObservation({
          session_id: args.from_session_id,
          kind: 'claim-weakened',
          content: `claim ${claim.file_path} weakened to handoff_pending by relay #${id}`,
          task_id: this.task_id,
          reply_to: id,
          metadata: {
            kind: 'claim-weakened',
            file_path: claim.file_path,
            ownership_strength: 'weak',
            state: 'handoff_pending',
            reason: args.reason,
            relay_observation_id: id,
            expires_at: meta.expires_at,
          },
        });
      }
      this.store.storage.touchTask(this.task_id, now);
      return id;
    });
  }

  /**
   * Receiver-side. Re-claims `worktree_recipe.inherit_claims` under the
   * accepting session and flips status. Targeting + expiry checks mirror
   * `acceptHandoff`.
   */
  acceptRelay(relay_observation_id: number, session_id: string): void {
    const obs = this.store.storage.getObservation(relay_observation_id);
    if (!obs || obs.kind !== 'relay') {
      throw taskError(
        TASK_THREAD_ERROR_CODES.NOT_RELAY,
        `observation ${relay_observation_id} is not a relay`,
      );
    }
    if (obs.task_id !== this.task_id) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.TASK_MISMATCH,
        `relay belongs to task ${obs.task_id}, not ${this.task_id}`,
      );
    }
    const meta = parseRelay(obs.metadata);
    if (!meta) {
      throw taskError(TASK_THREAD_ERROR_CODES.METADATA_MISSING, 'relay metadata missing');
    }
    if (meta.status !== 'pending') {
      throw taskError(
        statusErrorCode(meta.status, 'relay'),
        `relay is ${meta.status}, cannot accept`,
      );
    }
    if (Date.now() > meta.expires_at) {
      meta.status = 'expired';
      this.store.storage.updateObservationMetadata(relay_observation_id, JSON.stringify(meta));
      throw taskError(TASK_THREAD_ERROR_CODES.RELAY_EXPIRED, 'relay expired');
    }
    if (meta.to_session_id && meta.to_session_id !== session_id) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.NOT_TARGET_SESSION,
        'relay is addressed to a different session',
      );
    }
    const myAgent = this.store.storage.getParticipantAgent(this.task_id, session_id);
    if (!myAgent) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.NOT_PARTICIPANT,
        'session is not a participant on this task',
      );
    }
    if (meta.to_agent !== 'any' && meta.to_agent !== myAgent) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.NOT_TARGET_AGENT,
        `relay is for ${meta.to_agent}, not ${myAgent}`,
      );
    }

    this.store.storage.transaction(() => {
      for (const file_path of meta.worktree_recipe.inherit_claims) {
        this.store.storage.claimFile({
          task_id: this.task_id,
          file_path,
          session_id,
        });
      }
      meta.status = 'accepted';
      meta.accepted_by_session_id = session_id;
      meta.accepted_at = Date.now();
      this.store.storage.updateObservationMetadata(relay_observation_id, JSON.stringify(meta));
      this.store.storage.touchTask(this.task_id);
    });
  }

  /** Decline a pending relay. Records a `decline` observation replying to
   *  the relay and flips status to `cancelled`. No claim state changes. */
  declineRelay(relay_observation_id: number, session_id: string, reason?: string): void {
    const obs = this.store.storage.getObservation(relay_observation_id);
    if (!obs || obs.kind !== 'relay') {
      throw taskError(TASK_THREAD_ERROR_CODES.NOT_RELAY, 'not a relay');
    }
    if (obs.task_id !== this.task_id) {
      throw taskError(TASK_THREAD_ERROR_CODES.TASK_MISMATCH, 'relay belongs to a different task');
    }
    const meta = parseRelay(obs.metadata);
    if (!meta) {
      throw taskError(TASK_THREAD_ERROR_CODES.METADATA_MISSING, 'relay metadata missing');
    }
    if (meta.status !== 'pending') {
      throw taskError(statusErrorCode(meta.status, 'relay'), `relay is ${meta.status}`);
    }
    this.store.storage.transaction(() => {
      meta.status = 'cancelled';
      this.store.storage.updateObservationMetadata(relay_observation_id, JSON.stringify(meta));
      this.store.addObservation({
        session_id,
        kind: 'decline',
        content: reason
          ? `declined relay #${relay_observation_id}: ${reason}`
          : `declined relay #${relay_observation_id}`,
        task_id: this.task_id,
        reply_to: relay_observation_id,
        metadata: { kind: 'decline', declined_relay: relay_observation_id },
      });
      this.store.storage.touchTask(this.task_id);
    });
  }

  /** Pending, unexpired relays visible to `session_id` / `agent`. */
  pendingRelaysFor(session_id: string, agent: string): RelayObservation[] {
    const now = Date.now();
    return this.store.storage
      .taskObservationsByKind(this.task_id, 'relay')
      .map((row) => {
        const meta = parseRelay(row.metadata);
        return meta ? { id: row.id, ts: row.ts, meta } : null;
      })
      .filter((x): x is RelayObservation => x !== null)
      .filter(
        ({ meta }) =>
          meta.status === 'pending' &&
          now < meta.expires_at &&
          meta.from_session_id !== session_id &&
          (meta.to_session_id === session_id || meta.to_agent === 'any' || meta.to_agent === agent),
      );
  }

  acceptQuotaClaim(args: QuotaClaimResolveArgs): QuotaClaimAcceptResult {
    const now = args.now ?? Date.now();
    const resolved = this.resolveQuotaClaimBaton(args);
    this.assertQuotaBatonPending(resolved, now);
    this.assertCanResolveQuotaBaton(resolved.meta, args.session_id);
    const acceptedFiles = resolved.claims.map((claim) => claim.file_path);
    const previousSessionIds = Array.from(
      new Set(resolved.claims.map((claim) => claim.session_id)),
    );

    return this.store.storage.transaction(() => {
      for (const claim of resolved.claims) {
        this.store.storage.claimFile({
          task_id: this.task_id,
          file_path: claim.file_path,
          session_id: args.session_id,
        });
      }
      resolved.meta.status = 'accepted';
      resolved.meta.accepted_by_session_id = args.session_id;
      resolved.meta.accepted_at = now;
      this.store.storage.updateObservationMetadata(resolved.obs.id, JSON.stringify(resolved.meta));
      const audit_observation_id = this.store.addObservation({
        session_id: args.session_id,
        kind: 'note',
        content: `accepted quota-pending claim${acceptedFiles.length === 1 ? '' : 's'} ${acceptedFiles.join(
          ', ',
        )} from ${previousSessionIds.join(', ')} via ${resolved.kind} #${resolved.obs.id}`,
        task_id: this.task_id,
        reply_to: resolved.obs.id,
        metadata: {
          kind: 'note',
          audit: 'quota_claim_accept',
          handoff_observation_id: resolved.obs.id,
          baton_kind: resolved.kind,
          accepted_files: acceptedFiles,
          previous_session_ids: previousSessionIds,
        },
      });
      this.store.storage.touchTask(this.task_id, now);
      return {
        status: 'accepted',
        task_id: this.task_id,
        handoff_observation_id: resolved.obs.id,
        baton_kind: resolved.kind,
        accepted_by_session_id: args.session_id,
        accepted_files: acceptedFiles,
        previous_session_ids: previousSessionIds,
        audit_observation_id,
      };
    });
  }

  declineQuotaClaim(args: QuotaClaimResolveArgs): QuotaClaimDeclineResult {
    const now = args.now ?? Date.now();
    const resolved = this.resolveQuotaClaimBaton(args);
    this.assertQuotaBatonPending(resolved, now);
    this.assertCanResolveQuotaBaton(resolved.meta, args.session_id);
    const declinedFiles = resolved.claims.map((claim) => claim.file_path);

    return this.store.storage.transaction(() => {
      resolved.meta.quota_claim_declines = [
        ...(resolved.meta.quota_claim_declines ?? []),
        {
          session_id: args.session_id,
          reason: args.reason ?? null,
          declined_at: now,
          file_paths: declinedFiles,
        },
      ];
      resolved.meta.to_agent = 'any';
      resolved.meta.to_session_id = null;
      this.store.storage.updateObservationMetadata(resolved.obs.id, JSON.stringify(resolved.meta));
      const audit_observation_id = this.store.addObservation({
        session_id: args.session_id,
        kind: 'decline',
        content: args.reason
          ? `declined quota-pending claim${declinedFiles.length === 1 ? '' : 's'} ${declinedFiles.join(
              ', ',
            )} from ${resolved.kind} #${resolved.obs.id}: ${args.reason}`
          : `declined quota-pending claim${declinedFiles.length === 1 ? '' : 's'} ${declinedFiles.join(
              ', ',
            )} from ${resolved.kind} #${resolved.obs.id}`,
        task_id: this.task_id,
        reply_to: resolved.obs.id,
        metadata: {
          kind: 'decline',
          declined_quota_claim: true,
          handoff_observation_id: resolved.obs.id,
          baton_kind: resolved.kind,
          declined_files: declinedFiles,
          reason: args.reason ?? null,
          relay_still_visible: true,
        },
      });
      this.store.storage.touchTask(this.task_id, now);
      return {
        status: 'declined',
        task_id: this.task_id,
        handoff_observation_id: resolved.obs.id,
        baton_kind: resolved.kind,
        declined_by_session_id: args.session_id,
        declined_files: declinedFiles,
        still_visible: true,
        audit_observation_id,
      };
    });
  }

  releaseExpiredQuotaClaims(args: QuotaClaimResolveArgs): QuotaClaimReleaseExpiredResult {
    const now = args.now ?? Date.now();
    this.assertTaskExists();
    this.assertParticipant(args.session_id);
    const normalizedFilePath = this.normalizeOptionalClaimPath(args.file_path);
    const claims = this.claims().filter((claim) => {
      if (claim.state !== 'handoff_pending') return false;
      if (typeof claim.expires_at !== 'number' || now < claim.expires_at) return false;
      if (normalizedFilePath !== null && claim.file_path !== normalizedFilePath) return false;
      if (
        args.handoff_observation_id !== undefined &&
        claim.handoff_observation_id !== args.handoff_observation_id
      ) {
        return false;
      }
      return true;
    });

    return this.store.storage.transaction(() => {
      const audit_observation_ids: number[] = [];
      const seenBatons = new Set<number>();
      for (const claim of claims) {
        if (claim.handoff_observation_id !== null) seenBatons.add(claim.handoff_observation_id);
        if (claim.handoff_observation_id !== null) {
          this.store.storage.markClaimWeakExpired({
            task_id: this.task_id,
            file_path: claim.file_path,
            session_id: claim.session_id,
            handoff_observation_id: claim.handoff_observation_id,
          });
        }
        audit_observation_ids.push(
          this.store.addObservation({
            session_id: args.session_id,
            kind: 'claim-weakened',
            content: `claim ${claim.file_path} downgraded to weak_expired from quota-pending owner ${claim.session_id}`,
            task_id: this.task_id,
            reply_to: claim.handoff_observation_id,
            metadata: {
              kind: 'claim-weakened',
              file_path: claim.file_path,
              previous_session_id: claim.session_id,
              ownership_strength: 'weak',
              state: 'weak_expired',
              reason: 'quota_pending_expired',
              handoff_observation_id: claim.handoff_observation_id,
              previous_claimed_at: claim.claimed_at,
              expires_at: claim.expires_at,
            },
          }),
        );
      }
      for (const batonId of seenBatons) {
        this.expireQuotaBatonIfPending(batonId, now);
      }
      this.store.storage.touchTask(this.task_id, now);
      return {
        status: 'released_expired',
        task_id: this.task_id,
        released_claims: claims.map((claim) => ({
          file_path: claim.file_path,
          previous_session_id: claim.session_id,
          handoff_observation_id: claim.handoff_observation_id,
          state: 'weak_expired' as const,
        })),
        audit_observation_ids,
      };
    });
  }

  private assertTaskExists(): void {
    if (!this.task()) throw taskError(TASK_THREAD_ERROR_CODES.TASK_NOT_FOUND, 'task not found');
  }

  private assertParticipant(session_id: string): string {
    const agent = this.store.storage.getParticipantAgent(this.task_id, session_id);
    if (!agent) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.NOT_PARTICIPANT,
        'session is not a participant on this task',
      );
    }
    return agent;
  }

  private assertCanResolveQuotaBaton(
    meta: HandoffMetadata | RelayMetadata,
    session_id: string,
  ): void {
    const agent = this.assertParticipant(session_id);
    if (meta.to_session_id && meta.to_session_id !== session_id) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.NOT_TARGET_SESSION,
        'quota claim is addressed to a different session',
      );
    }
    if (meta.to_agent !== 'any' && meta.to_agent !== agent) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.NOT_TARGET_AGENT,
        `quota claim is for ${meta.to_agent}, not ${agent}`,
      );
    }
  }

  private normalizeOptionalClaimPath(file_path: string | undefined): string | null {
    if (file_path === undefined) return null;
    const normalized = this.store.storage.normalizeTaskFilePath(this.task_id, file_path);
    if (normalized === null) {
      throw taskError(TASK_THREAD_ERROR_CODES.INVALID_CLAIM_PATH, 'claim path is not claimable');
    }
    return normalized;
  }

  private resolveQuotaClaimBaton(args: QuotaClaimResolveArgs): {
    obs: ObservationRow;
    kind: 'handoff' | 'relay';
    meta: HandoffMetadata | RelayMetadata;
    claims: TaskClaimRow[];
  } {
    this.assertTaskExists();
    const normalizedFilePath = this.normalizeOptionalClaimPath(args.file_path);
    const claim =
      normalizedFilePath !== null
        ? this.store.storage.getClaim(this.task_id, normalizedFilePath)
        : undefined;
    if (normalizedFilePath !== null && !claim) {
      this.throwTerminalBatonStatus(args.handoff_observation_id);
      throw taskError(TASK_THREAD_ERROR_CODES.CLAIM_NOT_FOUND, 'quota claim not found');
    }
    if (claim && claim.state !== 'handoff_pending') {
      this.throwTerminalBatonStatus(args.handoff_observation_id);
      throw taskError(
        TASK_THREAD_ERROR_CODES.CLAIM_NOT_QUOTA_PENDING,
        `claim is ${claim.state}, not handoff_pending`,
      );
    }
    if (
      claim?.handoff_observation_id !== null &&
      claim?.handoff_observation_id !== undefined &&
      args.handoff_observation_id !== undefined &&
      claim.handoff_observation_id !== args.handoff_observation_id
    ) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.CLAIM_BATON_CONFLICT,
        'claim belongs to a different handoff/relay',
      );
    }
    const batonId = args.handoff_observation_id ?? claim?.handoff_observation_id;
    if (!batonId) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.CLAIM_BATON_MISSING,
        'quota claim has no handoff/relay observation',
      );
    }
    const obs = this.store.storage.getObservation(batonId);
    if (!obs?.task_id) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.OBSERVATION_NOT_ON_TASK,
        'handoff/relay observation is not on a task',
      );
    }
    if (obs.task_id !== this.task_id) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.TASK_MISMATCH,
        `handoff/relay belongs to task ${obs.task_id}, not ${this.task_id}`,
      );
    }
    const kind = obs.kind === 'handoff' ? 'handoff' : obs.kind === 'relay' ? 'relay' : null;
    if (kind === null) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.CLAIM_BATON_MISSING,
        `observation ${batonId} is not a handoff or relay`,
      );
    }
    const meta = kind === 'handoff' ? parseHandoff(obs.metadata, obs.ts) : parseRelay(obs.metadata);
    if (!meta) {
      throw taskError(TASK_THREAD_ERROR_CODES.METADATA_MISSING, 'handoff/relay metadata missing');
    }
    const claims = this.claims().filter(
      (candidate) =>
        candidate.state === 'handoff_pending' && candidate.handoff_observation_id === batonId,
    );
    if (
      normalizedFilePath !== null &&
      !claims.some((candidate) => candidate.file_path === normalizedFilePath)
    ) {
      throw taskError(
        TASK_THREAD_ERROR_CODES.CLAIM_BATON_CONFLICT,
        'claim does not belong to this handoff/relay',
      );
    }
    if (claims.length === 0) {
      if (meta.status !== 'pending') this.throwBatonStatus(meta, kind);
      throw taskError(TASK_THREAD_ERROR_CODES.CLAIM_NOT_FOUND, 'quota claim not found');
    }
    return { obs, kind, meta, claims };
  }

  private assertQuotaBatonPending(
    resolved: {
      obs: ObservationRow;
      kind: 'handoff' | 'relay';
      meta: HandoffMetadata | RelayMetadata;
    },
    now: number,
  ): void {
    if (resolved.meta.status !== 'pending') this.throwBatonStatus(resolved.meta, resolved.kind);
    if (now >= resolved.meta.expires_at) {
      resolved.meta.status = 'expired';
      this.store.storage.updateObservationMetadata(resolved.obs.id, JSON.stringify(resolved.meta));
      throw taskError(
        resolved.kind === 'handoff'
          ? TASK_THREAD_ERROR_CODES.HANDOFF_EXPIRED
          : TASK_THREAD_ERROR_CODES.RELAY_EXPIRED,
        `${resolved.kind} expired`,
      );
    }
  }

  private throwTerminalBatonStatus(handoff_observation_id: number | undefined): void {
    if (handoff_observation_id === undefined) return;
    const obs = this.store.storage.getObservation(handoff_observation_id);
    if (!obs || obs.task_id !== this.task_id) return;
    if (obs.kind === 'handoff') {
      const meta = parseHandoff(obs.metadata, obs.ts);
      if (meta && meta.status !== 'pending') this.throwBatonStatus(meta, 'handoff');
    } else if (obs.kind === 'relay') {
      const meta = parseRelay(obs.metadata);
      if (meta && meta.status !== 'pending') this.throwBatonStatus(meta, 'relay');
    }
  }

  private throwBatonStatus(
    meta: HandoffMetadata | RelayMetadata,
    kind: 'handoff' | 'relay',
  ): never {
    throw taskError(statusErrorCode(meta.status, kind), `${kind} is ${meta.status}`);
  }

  private expireQuotaBatonIfPending(batonId: number, now: number): void {
    const obs = this.store.storage.getObservation(batonId);
    if (!obs || obs.task_id !== this.task_id) return;
    const kind = obs.kind === 'handoff' ? 'handoff' : obs.kind === 'relay' ? 'relay' : null;
    if (!kind) return;
    const meta = kind === 'handoff' ? parseHandoff(obs.metadata, obs.ts) : parseRelay(obs.metadata);
    if (!meta || meta.status !== 'pending' || now < meta.expires_at) return;
    meta.status = 'expired';
    this.store.storage.updateObservationMetadata(batonId, JSON.stringify(meta));
  }

  private synthesizeRelayState(
    sender_session_id: string,
    since: number,
  ): RelayMetadata['resumable_state'] {
    const recent = this.store.storage.taskObservationsSince(this.task_id, since, 100);
    // PostToolUse writes kind='tool_use' with metadata.file_path holding
    // the touched path (single string, not nested under tool_input). We
    // read directly off the metadata field rather than the compressed
    // content body — fast, exact, and survives compression.
    const last_files_edited = recent
      .filter((o) => o.session_id === sender_session_id && o.kind === 'tool_use')
      .map((o) => {
        const m = parseObservationMetadata(o.metadata);
        const file_path = m.file_path;
        return typeof file_path === 'string' && file_path.length > 0
          ? { file_path, ts: o.ts, session_id: o.session_id }
          : null;
      })
      .filter((x): x is { file_path: string; ts: number; session_id: string } => x !== null)
      .slice(-8);

    const now = Date.now();
    const active_claims = this.store.storage
      .listClaims(this.task_id)
      .filter((c) =>
        isStrongClaimAge(
          classifyClaimAge(c, {
            now,
            claim_stale_minutes: this.store.settings.claimStaleMinutes,
          }),
        ),
      )
      .map((c) => ({
        file_path: c.file_path,
        held_by: c.session_id,
      }));

    // Most recent prior baton-pass — handoff or relay, whichever ran last —
    // gives the receiver the conversational arc, not just immediate state.
    // Different metadata shape per kind: handoffs carry `summary`, relays
    // carry `one_line`. Branch on kind so the snapshot is honest about
    // whichever happened more recently.
    const lastBaton = [
      ...this.store.storage.taskObservationsByKind(this.task_id, 'handoff'),
      ...this.store.storage.taskObservationsByKind(this.task_id, 'relay'),
    ]
      .sort((a, b) => a.ts - b.ts)
      .at(-1);
    let last_handoff_summary: string | null = null;
    if (lastBaton) {
      const m = parseObservationMetadata(lastBaton.metadata);
      if (lastBaton.kind === 'handoff' && typeof m.summary === 'string') {
        last_handoff_summary = m.summary;
      } else if (lastBaton.kind === 'relay' && typeof m.one_line === 'string') {
        last_handoff_summary = m.one_line;
      }
    }

    const recent_decisions = recent
      .filter((o) => o.kind === 'decision')
      .slice(-3)
      .map((o) => ({ id: o.id, content: o.content.slice(0, 200), ts: o.ts }));
    const open_blockers = recent
      .filter((o) => o.kind === 'blocker')
      .slice(-3)
      .map((o) => ({ id: o.id, content: o.content.slice(0, 200), ts: o.ts }));

    const relevant_search_seeds = extractRelayKeywords(recent.map((o) => o.content));

    return {
      last_files_edited,
      active_claims,
      last_handoff_summary,
      recent_decisions,
      open_blockers,
      relevant_search_seeds,
    };
  }
}

function isReplyableStatus(status: MessageStatus): boolean {
  return status === 'unread' || status === 'read';
}

/** A claimed broadcast is invisible to non-claimer recipients. Directed
 *  messages and unclaimed broadcasts pass through. */
export function isVisibleToBroadcastClaimant(meta: MessageMetadata, session_id: string): boolean {
  if (!isBroadcastMessage(meta)) return true;
  if (meta.claimed_by_session_id === null) return true;
  return meta.claimed_by_session_id === session_id;
}

function parseHandoff(metadata: string | null, rowTs = Date.now()): HandoffMetadata | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const m = parsed as Partial<HandoffMetadata>;
    if (m.kind !== 'handoff' || typeof m.status !== 'string') return null;
    const meta = parsed as HandoffMetadata;
    if (typeof meta.expires_at !== 'number' || !Number.isFinite(meta.expires_at)) {
      meta.expires_at = rowTs + DEFAULT_HANDOFF_TTL_MS;
    }
    if (typeof meta.handoff_ttl_ms !== 'number' || !Number.isFinite(meta.handoff_ttl_ms)) {
      meta.handoff_ttl_ms = Math.max(0, meta.expires_at - rowTs);
    }
    return meta;
  } catch {
    return null;
  }
}

function handoffExpired(meta: HandoffMetadata, now = Date.now()): boolean {
  return now >= meta.expires_at;
}

function parseWake(metadata: string | null): WakeRequestMetadata | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const m = parsed as Partial<WakeRequestMetadata>;
    if (m.kind !== 'wake_request' || typeof m.status !== 'string') return null;
    return parsed as WakeRequestMetadata;
  } catch {
    return null;
  }
}

export function parseMessage(metadata: string | null): MessageMetadata | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const m = parsed as Partial<MessageMetadata>;
    if (m.kind !== 'message' || typeof m.status !== 'string') return null;
    // Backfill the fields added in the messaging-overhaul change. Legacy
    // rows persisted before this PR shipped have these keys absent (not
    // explicitly null), and the visibility predicates below use strict
    // `=== null` comparisons. Defaulting at parse time keeps every
    // downstream check honest without a database migration. Use `??` so
    // newer rows that explicitly set the field to a non-null value are
    // preserved unchanged.
    const meta = parsed as MessageMetadata;
    meta.expires_at = meta.expires_at ?? null;
    meta.retracted_at = meta.retracted_at ?? null;
    meta.retract_reason = meta.retract_reason ?? null;
    meta.claimed_by_session_id = meta.claimed_by_session_id ?? null;
    meta.claimed_by_agent = meta.claimed_by_agent ?? null;
    meta.claimed_at = meta.claimed_at ?? null;
    return meta;
  } catch {
    return null;
  }
}

function renderWakeContent(m: WakeRequestMetadata): string {
  const target = m.to_session_id ?? m.to_agent;
  const lines = [`WAKE REQUEST from ${m.from_agent} -> ${target}`, `Reason: ${m.reason}`];
  if (m.next_step) lines.push(`Next step: ${m.next_step}`);
  return lines.join('\n');
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
  if (m.quota_context) {
    lines.push(
      `Quota context: branch=${m.quota_context.branch ?? 'unknown'} dirty_files=${formatInlineList(
        m.quota_context.dirty_files,
      )} claimed_files=${formatInlineList(m.quota_context.claimed_files)}`,
    );
    if (m.quota_context.last_verification) {
      lines.push(
        `Last verification: ${m.quota_context.last_verification.command ?? 'unknown'} -> ${
          m.quota_context.last_verification.result ?? 'unknown'
        }`,
      );
    }
  }
  return lines.join('\n');
}

function formatInlineList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : 'none';
}

// 30 minutes — the "what was I just doing" window. Long enough to catch a
// turn that was paused mid-edit; short enough that the synthesised state
// reflects current intent rather than a whole working session.
const RELAY_LOOKBACK_MS = 30 * 60_000;

function parseRelay(metadata: string | null): RelayMetadata | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const m = parsed as Partial<RelayMetadata>;
    if (m.kind !== 'relay' || typeof m.status !== 'string') return null;
    return parsed as RelayMetadata;
  } catch {
    return null;
  }
}

function renderRelayContent(m: RelayMetadata): string {
  const target = m.to_session_id ?? m.to_agent;
  const lines = [`RELAY from ${m.from_agent} (${m.reason}) -> ${target}`, m.one_line];
  if (m.resumable_state.last_files_edited.length) {
    const paths = Array.from(new Set(m.resumable_state.last_files_edited.map((e) => e.file_path)));
    lines.push(`Recently edited: ${paths.join(', ')}`);
  }
  if (m.resumable_state.recent_decisions.length) {
    lines.push(
      `Recent decisions: ${m.resumable_state.recent_decisions
        .map((d) => d.content.slice(0, 80))
        .join(' | ')}`,
    );
  }
  if (m.resumable_state.open_blockers.length) {
    lines.push(
      `Open blockers: ${m.resumable_state.open_blockers
        .map((b) => b.content.slice(0, 80))
        .join(' | ')}`,
    );
  }
  if (m.worktree_recipe.inherit_claims.length) {
    lines.push(`Claims to inherit: ${m.worktree_recipe.inherit_claims.join(', ')}`);
  }
  if (m.worktree_recipe.untracked_files_warning.length) {
    lines.push(
      `WARN uncommitted in sender worktree: ${m.worktree_recipe.untracked_files_warning.join(', ')}`,
    );
  }
  return lines.join('\n');
}

function parseObservationMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function synthesizeRelayRecipe(
  args: RelayArgs,
  state: RelayMetadata['resumable_state'],
): RelayMetadata['worktree_recipe'] {
  // Inherit only files the sender held. Recently-edited-but-not-claimed
  // files don't transfer ownership; the receiver may not need to own them.
  const inherit_claims = state.active_claims
    .filter((c) => c.held_by === args.from_session_id)
    .map((c) => c.file_path);
  // No fetch_files_at sha → every recent edit is potentially uncommitted,
  // so flag the lot. With a sha the receiver can reproduce the tree from
  // git, and we leave the warning empty.
  const untracked_files_warning =
    args.fetch_files_at === undefined
      ? Array.from(new Set(state.last_files_edited.map((e) => e.file_path)))
      : [];
  return {
    base_branch: args.base_branch,
    inherit_claims,
    fetch_files_at: args.fetch_files_at ?? null,
    untracked_files_warning,
  };
}

const RELAY_KEYWORD_STOPWORDS = new Set([
  'function',
  'should',
  'because',
  'instead',
  'really',
  'session',
  'observation',
  'metadata',
  'content',
  'message',
]);

function extractRelayKeywords(contents: string[]): string[] {
  const text = contents.join(' ').toLowerCase();
  const tokens = text.match(/[a-z][a-z_-]{4,}/g) ?? [];
  const counts = new Map<string, number>();
  for (const t of tokens) {
    if (RELAY_KEYWORD_STOPWORDS.has(t)) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => k);
}
