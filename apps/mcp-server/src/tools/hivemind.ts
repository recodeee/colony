import { resolve } from 'node:path';
import {
  type AttentionInbox,
  type Embedder,
  type MemoryStore,
  type SearchResult,
  buildAttentionInbox,
  listPlans,
  readHivemind,
} from '@colony/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type ToolContext, defaultWrapHandler } from './context.js';
import { detectMcpClientIdentity } from './heartbeat.js';
import {
  type CompactNegativeWarning,
  HIVEMIND_ATTENTION_HYDRATE_WITH,
  HIVEMIND_ATTENTION_HYDRATION,
  type HivemindAdoptionNudge,
  buildContextQuery,
  buildHivemindContext,
  buildHivemindLocalContext,
  buildLocalContextQuery,
  resolveLocalContextTask,
  searchNegativeWarnings,
  toHivemindOptions,
} from './shared.js';

const DEFAULT_CONTEXT_LANE_LIMIT = 8;
const DEFAULT_LOCAL_CONTEXT_LANE_LIMIT = 3;
const DEFAULT_CONTEXT_MEMORY_LIMIT = 3;
const DEFAULT_CONTEXT_CLAIM_LIMIT = 12;
const DEFAULT_CONTEXT_HOT_FILE_LIMIT = 8;
const DEFAULT_CONTEXT_ATTENTION_ID_LIMIT = 12;
const ADOPTION_NUDGE_LOOKBACK_MS = 24 * 60 * 60_000;
const ATTENTION_INBOX_RECENT_LOOKBACK_MS = 10 * 60_000;
const TARGET_TASK_READY_PER_LIST = 0.3;
const TARGET_COLONY_NOTE_SHARE = 0.7;
const TARGET_CLAIM_BEFORE_EDIT = 0.5;

