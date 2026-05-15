import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  TaskThread,
  classifyClaimAge,
  guardedClaimFile,
  listPlans,
  liveFileContentionsForClaim,
} from '@colony/core';
import { claimPathRejectionMessage } from '@colony/storage';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ClaimsHandlerError, enforceScoutNoClaim } from '../handlers/claims.js';
import { type ToolContext, defaultWrapHandler } from './context.js';
import { detectMcpClientIdentity } from './heartbeat.js';
import { mcpError, mcpErrorResponse } from './shared.js';

const SUBTASK_BRANCH_RE = /^spec\/([a-z0-9-]+)\/sub-(\d+)$/;
const TASK_LIST_HINT =
  'Use task_ready_for_agent to choose claimable work; task_list is for browsing.';
const TASK_LIST_COORDINATION_WARNING =
  'task_list is inventory; use task_ready_for_agent to choose work.';
const TASK_LIST_REPEAT_WARNING = 'Stop browsing. Call task_ready_for_agent before selecting work.';
const TASK_LIST_LOOKBACK_MS = 24 * 60 * 60_000;
const OMX_POINTER_VALUE_LIMIT = 180;
const TASK_POST_PROPOSAL_RECOMMENDATION =
  'This looks like future work. Use task_propose so foraging can reinforce and promote it.';
const TASK_POST_FUTURE_WORK_PATTERNS = [
  /\bfuture work\b/i,
  /\bfollow-?up\b/i,
  /\bdeferred\b/i,
  /\bnot in this (?:pr|patch|change)\b/i,
  /\blater\b/i,
  /\btodo\b/i,
  /\bshould (?:eventually|later|next|also)\b/i,
  /\bneeds? (?:a |an |the )?(?:follow-?up|proposal|cleanup|refactor|investigation|test|docs?)\b/i,
];
const TASK_POST_FUTURE_WORK_PREFIX_RE =
  /^\s*(?:future work|follow-?up|deferred|later|todo|not in this (?:pr|patch|change))\s*[:.-]?\s*/i;
const TASK_POST_RECOMMENDATION_SUMMARY_LIMIT = 140;
const TASK_POST_RECOMMENDATION_RATIONALE_LIMIT = 320;
type TaskMessageSuggestionTarget = 'claude' | 'codex' | 'any';

interface TaskPostProposalRecommendation {
  tool: 'task_propose';
  message: string;
  suggested_fields: {
    summary: string;
    rationale: string;
    touches_files: string[];
  };
}
const WorkingNotePointerSchema = z.object({
  branch: z.string().min(1).optional(),
  task: z.string().min(1).optional(),
  blocker: z.string().min(1).optional(),
  next: z.string().min(1).optional(),
  evidence: z.string().min(1).optional(),
});

type WorkingNotePointerInput = z.infer<typeof WorkingNotePointerSchema>;
type ExistingTaskClaim = NonNullable<ReturnType<ToolContext['store']['storage']['getClaim']>>;

interface OmxNotepadPointerResult {
  status: 'skipped' | 'written' | 'unavailable';
  path?: string;
  reason?: string;
}

