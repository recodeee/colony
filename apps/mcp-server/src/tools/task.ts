import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TaskThread, classifyClaimAge, listPlans } from '@colony/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type ToolContext, defaultWrapHandler } from './context.js';
import { detectMcpClientIdentity } from './heartbeat.js';
import { mcpErrorResponse } from './shared.js';

const SUBTASK_BRANCH_RE = /^spec\/([a-z0-9-]+)\/sub-(\d+)$/;
const TASK_LIST_HINT =
  'Use task_ready_for_agent to choose claimable work; task_list is for browsing.';
const TASK_LIST_COORDINATION_WARNING =
  'task_list is inventory. Use task_ready_for_agent to choose claimable work.';
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
    'Browse task threads; use task_ready_for_agent when choosing work to claim. Lists shared coordination lanes by repo_root, branch, participants, status, and recent activity.',
    {
      limit: z.number().int().positive().max(200).optional(),
      session_id: z.string().min(1).optional(),
    },
    wrapHandler('task_list', async ({ limit, session_id }) => {
      const tasks = store.storage.listTasks(limit ?? 50);
      const callerSessionId = session_id ?? detectMcpClientIdentity().sessionId;
      const routing = taskListRoutingForSession(store, callerSessionId);
      return jsonReply({
        tasks,
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
      'Post shared task notes, decisions, blockers, questions, answers, or warnings.',
      'Use task_message for directed agent-to-agent coordination.',
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
      const thread = new TaskThread(store, task_id);
      const id = thread.post({
        session_id,
        kind,
        content,
        ...(reply_to !== undefined ? { reply_to } : {}),
      });
      const recommendation = proposalRecommendationForPost(kind, content);
      return jsonReply({
        id,
        hint: taskPostHint(content),
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
        const candidates = activeTaskCandidates(store, {
          session_id,
          ...(repo_root !== undefined ? { repo_root } : {}),
          ...(branch !== undefined ? { branch } : {}),
        });
        const visibleCandidates = candidates.slice(0, candidate_limit ?? 10);

        if (candidates.length !== 1) {
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
    'Claim a file before editing so other agents see ownership and overlap warnings. Use before editing to avoid conflict and make file ownership visible; claims are soft coordination and never block writes.',
    {
      task_id: z.number().int().positive(),
      session_id: z.string().min(1),
      file_path: z.string().min(1),
      note: z.string().optional(),
    },
    wrapHandler('task_claim_file', async ({ task_id, session_id, file_path, note }) => {
      const previous = store.storage.getClaim(task_id, file_path);
      const thread = new TaskThread(store, task_id);
      const id = thread.claimFile({
        session_id,
        file_path,
        ...(note !== undefined ? { note } : {}),
      });
      const previousClaim = previous
        ? compactPreviousClaim(previous, session_id, settings.claimStaleMinutes)
        : null;
      return jsonReply({
        observation_id: id,
        overlap: previousClaim?.overlap ?? 'none',
        previous_claim: previousClaim,
      });
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

function looksLikeDirectedCoordination(content: string): boolean {
  const normalized = content.toLowerCase();
  const mentionsAgent = /(^|[^a-z0-9_@])@?(claude|codex|agent[-_\s]?\d+)(?=$|[^a-z0-9_])/.test(
    normalized,
  );
  const asksForActionOrReply =
    /(^|[^a-z])(reply|respond|answer|ack|confirm)(?=$|[^a-z])/.test(normalized) ||
    /\b(can|could|would)\s+you\b/.test(normalized) ||
    /\b(please|pls)\b/.test(normalized) ||
    /\b(review|take|claim|fix|run|check|look|finish|verify|handle|continue|update|send|post|mark|merge|open|close|re-?run|inspect|investigate)\b/.test(
      normalized,
    ) ||
    /\?/.test(normalized);
  return mentionsAgent && asksForActionOrReply;
}

function taskPostHint(content: string): string {
  const fallback = 'If you do not know task_id, use task_note_working.';
  if (!looksLikeDirectedCoordination(content)) return fallback;
  return `For directed agent coordination, use task_message. ${fallback}`;
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
  const age = classifyClaimAge(claim.claimed_at, { claim_stale_minutes: claimStaleMinutes });
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
): { hint: string; coordination_warning: string } {
  const calls = store.storage.toolCallsSince(Date.now() - TASK_LIST_LOOKBACK_MS);
  const sessionCalls = calls.filter((call) => call.session_id === sessionId);
  const hasReadyCall = sessionCalls.some((call) => isTool(call.tool, 'task_ready_for_agent'));
  const priorTaskListCalls = sessionCalls.filter((call) => isTool(call.tool, 'task_list')).length;
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

interface ActiveTaskCandidate {
  task_id: number;
  title: string;
  repo_root: string;
  branch: string;
  status: string;
  updated_at: number;
  agent: string;
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