export function register(server: McpServer, ctx: ToolContext): void {
  const wrapHandler = ctx.wrapHandler ?? defaultWrapHandler;
  const { store, resolveEmbedder } = ctx;

  server.tool(
    'hivemind',
    'See what other agents are doing right now. Summarizes active sessions, branches, task ownership, stale lanes, and runtime state before coordination.',
    {
      repo_root: z.string().min(1).optional(),
      repo_roots: z.array(z.string().min(1)).max(20).optional(),
      include_stale: z.boolean().optional(),
      limit: z.number().int().positive().max(100).optional(),
    },
    wrapHandler('hivemind', async ({ repo_root, repo_roots, include_stale, limit }) => {
      const options: Parameters<typeof readHivemind>[0] = {};
      if (repo_root !== undefined) options.repoRoot = repo_root;
      if (repo_roots !== undefined) options.repoRoots = repo_roots;
      if (include_stale !== undefined) options.includeStale = include_stale;
      if (limit !== undefined) options.limit = limit;
      const snapshot = readHivemind(options);
      return { content: [{ type: 'text', text: JSON.stringify(snapshot) }] };
    }),
  );

  server.tool(
    'hivemind_context',
    'Before editing, inspect ownership, then call attention_inbox now before choosing work. Returns suggested_call, active ownership, relevant memory, negative warnings, nearby claims, hot files, compact attention counts, and observation IDs.',
    {
      repo_root: z.string().min(1).optional(),
      repo_roots: z.array(z.string().min(1)).max(20).optional(),
      include_stale: z.boolean().optional(),
      limit: z.number().int().positive().max(100).optional(),
      query: z.string().min(1).optional(),
      memory_limit: z.number().int().positive().max(10).optional(),
      max_claims: z.number().int().positive().max(100).optional(),
      max_hot_files: z.number().int().positive().max(100).optional(),
      attention_id_limit: z.number().int().positive().max(100).optional(),
      session_id: z.string().min(1).optional(),
      agent: z.string().min(1).optional(),
      mode: z.enum(['overview', 'local']).optional(),
      task_id: z.number().int().positive().optional(),
      files: z.array(z.string().min(1)).max(50).optional(),
    },
    wrapHandler(
      'hivemind_context',
      async ({
        repo_root,
        repo_roots,
        include_stale,
        limit,
        query,
        memory_limit,
        max_claims,
        max_hot_files,
        attention_id_limit,
        session_id,
        agent,
        mode,
        task_id,
        files,
      }) => {
        const localMode = mode === 'local' || task_id !== undefined || (files?.length ?? 0) > 0;
        const attentionIdentity = resolveAttentionIdentity(session_id, agent);
        const laneLimit =
          limit ?? (localMode ? DEFAULT_LOCAL_CONTEXT_LANE_LIMIT : DEFAULT_CONTEXT_LANE_LIMIT);
        const snapshot = readHivemind(
          toHivemindOptions({ repo_root, repo_roots, include_stale, limit: laneLimit }),
        );
        const memoryLimit = memory_limit ?? DEFAULT_CONTEXT_MEMORY_LIMIT;
        const maxClaims = max_claims ?? DEFAULT_CONTEXT_CLAIM_LIMIT;
        const maxHotFiles = max_hot_files ?? DEFAULT_CONTEXT_HOT_FILE_LIMIT;
        const attentionLimit = attention_id_limit ?? DEFAULT_CONTEXT_ATTENTION_ID_LIMIT;
        const currentTask = localMode
          ? resolveLocalContextTask(store, {
              ...(repo_root !== undefined ? { repoRoot: repo_root } : {}),
              sessionId: attentionIdentity.session_id,
              ...(task_id !== undefined ? { taskId: task_id } : {}),
              files: files ?? [],
            })
          : null;
        const contextQuery = localMode
          ? buildLocalContextQuery({
              query,
              currentTask,
              files: files ?? [],
              sessions: snapshot.sessions,
            })
          : buildContextQuery(query, snapshot.sessions);
        let memoryHits: SearchResult[] = [];
        let negativeWarnings: CompactNegativeWarning[] = [];

        if (contextQuery) {
          const e = (await resolveEmbedder()) ?? undefined;
          memoryHits = localMode
            ? await searchLocalMemoryHits(
                store,
                e,
                [contextQuery, currentTask?.title, ...(files ?? [])],
                memoryLimit,
              )
            : await store.search(contextQuery, memoryLimit, e);
          negativeWarnings = localMode
            ? await searchLocalNegativeWarnings(
                store,
                [contextQuery, currentTask?.title, ...(files ?? [])],
                currentTask?.id,
                Math.min(memoryLimit, 3),
              )
            : await searchNegativeWarnings(store, contextQuery, Math.min(memoryLimit, 3));
        }

        const attentionBaseOptions = {
          session_id: attentionIdentity.session_id,
          agent: attentionIdentity.agent,
          ...(repo_root !== undefined ? { repo_root } : {}),
          ...(repo_roots !== undefined ? { repo_roots } : {}),
          include_stalled_lanes: false,
          unread_message_limit: attentionLimit,
          recent_claim_limit: maxClaims,
        };
        const scopedAttentionInbox = buildAttentionInbox(store, {
          ...attentionBaseOptions,
          claim_stale_ms: ctx.settings.claimStaleMinutes * 60_000,
          ...(localMode && currentTask ? { task_ids: [currentTask.id] } : {}),
        });
        const attentionInbox =
          localMode && currentTask
            ? preserveBlockingAttention(
                scopedAttentionInbox,
                buildAttentionInbox(store, {
                  ...attentionBaseOptions,
                  claim_stale_ms: ctx.settings.claimStaleMinutes * 60_000,
                }),
                attentionLimit,
              )
            : scopedAttentionInbox;
        const attentionIds = attentionObservationIds(attentionInbox, attentionLimit);
        const attentionInput = {
          session_id: attentionIdentity.session_id,
          agent: attentionIdentity.agent,
          summary: attentionInbox.summary,
          observation_ids: attentionIds.ids,
          observation_ids_truncated: attentionIds.truncated,
        };
        const attentionCounts = {
          lane_needs_attention_count: 0,
          pending_handoff_count: attentionInput.summary.pending_handoff_count,
          pending_wake_count: attentionInput.summary.pending_wake_count,
          unread_message_count: attentionInput.summary.unread_message_count,
          paused_lane_count: attentionInput.summary.paused_lane_count,
          stalled_lane_count: attentionInput.summary.stalled_lane_count,
          recent_other_claim_count: attentionInput.summary.recent_other_claim_count,
          fresh_other_claim_count: attentionInput.summary.fresh_other_claim_count,
          stale_other_claim_count: attentionInput.summary.stale_other_claim_count,
          expired_other_claim_count: attentionInput.summary.expired_other_claim_count,
          weak_other_claim_count: attentionInput.summary.weak_other_claim_count,
          blocked: attentionInput.summary.blocked,
        };
        const attentionContext = {
          session_id: attentionInput.session_id,
          agent: attentionInput.agent,
          unread_messages: attentionCounts.unread_message_count,
          pending_handoffs: attentionCounts.pending_handoff_count,
          pending_wakes: attentionCounts.pending_wake_count,
          blocking: attentionCounts.blocked,
          stale_claims: attentionCounts.stale_other_claim_count,
          expired_claims: attentionCounts.expired_other_claim_count,
          weak_claims: attentionCounts.weak_other_claim_count,
          paused_lanes: attentionCounts.paused_lane_count,
          stalled_lanes: attentionCounts.stalled_lane_count,
          counts: attentionCounts,
          observation_ids: attentionInput.observation_ids,
          observation_ids_truncated: attentionInput.observation_ids_truncated,
          hydration: HIVEMIND_ATTENTION_HYDRATION,
          hydrate_with: HIVEMIND_ATTENTION_HYDRATE_WITH,
          next_action: attentionInput.summary.next_action,
        };
        const localContext = localMode
          ? buildHivemindLocalContext(store, {
              sessionId: attentionIdentity.session_id,
              ...(task_id !== undefined ? { requestedTaskId: task_id } : {}),
              files: files ?? [],
              currentTask,
              memoryHits,
              negativeWarnings,
              attention: attentionContext,
              maxClaims,
              maxHotFiles,
            })
          : undefined;
        const readyWorkCount = countReadyWork(store, { repo_root, repo_roots });
        const adoptionNudges = buildAdoptionNudges(store);
        const mustCheckAttention = !hasRecentAttentionInboxCall(
          store,
          attentionIdentity.session_id,
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                buildHivemindContext(snapshot, memoryHits, negativeWarnings, contextQuery, {
                  maxClaims,
                  maxHotFiles,
                  attention: attentionInput,
                  readyWorkCount,
                  adoptionNudges,
                  mustCheckAttention,
                  ...(localContext !== undefined ? { localContext } : {}),
                }),
              ),
            },
          ],
        };
      },
    ),
  );
}