export function register(server: McpServer, ctx: ToolContext): void {
  const wrapHandler = ctx.wrapHandler ?? defaultWrapHandler;
  const { store, settings } = ctx;

  // Task-thread tools. Agents already know their session_id from SessionStart;
  // it's passed explicitly on every call so this server stays session-agnostic
  // and can serve multiple agents without ambient state.

  server.tool(
    'task_list',
    'Browse task threads; use task_ready_for_agent when choosing work to claim. Lists shared coordination lanes by repo_root, branch, participants, status, and recent activity. Defaults to a compact rollup (id, title, branch, status, updated_at) — pass detail="full" to also receive repo_root, created_by, and created_at.',
    {
      limit: z.number().int().positive().max(200).optional(),
      session_id: z.string().min(1).optional(),
      detail: z
        .enum(['compact', 'full'])
        .optional()
        .describe(
          'compact (default): id + title + branch + status + updated_at per task. full: legacy shape with repo_root, created_by, created_at. Use compact for browsing; full when you need the long-form audit fields.',
        ),
    },
    wrapHandler('task_list', async ({ limit, session_id, detail }) => {
      const tasks = store.storage.listTasks(limit ?? 50);
      const callerSessionId = session_id ?? detectMcpClientIdentity().sessionId;
      const routing = taskListRoutingForSession(store, callerSessionId);
      const projection =
        (detail ?? 'compact') === 'full'
          ? tasks
          : tasks.map((task) => ({
              id: task.id,
              title: task.title,
              branch: task.branch,
              status: task.status,
              updated_at: task.updated_at,
            }));
      return jsonReply({
        tasks: projection,
        hint: routing.hint,
        coordination_warning: routing.coordination_warning,
        next_tool: 'task_ready_for_agent',
      });
    }),
  );

  server.tool(
    'task_timeline',
    'See recent task-thread activity and coordination history. Returns compact observation IDs, kinds, authors, timestamps, and reply links for follow-up reads.',
    {
      task_id: z.number().int().positive(),
      limit: z.number().int().positive().max(200).optional(),
    },
    wrapHandler('task_timeline', async ({ task_id, limit }) => {
      const rows = store.storage.taskTimeline(task_id, limit ?? 50);
      const planMetadata = compactPlanTimelineMetadata(store, task_id);
      const compact = rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        session_id: r.session_id,
        ts: r.ts,
        reply_to: r.reply_to,
        ...(planMetadata ?? {}),
      }));
      return { content: [{ type: 'text', text: JSON.stringify(compact) }] };
    }),
  );

  server.tool(
    'task_updates_since',
    "Check unread task updates since a timestamp. Excludes this session's own posts and returns other-agent changes, kinds, timestamps, and compact IDs.",
    {
      task_id: z.number().int().positive(),
      session_id: z.string().min(1),
      since_ts: z.number().int().nonnegative(),
      limit: z.number().int().positive().max(200).optional(),
    },
    wrapHandler('task_updates_since', async ({ task_id, session_id, since_ts, limit }) => {
      const rows = store.storage
        .taskObservationsSince(task_id, since_ts, limit ?? 50)
        .filter((o) => o.session_id !== session_id);
      const compact = rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        session_id: r.session_id,
        ts: r.ts,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(compact) }] };
    }),
  );

  server.tool(
    'task_post',
    [
      'Post shared task notes, questions, decisions, blockers.',
      'Use task_message for directed agent-to-agent coordination or reply-needed posts.',
      'Use task_note_working for unknown task_id.',
      'Future-work notes return task_propose recommendation.',
    ].join(' '),
    {
      task_id: z.number().int().positive(),
      session_id: z.string().min(1),
      kind: z.enum([
        'question',
        'answer',
        'decision',
        'blocker',
        'note',
        'failed_approach',
        'blocked_path',
        'conflict_warning',
        'reverted_solution',
      ]),
      content: z.string().min(1),
      reply_to: z.number().int().positive().optional(),
    },
    wrapHandler('task_post', async ({ task_id, session_id, kind, content, reply_to }) => {
      if (!store.storage.getTask(task_id)) {
        return mcpErrorResponse('TASK_NOT_FOUND', `task ${task_id} not found`, {
          task_id,
          hint: 'Use task_note_working when the active task id is unknown or stale.',
        });
      }
      const thread = new TaskThread(store, task_id);
      const id = thread.post({
        session_id,
        kind,
        content,
        ...(reply_to !== undefined ? { reply_to } : {}),
      });
      const recommendation = proposalRecommendationForPost(kind, content);
      const directedMessageSuggestion = taskMessageSuggestionForPost(store, {
        task_id,
        session_id,
        kind,
        content,
      });
      return jsonReply({
        id,
        hint: taskPostHint(kind, content),
        ...(directedMessageSuggestion ?? {}),
        ...(recommendation ? { recommendation } : {}),
      });
    }),
  );

  server.tool(
    'task_note_working',
    'Save current working state to the active Colony task. First write path/notepad replacement: write working note; save current state; log what I am doing; remember progress. repo_root/branch resolves by task_id; returns compact candidates.',
    {
      session_id: z.string().min(1),
      content: z.string().min(1),
      repo_root: z.string().min(1).optional(),
      branch: z.string().min(1).optional(),
      candidate_limit: z.number().int().positive().max(50).optional(),
      pointer: WorkingNotePointerSchema.optional(),
      allow_omx_notepad_fallback: z.boolean().optional(),
    },
    wrapHandler(
      'task_note_working',
      async ({
        session_id,
        content,
        repo_root,
        branch,
        candidate_limit,
        pointer,
        allow_omx_notepad_fallback,
      }) => {
        let candidates = activeTaskCandidates(store, {
          session_id,
          ...(repo_root !== undefined ? { repo_root } : {}),
          ...(branch !== undefined ? { branch } : {}),
        });
        let materialized = false;
        if (candidates.length === 0 && repo_root !== undefined && branch !== undefined) {
          const candidate = materializeWorkingNoteTask(store, { session_id, repo_root, branch });
          if (candidate !== null) {
            candidates = [candidate];
            materialized = true;
          }
        }

        if (candidates.length !== 1) {
          const visibleCandidates = candidates.slice(0, candidate_limit ?? 10);
          const code = candidates.length === 0 ? 'ACTIVE_TASK_NOT_FOUND' : 'AMBIGUOUS_ACTIVE_TASK';
          if (code === 'ACTIVE_TASK_NOT_FOUND' && allow_omx_notepad_fallback === true) {
            const omxPointer = writeOmxNotepadPointer({
              repo_root,
              branch,
              pointer,
              colony_observation_id: null,
              candidate: null,
            });
            if (omxPointer.status === 'written') {
              return jsonReply({
                status: 'omx_notepad_fallback',
                observation_id: null,
                id: null,
                task_id: null,
                omx_notepad_pointer: omxPointer,
              });
            }
          }

          // ACTIVE_TASK_NOT_FOUND is the dominant error mode for this tool
          // (8 of 23 errors in 7d telemetry). The caller is usually a fresh
          // agent session that has not yet joined the active task on its
          // branch — so a zero-result narrow lookup hides candidates that
          // already exist on disk. Surface those as `nearby_tasks` with a
          // `match_kind` annotation so the caller can recover via an
          // explicit `task_post(task_id=...)` or `task_accept_handoff`
          // without re-listing the whole task table.
          const nearbyTasks =
            code === 'ACTIVE_TASK_NOT_FOUND'
              ? nearbyTaskMatches(store, {
                  ...(repo_root !== undefined ? { repo_root } : {}),
                  ...(branch !== undefined ? { branch } : {}),
                  limit: candidate_limit ?? 10,
                })
              : [];

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  code,
                  error:
                    candidates.length === 0
                      ? 'no active Colony task matched session/repo/branch'
                      : 'multiple active Colony tasks matched session/repo/branch',
                  candidates: visibleCandidates,
                  ...(code === 'ACTIVE_TASK_NOT_FOUND' && nearbyTasks.length > 0
                    ? {
                        nearby_tasks: nearbyTasks,
                        hint: 'Your session has not joined a task on this branch. Pass task_id=<id> to task_post directly, or call task_accept_handoff to bind your session before retrying task_note_working.',
                      }
                    : {}),
                  ...(code === 'ACTIVE_TASK_NOT_FOUND' && allow_omx_notepad_fallback === true
                    ? {
                        omx_notepad_pointer: {
                          status: 'unavailable',
                          reason: 'repo_root is required for OMX notepad fallback',
                        },
                      }
                    : {}),
                }),
              },
            ],
            isError: true,
          };
        }

        const candidate = candidates[0];
        if (!candidate) throw new Error('working note task resolution lost its only candidate');
        const thread = new TaskThread(store, candidate.task_id);
        const observation_id = thread.post({
          session_id,
          kind: 'note',
          content,
          metadata: {
            working_note: true,
            resolved_by: 'task_note_working',
            ...(materialized ? { materialized_task: true } : {}),
            ...(repo_root !== undefined ? { requested_repo_root: repo_root } : {}),
            ...(branch !== undefined ? { requested_branch: branch } : {}),
          },
        });
        const omxPointer = ctx.settings.bridge.writeOmxNotepadPointer
          ? writeOmxNotepadPointer({
              repo_root: repo_root ?? candidate.repo_root,
              branch: branch ?? candidate.branch,
              pointer,
              colony_observation_id: observation_id,
              candidate,
            })
          : {
              status: 'skipped',
              reason: 'bridge.writeOmxNotepadPointer=false',
            };
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                observation_id,
                id: observation_id,
                task_id: candidate.task_id,
                ...(materialized ? { status: 'task_materialized' } : {}),
                omx_notepad_pointer: omxPointer,
              }),
            },
          ],
        };
      },
    ),
  );

  server.tool(
    'task_claim_file',
    'Claim a file before editing so other agents see ownership and overlap warnings. Use before editing to avoid conflict and make file ownership visible; claims are soft coordination and never block writes. Rejected with PROTECTED_BRANCH_CLAIM_REJECTED when the task branch is a protected base branch (main/master/dev/develop/production/release) — start a sandbox worktree first.',
    {
      task_id: z.number().int().positive(),
      session_id: z.string().min(1),
      agent: z.string().min(1).optional(),
      file_path: z.string().min(1),
      note: z.string().optional(),
    },
    wrapHandler('task_claim_file', async ({ task_id, session_id, agent, file_path, note }) => {
      try {
        enforceScoutNoClaim(store, {
          session_id,
          ...(agent !== undefined ? { agent } : {}),
        });
      } catch (err) {
        if (err instanceof ClaimsHandlerError) {
          return mcpErrorResponse(err.code, err.message);
        }
        throw err;
      }
      const normalizedFilePath = store.storage.normalizeTaskFilePath(task_id, file_path);
      if (normalizedFilePath === null) {
        const reason = store.storage.classifyTaskFilePathRejection(task_id, file_path);
        const task = store.storage.getTask(task_id);
        return mcpErrorResponse(
          'INVALID_CLAIM_PATH',
          claimPathRejectionMessage(reason, file_path, { repo_root: task?.repo_root }),
        );
      }
      const previous = store.storage.getClaim(task_id, normalizedFilePath);
      const liveContentions = liveFileContentionsForClaim(store, {
        task_id,
        session_id,
        file_path: normalizedFilePath,
        assume_requester_live: true,
      });
      const guarded = guardedClaimFile(store, {
        task_id,
        session_id,
        file_path: normalizedFilePath,
      });
      if (guarded.status === 'takeover_recommended') {
        return mcpErrorResponse(
          'CLAIM_TAKEOVER_RECOMMENDED',
          guarded.recommendation ?? 'release or take over inactive claim before claiming',
          { ...guarded },
        );
      }
      if (guarded.status === 'blocked_active_owner') {
        return mcpErrorResponse(
          'CLAIM_HELD_BY_ACTIVE_OWNER',
          guarded.recommendation ?? 'request handoff or explicit takeover before claiming',
          { ...guarded },
        );
      }
      if (guarded.status === 'task_not_found') {
        return mcpErrorResponse('TASK_NOT_FOUND', `task ${task_id} not found`);
      }
      if (guarded.status === 'protected_branch_rejected') {
        return mcpErrorResponse(
          'PROTECTED_BRANCH_CLAIM_REJECTED',
          guarded.recommendation ??
            `task ${task_id} is on protected branch ${guarded.protected_branch?.branch}; start a sandbox worktree first`,
          { ...guarded },
        );
      }
      new TaskThread(store, task_id).join(session_id, agentForTaskClaim(session_id));
      const id = store.addObservation({
        session_id,
        kind: 'claim',
        content: note ? `claim ${normalizedFilePath} — ${note}` : `claim ${normalizedFilePath}`,
        task_id,
        metadata: {
          kind: 'claim',
          file_path: normalizedFilePath,
          guarded_claim_status: guarded.status,
        },
      });
      store.storage.touchTask(task_id);
      const previousClaim = previous
        ? compactPreviousClaim(previous, session_id, settings.claimStaleMinutes)
        : null;
      return jsonReply({
        observation_id: id,
        file_path: normalizedFilePath,
        claim_status: guarded.status,
        claim_task_id: guarded.claim_task_id ?? task_id,
        warning: liveContentions[0] ?? null,
        live_file_contentions: liveContentions,
        overlap: previousClaim?.overlap ?? 'none',
        previous_claim: previousClaim,
      });
    }),
  );

  server.tool(
    'task_claim_quota_accept',
    'Resolve quota-pending claim ownership by accepting the linked quota handoff/relay. Transfers all pending claims on that baton to the replacement session, marks the relay/handoff accepted, and writes an audit note.',
    {
      task_id: z.number().int().positive(),
      session_id: z.string().min(1),
      agent: z.string().min(1).optional(),
      file_path: z.string().min(1).optional(),
      handoff_observation_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Linked handoff or relay observation id. Optional when file_path identifies it.'),
    },
    wrapHandler('task_claim_quota_accept', async (args) => {
      try {
        if (!store.storage.getTask(args.task_id)) {
          return mcpErrorResponse('TASK_NOT_FOUND', `task ${args.task_id} not found`);
        }
        const thread = new TaskThread(store, args.task_id);
        thread.join(args.session_id, args.agent ?? agentForTaskClaim(args.session_id));
        const result = thread.acceptQuotaClaim(args);
        return jsonReply(result);
      } catch (err) {
        return mcpError(err);
      }
    }),
  );

  server.tool(
    'task_claim_quota_decline',
    'Decline a quota-pending claim without cancelling the linked relay. Records the reason, retargets the baton to any recipient, and leaves the claim visible for another agent.',
    {
      task_id: z.number().int().positive(),
      session_id: z.string().min(1),
      file_path: z.string().min(1).optional(),
      handoff_observation_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Linked handoff or relay observation id. Optional when file_path identifies it.'),
      reason: z.string().optional(),
    },
    wrapHandler('task_claim_quota_decline', async (args) => {
      try {
        const result = new TaskThread(store, args.task_id).declineQuotaClaim(args);
        return jsonReply(result);
      } catch (err) {
        return mcpError(err);
      }
    }),
  );

  server.tool(
    'task_claim_quota_release_expired',
    'Release expired quota-pending claims from active blocker status. Downgrades matching handoff_pending claims to weak_expired, marks expired relays/handoffs expired, and keeps audit history.',
    {
      task_id: z.number().int().positive(),
      session_id: z.string().min(1),
      file_path: z.string().min(1).optional(),
      handoff_observation_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Linked handoff or relay observation id. Optional to release all expired quota claims on the task.',
        ),
    },
    wrapHandler('task_claim_quota_release_expired', async (args) => {
      try {
        const result = new TaskThread(store, args.task_id).releaseExpiredQuotaClaims(args);
        return jsonReply(result);
      } catch (err) {
        return mcpError(err);
      }
    }),
  );

  // --- task links ---
  // Cross-task edges. Linking two tasks lets each side see the other's
  // timeline + decisions in their own preface, without copy-paste. The
  // storage layer stores one row per unordered pair; the MCP surface is
  // symmetric so callers don't need to think about ordering.

  server.tool(
    'task_link',
    "Link related tasks so each thread sees the other's decisions. Bidirectional, idempotent edges carry cross-task context, notes, and coordination metadata.",
    {
      task_id: z.number().int().positive(),
      other_task_id: z.number().int().positive(),
      session_id: z.string().min(1),
      note: z.string().max(280).optional(),
    },
    wrapHandler('task_link', async ({ task_id, other_task_id, session_id, note }) => {
      if (task_id === other_task_id) {
        return mcpErrorResponse('TASK_LINK_SELF', 'cannot link a task to itself');
      }
      const thread = new TaskThread(store, task_id);
      const link = thread.link(other_task_id, session_id, note);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              low_id: link.low_id,
              high_id: link.high_id,
              created_at: link.created_at,
              created_by: link.created_by,
              note: link.note,
            }),
          },
        ],
      };
    }),
  );

  server.tool(
    'task_unlink',
    'Unlink related tasks when cross-thread coordination is done. Drops bidirectional edge metadata and returns { removed: boolean } for cleanup state.',
    {
      task_id: z.number().int().positive(),
      other_task_id: z.number().int().positive(),
    },
    wrapHandler('task_unlink', async ({ task_id, other_task_id }) => {
      const thread = new TaskThread(store, task_id);
      const removed = thread.unlink(other_task_id);
      return { content: [{ type: 'text', text: JSON.stringify({ removed }) }] };
    }),
  );

  server.tool(
    'task_links',
    'List related tasks linked to this task thread. Returns each edge, other task side, notes, and link metadata for coordination context.',
    { task_id: z.number().int().positive() },
    wrapHandler('task_links', async ({ task_id }) => {
      const thread = new TaskThread(store, task_id);
      const links = thread.linkedTasks();
      return { content: [{ type: 'text', text: JSON.stringify(links) }] };
    }),
  );
}