function hasRecentAttentionInboxCall(store: MemoryStore, sessionId: string): boolean {
  const since = Date.now() - ATTENTION_INBOX_RECENT_LOOKBACK_MS;
  return store.storage
    .toolCallsSince(since)
    .some((call) => call.session_id === sessionId && isColonyTool(call.tool, 'attention_inbox'));
}

function resolveAttentionIdentity(
  sessionId: string | undefined,
  agent: string | undefined,
): { session_id: string; agent: string } {
  const detected = detectMcpClientIdentity();
  return {
    session_id: sessionId ?? detected.sessionId,
    agent: agent ?? agentFromIde(detected.ide),
  };
}

function countReadyWork(
  store: MemoryStore,
  input: { repo_root: string | undefined; repo_roots: string[] | undefined },
): number {
  const roots = new Set(
    [input.repo_root, ...(input.repo_roots ?? [])]
      .filter((root): root is string => typeof root === 'string' && root.trim().length > 0)
      .map((root) => resolve(root)),
  );
  return listPlans(store, { limit: 2000 })
    .filter((plan) => roots.size === 0 || roots.has(resolve(plan.repo_root)))
    .reduce((total, plan) => total + plan.next_available.length, 0);
}

function buildAdoptionNudges(store: MemoryStore, now = Date.now()): HivemindAdoptionNudge[] {
  try {
    return adoptionNudgesFromMetrics(store, now);
  } catch {
    return [];
  }
}