function jsonReply(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function looksLikeDirectedCoordination(kind: string, content: string): boolean {
  return directedPostTargetAgent(kind, content) !== null;
}

function taskPostHint(kind: string, content: string): string {
  const fallback = 'If you do not know task_id, use task_note_working.';
  if (!looksLikeDirectedCoordination(kind, content)) return fallback;
  return `For directed agent coordination or posts that need a reply, use task_message. ${fallback}`;
}

function taskMessageSuggestionForPost(
  store: ToolContext['store'],
  post: { task_id: number; session_id: string; kind: string; content: string },
):
  | {
      route_to_task_message: true;
      misrouted_directed_coordination: true;
      replacement_tool: 'task_message';
      suggested_tool: 'mcp__colony__task_message';
      suggested_call: string;
      suggested_args: {
        task_id: number;
        session_id: string;
        agent: string;
        to_agent: TaskMessageSuggestionTarget;
        urgency: 'needs_reply';
        content: string;
      };
    }
  | undefined {
  if (post.kind === 'decision') return undefined;
  const toAgent = directedPostTargetAgent(post.kind, post.content);
  if (!toAgent) return undefined;

  const args = {
    task_id: post.task_id,
    session_id: post.session_id,
    agent: postingAgentForSession(store, post.task_id, post.session_id),
    to_agent: toAgent,
    urgency: 'needs_reply' as const,
    content: suggestedTaskMessageContent(post.content),
  };
  return {
    route_to_task_message: true,
    misrouted_directed_coordination: true,
    replacement_tool: 'task_message',
    suggested_tool: 'mcp__colony__task_message',
    suggested_call: `mcp__colony__task_message({ agent: ${JSON.stringify(
      args.agent,
    )}, session_id: ${JSON.stringify(args.session_id)}, task_id: ${
      args.task_id
    }, to_agent: ${JSON.stringify(args.to_agent)}, urgency: "needs_reply", content: ${JSON.stringify(
      args.content,
    )} })`,
    suggested_args: args,
  };
}

function suggestedTaskMessageContent(content: string): string {
  return truncateForRecommendation(normalizePostContent(content), 180);
}

function directedPostTargetAgent(
  kind: string,
  content: string,
): TaskMessageSuggestionTarget | null {
  const normalized = normalizePostContent(content).toLowerCase();
  const target =
    normalized.match(/\bto_agent\s*[:=]\s*["']?(claude|codex)\b/)?.[1] ??
    normalized.match(/\btarget(?:_agent)?\s*[:=]\s*["']?(claude|codex)\b/)?.[1] ??
    normalized.match(/\bhandoff\s+to\s+(claude|codex)\b/)?.[1] ??
    normalized.match(/(^|[^a-z0-9_])@(claude|codex)\b/)?.[2] ??
    normalized.match(/(^|[^a-z0-9_@])(claude|codex)\s*[:,]/)?.[2] ??
    normalized.match(
      /(^|[^a-z0-9_@])(claude|codex)\s+(?:please|pls|can\s+you|could\s+you|would\s+you|needs?\s+reply|check|review|answer|respond|reply|confirm|ack|handle|take|claim|fix|run|verify|finish|inspect|investigate)\b/,
    )?.[2] ??
    normalized.match(
      /\b(?:can|could|would)\s+(?:you\s+)?(?:ask\s+)?(claude|codex)\s+(?:check|review|answer|respond|reply|confirm|verify)\b/,
    )?.[1];
  if (target === 'claude' || target === 'codex') return target;
  if (requiresGenericTaskMessage(kind, normalized)) return 'any';
  return null;
}

function requiresGenericTaskMessage(kind: string, normalized: string): boolean {
  if (kind === 'decision') return false;
  return (
    /\bneeds?\s+reply\b/.test(normalized) ||
    /\b(can|could|would)\s+you\b/.test(normalized) ||
    /\b(please|pls)\b/.test(normalized) ||
    /\bhandoff\s+to\b/.test(normalized)
  );
}

function postingAgentForSession(
  store: ToolContext['store'],
  task_id: number,
  session_id: string,
): string {
  const participant = store.storage
    .listParticipants(task_id)
    .find((row) => row.session_id === session_id && row.left_at === null);
  if (participant?.agent) return participant.agent;
  const identity = detectMcpClientIdentity(process.env, { session_id });
  return identity.inferred_agent === 'unbound' ? 'unknown' : identity.inferred_agent;
}

function proposalRecommendationForPost(
  kind: string,
  content: string,
): TaskPostProposalRecommendation | undefined {
  if (kind !== 'note' && kind !== 'decision') return undefined;
  if (!TASK_POST_FUTURE_WORK_PATTERNS.some((pattern) => pattern.test(content))) return undefined;
  return {
    tool: 'task_propose',
    message: TASK_POST_PROPOSAL_RECOMMENDATION,
    suggested_fields: {
      summary: summarizeFutureWorkPost(content),
      rationale: rationaleForFutureWorkPost(content),
      touches_files: touchedFilesFromPost(content),
    },
  };
}

function summarizeFutureWorkPost(content: string): string {
  const normalized = normalizePostContent(content);
  const stripped = normalized.replace(TASK_POST_FUTURE_WORK_PREFIX_RE, '').trim();
  const firstSentence = stripped.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? stripped;
  const summary = firstSentence.replace(/[.!?]+$/, '').trim();
  return truncateForRecommendation(summary || normalized, TASK_POST_RECOMMENDATION_SUMMARY_LIMIT);
}

function rationaleForFutureWorkPost(content: string): string {
  return truncateForRecommendation(
    `Task post said: ${normalizePostContent(content)}`,
    TASK_POST_RECOMMENDATION_RATIONALE_LIMIT,
  );
}

function touchedFilesFromPost(content: string): string[] {
  const matches =
    content.match(/`[^`]+`|(?:\.{0,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+/g) ?? [];
  const seen = new Set<string>();
  const files: string[] = [];
  for (const match of matches) {
    const file = match
      .replace(/^`|`$/g, '')
      .replace(/^[("'[]+/, '')
      .replace(/[)"'\].,;:!?]+$/g, '');
    if (!file.includes('/') || /^https?:\/\//i.test(file) || seen.has(file)) continue;
    seen.add(file);
    files.push(file);
  }
  return files.slice(0, 8);
}

function normalizePostContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function truncateForRecommendation(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 3).trimEnd()}...`;
}

function compactPreviousClaim(
  claim: ExistingTaskClaim,
  currentSessionId: string,
  claimStaleMinutes: number,
): {
  task_id: number;
  file_path: string;
  by_session_id: string;
  claimed_at: number;
  age_minutes: number;
  age_class: string;
  ownership_strength: string;
  overlap: 'same_session' | 'strong_active' | 'weak_stale';
} {
  const age = classifyClaimAge(claim, { claim_stale_minutes: claimStaleMinutes });
  const sameSession = claim.session_id === currentSessionId;
  return {
    task_id: claim.task_id,
    file_path: claim.file_path,
    by_session_id: claim.session_id,
    claimed_at: claim.claimed_at,
    age_minutes: age.age_minutes,
    age_class: age.age_class,
    ownership_strength: age.ownership_strength,
    overlap: sameSession
      ? 'same_session'
      : age.ownership_strength === 'strong'
        ? 'strong_active'
        : 'weak_stale',
  };
}

function taskListRoutingForSession(
  store: ToolContext['store'],
  sessionId: string,
): { hint: string; coordination_warning?: string } {
  const calls = store.storage.toolCallsSince(Date.now() - TASK_LIST_LOOKBACK_MS);
  const sessionCalls = calls.filter((call) => call.session_id === sessionId);
  const hasReadyCall = sessionCalls.some((call) => isTool(call.tool, 'task_ready_for_agent'));
  const priorTaskListCalls = sessionCalls.filter((call) => isTool(call.tool, 'task_list')).length;
  if (hasReadyCall) {
    return { hint: TASK_LIST_HINT };
  }
  const repeatedInventoryBrowsing = !hasReadyCall && priorTaskListCalls >= 1;
  return {
    hint: repeatedInventoryBrowsing ? TASK_LIST_COORDINATION_WARNING : TASK_LIST_HINT,
    coordination_warning: repeatedInventoryBrowsing
      ? TASK_LIST_REPEAT_WARNING
      : TASK_LIST_COORDINATION_WARNING,
  };
}

function isTool(tool: string, name: string): boolean {
  return tool === name || tool === `colony.${name}` || tool === `mcp__colony__${name}`;
}

function agentForTaskClaim(session_id: string): string {
  const identity = detectMcpClientIdentity(process.env, { session_id });
  return identity.inferred_agent === 'unbound' ? 'unknown' : identity.inferred_agent;
}

interface ActiveTaskCandidate {
  task_id: number;
  title: string;
  repo_root: string;
  branch: string;
  status: string;
  updated_at: number;
  agent: string;
}

interface NearbyTaskMatch {
  task_id: number;
  title: string;
  repo_root: string;
  branch: string;
  status: string;
  updated_at: number;
  match_kind: 'branch_and_repo' | 'branch_only' | 'repo_only';
}

function materializeWorkingNoteTask(
  store: ToolContext['store'],
  opts: { session_id: string; repo_root: string; branch: string },
): ActiveTaskCandidate | null {
  try {
    const thread = TaskThread.open(store, {
      repo_root: resolve(opts.repo_root),
      branch: opts.branch,
      session_id: opts.session_id,
    });
    const agent = agentForWorkingNoteParticipant(opts.session_id, opts.branch);
    thread.join(opts.session_id, agent);
    const task = thread.task();
    if (!task) return null;
    return {
      task_id: task.id,
      title: task.title,
      repo_root: task.repo_root,
      branch: task.branch,
      status: task.status,
      updated_at: task.updated_at,
      agent,
    };
  } catch {
    return null;
  }
}

function agentForWorkingNoteParticipant(session_id: string, branch: string): string {
  const identity = detectMcpClientIdentity(process.env, { session_id, branch });
  return identity.inferred_agent === 'unbound' ? 'unknown' : identity.inferred_agent;
}

/**
 * Wider lookup used by `task_note_working` when the strict session/
 * repo/branch filter returns zero candidates. Excludes any task the
 * caller's session already participates in (those would already appear
 * in the narrow result) and ranks branch-exact matches above repo-only
 * matches. Returns at most `limit` rows so callers can render the
 * shortlist without paging.
 */
function nearbyTaskMatches(
  store: ToolContext['store'],
  opts: { repo_root?: string; branch?: string; limit: number },
): NearbyTaskMatch[] {
  if (opts.repo_root === undefined && opts.branch === undefined) return [];
  const matches: NearbyTaskMatch[] = [];
  const normalizedRepo = opts.repo_root !== undefined ? resolve(opts.repo_root) : null;
  for (const task of store.storage.listTasks(2000)) {
    const repoMatch = normalizedRepo !== null && resolve(task.repo_root) === normalizedRepo;
    const branchMatch = opts.branch !== undefined && task.branch === opts.branch;
    if (!repoMatch && !branchMatch) continue;
    const matchKind: NearbyTaskMatch['match_kind'] = repoMatch
      ? branchMatch
        ? 'branch_and_repo'
        : 'repo_only'
      : 'branch_only';
    matches.push({
      task_id: task.id,
      title: task.title,
      repo_root: task.repo_root,
      branch: task.branch,
      status: task.status,
      updated_at: task.updated_at,
      match_kind: matchKind,
    });
  }
  const rank: Record<NearbyTaskMatch['match_kind'], number> = {
    branch_and_repo: 0,
    branch_only: 1,
    repo_only: 2,
  };
  return matches
    .sort((a, b) => {
      const byRank = rank[a.match_kind] - rank[b.match_kind];
      if (byRank !== 0) return byRank;
      return b.updated_at - a.updated_at;
    })
    .slice(0, opts.limit);
}

function activeTaskCandidates(
  store: ToolContext['store'],
  opts: { session_id: string; repo_root?: string; branch?: string },
): ActiveTaskCandidate[] {
  const candidates: ActiveTaskCandidate[] = [];
  for (const task of store.storage.listTasks(2000)) {
    if (opts.repo_root !== undefined && resolve(task.repo_root) !== resolve(opts.repo_root)) {
      continue;
    }
    if (opts.branch !== undefined && task.branch !== opts.branch) continue;
    const participant = store.storage
      .listParticipants(task.id)
      .find((row) => row.session_id === opts.session_id && row.left_at === null);
    if (!participant) continue;
    candidates.push({
      task_id: task.id,
      title: task.title,
      repo_root: task.repo_root,
      branch: task.branch,
      status: task.status,
      updated_at: task.updated_at,
      agent: participant.agent,
    });
  }
  return candidates.sort((a, b) => b.updated_at - a.updated_at);
}

function writeOmxNotepadPointer(opts: {
  repo_root?: string | undefined;
  branch?: string | undefined;
  pointer?: WorkingNotePointerInput | undefined;
  colony_observation_id: number | null;
  candidate: ActiveTaskCandidate | null;
}): OmxNotepadPointerResult {
  const repoRoot = opts.repo_root ?? opts.candidate?.repo_root;
  if (!repoRoot) {
    return { status: 'unavailable', reason: 'repo_root is required' };
  }

  try {
    const omxDir = join(resolve(repoRoot), '.omx');
    mkdirSync(omxDir, { recursive: true });
    const path = join(omxDir, 'notepad.md');
    appendFileSync(path, `${formatOmxNotepadPointer(opts)}\n`, 'utf8');
    return { status: 'written', path };
  } catch (err) {
    return {
      status: 'unavailable',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function formatOmxNotepadPointer(opts: {
  branch?: string | undefined;
  pointer?: WorkingNotePointerInput | undefined;
  colony_observation_id: number | null;
  candidate: ActiveTaskCandidate | null;
}): string {
  const p = opts.pointer;
  const observationId = opts.colony_observation_id ?? 'unavailable';
  return [
    ['branch', pointerValue(p?.branch ?? opts.branch ?? opts.candidate?.branch, 'unknown')],
    ['task', pointerValue(p?.task ?? opts.candidate?.title, 'unknown')],
    ['blocker', pointerValue(p?.blocker, 'none')],
    ['next', pointerValue(p?.next, 'unknown')],
    ['evidence', pointerValue(p?.evidence, 'unavailable')],
    ['colony_observation_id', pointerValue(observationId, 'unavailable')],
  ]
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

function pointerValue(value: string | number | undefined, fallback: string): string {
  const raw = value === undefined || String(value).trim() === '' ? fallback : String(value);
  const compact = raw
    .replace(/[\r\n;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return compact.length > OMX_POINTER_VALUE_LIMIT
    ? `${compact.slice(0, OMX_POINTER_VALUE_LIMIT - 3).trimEnd()}...`
    : compact;
}

function compactPlanTimelineMetadata(
  store: ToolContext['store'],
  task_id: number,
): {
  plan_slug: string;
  subtask_index: number;
  wave_index: number;
  wave_name: string;
  depends_on: number[];
  blocked_by: number[];
} | null {
  const task = store.storage.listTasks(2000).find((candidate) => candidate.id === task_id);
  const match = task?.branch.match(SUBTASK_BRANCH_RE);
  if (!task || !match) return null;

  const planSlug = match[1];
  const rawSubtaskIndex = match[2];
  if (!planSlug || rawSubtaskIndex === undefined) return null;

  const subtaskIndex = Number(rawSubtaskIndex);
  const plan = listPlans(store, { repo_root: task.repo_root, limit: 2000 }).find(
    (candidate) => candidate.plan_slug === planSlug,
  );
  const subtask = plan?.subtasks.find((candidate) => candidate.subtask_index === subtaskIndex);
  if (!subtask) return null;

  return {
    plan_slug: planSlug,
    subtask_index: subtask.subtask_index,
    wave_index: subtask.wave_index ?? 0,
    wave_name: subtask.wave_name ?? 'Wave 1',
    depends_on: subtask.depends_on,
    blocked_by: subtask.blocked_by ?? [],
  };
}