function adoptionNudgesFromMetrics(store: MemoryStore, now: number): HivemindAdoptionNudge[] {
  const since = now - ADOPTION_NUDGE_LOOKBACK_MS;
  const calls = store.storage.toolCallsSince(since);
  const nudges: HivemindAdoptionNudge[] = [];
  const taskListCalls = countColonyTool(calls, 'task_list');
  const taskReadyCalls = countColonyTool(calls, 'task_ready_for_agent');
  const readyPerList = ratio(taskReadyCalls, taskListCalls);

  if (taskListCalls > 0 && (readyPerList ?? 0) < TARGET_TASK_READY_PER_LIST) {
    nudges.push({
      key: 'task_list_overuse',
      tool: 'task_ready_for_agent',
      current: `task_list=${taskListCalls}; task_ready_for_agent=${taskReadyCalls}`,
      hint: 'Use task_ready_for_agent before choosing work; task_list is inventory.',
    });
  }

  const colonyWorkingNotes =
    countColonyTool(calls, 'task_post') + countColonyTool(calls, 'task_note_working');
  const omxNotepadWrites = calls.filter((call) => isOmxNotepadWrite(call.tool)).length;
  const colonyNoteShare = ratio(colonyWorkingNotes, colonyWorkingNotes + omxNotepadWrites);

  if (
    omxNotepadWrites > 0 &&
    colonyNoteShare !== null &&
    colonyNoteShare < TARGET_COLONY_NOTE_SHARE
  ) {
    nudges.push({
      key: 'notepad_overuse',
      tool: 'task_note_working',
      current: `colony_notes=${colonyWorkingNotes}; omx_notepad_writes=${omxNotepadWrites}`,
      hint: 'Use task_note_working for task-scoped working state; keep OMX notepad as fallback.',
    });
  }

  try {
    const claimStats = store.storage.claimBeforeEditStats(since);
    const claimBeforeEditRatio = ratio(
      claimStats.edits_claimed_before,
      claimStats.edits_with_file_path,
    );

    if (
      claimStats.edits_with_file_path > 0 &&
      claimBeforeEditRatio !== null &&
      claimBeforeEditRatio < TARGET_CLAIM_BEFORE_EDIT
    ) {
      const preToolUseSignals = claimStats.pre_tool_use_signals ?? 0;
      const likelyMissingHook = claimStats.edits_claimed_before === 0 && preToolUseSignals === 0;
      nudges.push({
        key: 'claim_before_edit_low',
        tool: 'task_claim_file',
        current: `claimed_before_edit=${claimStats.edits_claimed_before}/${claimStats.edits_with_file_path}; pre_tool_use_signals=${preToolUseSignals}`,
        hint: likelyMissingHook
          ? 'PreToolUse auto-claim is not covering edits. Run colony install --ide <ide>, restart the editor, or call task_claim_file before editing.'
          : 'Call task_claim_file for touched files before edit tools.',
      });
    }
  } catch {
    // Keep the context response and other adoption nudges available.
  }

  return nudges;
}

type ToolCall = ReturnType<MemoryStore['storage']['toolCallsSince']>[number];

function countColonyTool(calls: ToolCall[], toolName: string): number {
  return calls.filter((call) => isColonyTool(call.tool, toolName)).length;
}

function isColonyTool(tool: string, toolName: string): boolean {
  return tool === toolName || tool === `colony.${toolName}` || tool === `mcp__colony__${toolName}`;
}

function isOmxNotepadWrite(tool: string): boolean {
  return /(^|[_:.])notepad_write(_|$)/.test(tool) || /omx.*notepad.*write/i.test(tool);
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function agentFromIde(ide: string): string {
  return ide === 'claude-code' ? 'claude' : ide;
}

function attentionObservationIds(
  inbox: AttentionInbox,
  limit: number,
): { ids: number[]; truncated: boolean } {
  const orderedIds = [
    ...inbox.unread_messages.filter((m) => m.urgency === 'blocking').map((m) => m.id),
    ...inbox.pending_handoffs.map((h) => h.id),
    ...inbox.pending_wakes.map((w) => w.id),
    ...inbox.unread_messages.filter((m) => m.urgency === 'needs_reply').map((m) => m.id),
    ...inbox.coalesced_messages.map((m) => m.latest_id),
    ...inbox.read_receipts.map((r) => r.read_message_id),
  ];
  const uniqueIds = [...new Set(orderedIds)];
  return { ids: uniqueIds.slice(0, limit), truncated: uniqueIds.length > limit };
}

function preserveBlockingAttention(
  scoped: AttentionInbox,
  broad: AttentionInbox,
  limit: number,
): AttentionInbox {
  const localMessageIds = new Set(scoped.unread_messages.map((message) => message.id));
  const byId = new Map(scoped.unread_messages.map((message) => [message.id, message]));
  for (const message of broad.unread_messages) {
    if (message.urgency === 'blocking') byId.set(message.id, message);
  }
  const unreadMessages = [...byId.values()].sort((a, b) => b.ts - a.ts).slice(0, limit);
  const existingGroupIds = new Set(scoped.coalesced_messages.flatMap((group) => group.message_ids));
  const extraBlockingGroups = unreadMessages
    .filter((message) => message.urgency === 'blocking' && !existingGroupIds.has(message.id))
    .map((message) => ({
      task_id: message.task_id,
      from_session_id: message.from_session_id,
      from_agent: message.from_agent,
      urgency: message.urgency,
      count: 1,
      message_ids: [message.id],
      latest_id: message.id,
      latest_ts: message.ts,
      latest_preview: message.preview,
    }));
  const hasOutsideBlocker = unreadMessages.some(
    (message) => message.urgency === 'blocking' && !localMessageIds.has(message.id),
  );
  const blocked = unreadMessages.some((message) => message.urgency === 'blocking');

  return {
    ...scoped,
    summary: {
      ...scoped.summary,
      unread_message_count: unreadMessages.length,
      blocked,
      next_action: hasOutsideBlocker
        ? 'Reply to blocking task messages before local edits.'
        : scoped.summary.next_action,
    },
    unread_messages: unreadMessages,
    coalesced_messages: [...scoped.coalesced_messages, ...extraBlockingGroups].sort(
      (a, b) => b.latest_ts - a.latest_ts,
    ),
  };
}

async function searchLocalMemoryHits(
  store: MemoryStore,
  embedder: Embedder | undefined,
  queries: Array<string | undefined>,
  limit: number,
): Promise<SearchResult[]> {
  const byId = new Map<number, SearchResult>();
  for (const query of compactQueries(queries)) {
    const hits = await store.search(query, limit, embedder);
    for (const hit of hits) {
      const current = byId.get(hit.id);
      if (
        !current ||
        hit.score > current.score ||
        (hit.score === current.score && hit.ts > current.ts)
      ) {
        byId.set(hit.id, hit);
      }
      if (byId.size >= limit) break;
    }
    if (byId.size >= limit) break;
  }
  return [...byId.values()].sort((a, b) => b.score - a.score || b.ts - a.ts).slice(0, limit);
}

async function searchLocalNegativeWarnings(
  store: MemoryStore,
  queries: Array<string | undefined>,
  taskId: number | undefined,
  limit: number,
): Promise<CompactNegativeWarning[]> {
  const byId = new Map<number, CompactNegativeWarning>();
  for (const query of compactQueries(queries)) {
    const hits = await searchNegativeWarnings(store, query, limit);
    for (const hit of hits) {
      if (taskId !== undefined && hit.task_id !== null && hit.task_id !== taskId) continue;
      const current = byId.get(hit.id);
      if (!current || hit.ts > current.ts) byId.set(hit.id, hit);
      if (byId.size >= limit) break;
    }
    if (byId.size >= limit) break;
  }
  return [...byId.values()].sort((a, b) => b.ts - a.ts).slice(0, limit);
}

function compactQueries(queries: Array<string | undefined>): string[] {
  return [
    ...new Set(
      queries.flatMap((entry) => {
        const trimmed = entry?.trim();
        return trimmed ? [trimmed] : [];
      }),
    ),
  ];
}
