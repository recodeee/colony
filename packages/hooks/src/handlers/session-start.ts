import {
  type AttentionBudgetOutput,
  type AttentionItem,
  type Embedder,
  type InboxMessage,
  type MemoryStore,
  ProposalSystem,
  TaskThread,
  applyAttentionBudget,
  buildAttentionInbox,
  detectRepoBranch,
} from '@colony/core';
import { spawnNodeScript } from '@colony/process';
import { buildScopeCheckPreface } from '../preface-conflict-map.js';
import type { HookInput } from '../types.js';

export interface SuggestionPrefaceDeps {
  resolveEmbedder?: (store: MemoryStore) => Promise<Embedder | null>;
  loadCore?: () => Promise<SuggestionCore | null>;
}

interface SuggestionThresholds {
  SIMILARITY_FLOOR: number;
  PREFACE_INCLUSION_THRESHOLD: number;
  PREFACE_FILE_CONFIDENCE_THRESHOLD: number;
  MIN_SIMILAR_TASKS_FOR_SUGGESTION: number;
}

interface SimilarTask {
  task_id: number;
  similarity: number;
  branch: string;
  repo_root: string;
  status: string;
  observation_count: number;
}

interface SuggestionFileRanking {
  file_path: string;
  confidence: number;
}

interface SuggestionPattern {
  description: string;
}

interface SuggestionResolutionHints {
  median_elapsed_minutes: number;
  median_handoff_count: number;
}

interface SuggestionPayload {
  similar_tasks: SimilarTask[];
  first_files_likely_claimed: SuggestionFileRanking[];
  patterns_to_watch: SuggestionPattern[];
  resolution_hints: SuggestionResolutionHints | null;
  insufficient_data_reason: string | null;
}

interface SuggestionCore {
  SUGGESTION_THRESHOLDS: SuggestionThresholds;
  findSimilarTasks: (
    store: MemoryStore,
    embedder: Embedder,
    query_embedding: Float32Array,
    options?: {
      repo_root?: string;
      min_similarity?: number;
      limit?: number;
      exclude_task_ids?: number[];
    },
  ) => SimilarTask[];
  buildSuggestionPayload: (store: MemoryStore, similar_tasks: SimilarTask[]) => SuggestionPayload;
}

let cachedSuggestionEmbedder: Embedder | null | undefined;

export async function sessionStart(
  store: MemoryStore,
  input: HookInput,
  deps: SuggestionPrefaceDeps = {},
): Promise<string> {
  // Idempotent: Claude Code re-fires SessionStart on resume/clear/compact with
  // the same session_id. We must not blow up on the duplicate.
  store.startSession({
    id: input.session_id,
    ide: input.ide ?? 'unknown',
    cwd: input.cwd ?? null,
  });

  kickForagingScan(store, input);

  const priorPreface = buildPriorPreface(store, input);
  const taskPreface = buildTaskPreface(store, input);
  const suggestionPreface = await buildSuggestionPreface(store, input, deps);
  const proposalPreface = buildProposalPreface(store, input);
  const foragingPreface = buildForagingPreface(store, input);
  const scopeCheckPreface = buildScopeCheckPreface(store, input);
  const attentionBudgetPreface = buildAttentionBudgetSection(store, input);

  return [
    priorPreface,
    taskPreface,
    suggestionPreface,
    proposalPreface,
    foragingPreface,
    scopeCheckPreface,
    attentionBudgetPreface,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Detach-spawn the CLI's `foraging scan` so the scan runs in the
 * background. The hook itself must not wait — the synchronous preface
 * below only surfaces state from a *previous* scan. First SessionStart
 * on a new repo therefore shows nothing foraging-related; second one
 * shows the indexed set once the background scan has finished.
 */
function kickForagingScan(store: MemoryStore, input: HookInput): void {
  const settings = store.settings;
  if (!settings.foraging.enabled) return;
  if (!settings.foraging.scanOnSessionStart) return;
  const cwd = input.cwd;
  if (!cwd) return;
  const cli = process.argv[1];
  if (!cli) return;
  try {
    spawnNodeScript(cli, ['foraging', 'scan', '--cwd', cwd]);
  } catch {
    // Best-effort. Foraging is not load-bearing for the hook's primary job.
  }
}

export function buildForagingPreface(store: MemoryStore, input: Pick<HookInput, 'cwd'>): string {
  if (!input.cwd) return '';
  const rows = store.storage.listExamples(input.cwd);
  if (rows.length === 0) return '';
  const names = rows
    .slice(0, 5)
    .map((r) => r.example_name)
    .join(', ');
  const more = rows.length > 5 ? ` (+${rows.length - 5} more)` : '';
  return [
    '## Examples indexed (foraging)',
    `${rows.length} food source${rows.length === 1 ? '' : 's'}: ${names}${more}.`,
    'Query with examples_query; fetch a plan with examples_integrate_plan.',
  ].join('\n');
}

export function buildAttentionBudgetSection(
  store: MemoryStore,
  input: Pick<HookInput, 'session_id' | 'cwd' | 'ide'>,
): string {
  const cwd = input.cwd;
  if (!cwd) return '';
  const detected = detectRepoBranch(cwd);
  if (!detected) return '';

  const agent = deriveAgent(input.ide, detected.branch);
  const inbox = buildAttentionInbox(store, {
    session_id: input.session_id,
    agent,
    repo_root: detected.repo_root,
  });
  const budget = applyAttentionBudget(inbox);
  return renderAttentionBudget(budget, inbox.generated_at);
}

function renderAttentionBudget(budget: AttentionBudgetOutput, now: number): string {
  if (budget.total === 0) return '';

  const lines = [`Attention (${budget.prominent.length} of ${budget.total}):`];
  for (const item of budget.prominent) {
    lines.push(`  → ${item.urgency}: ${compactPreview(item.summary)}${attentionTiming(item, now)}`);
  }

  const collapsed = collapsedCountText(budget.collapsed_counts);
  if (collapsed) {
    lines.push(`  Plus ${collapsed} collapsed. Run attention_inbox to see all.`);
  }

  return lines.join('\n');
}

function collapsedCountText(counts: AttentionBudgetOutput['collapsed_counts']): string {
  const parts = (['blocking', 'needs_reply', 'fyi'] as const)
    .filter((urgency) => counts[urgency] > 0)
    .map((urgency) => `${counts[urgency]} ${urgency} item${counts[urgency] === 1 ? '' : 's'}`);
  return parts.join(', ');
}

function attentionTiming(item: AttentionItem, now: number): string {
  if (item.expires_at !== null) {
    return ` (expires in ${formatDuration(item.expires_at - now)})`;
  }
  if (item.ts !== null && Number.isFinite(item.ts)) {
    return ` (${formatDuration(now - item.ts)} old)`;
  }
  return '';
}

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function buildPriorPreface(store: MemoryStore, input: HookInput): string {
  // For resume/clear/compact the agent already has its own context; injecting
  // a "Prior-session context" preface would be noisy and possibly stale.
  if (input.source && input.source !== 'startup') return '';
  const recent = store.storage.listSessions(4);
  const hints = recent
    .filter((s) => s.id !== input.session_id)
    .slice(0, 3)
    .map((s) => {
      const summaries = store.storage.listSummaries(s.id).slice(0, 1);
      return summaries.map((x) => x.content).join('\n');
    })
    .filter(Boolean);
  if (hints.length === 0) return '';
  return `## Prior-session context\n${hints.join('\n---\n')}`;
}

/**
 * Auto-join the task for this (repo_root, branch) and inject any pending
 * handoffs or co-participants. This is the moment the hivemind flips from
 * passive synchronised memory into active collaboration: the new agent
 * starts the turn already knowing who else is on this branch.
 *
 * Exported so integration tests can drive the preface builder directly
 * without spinning up the full runner / transport stack.
 */
export function buildTaskPreface(
  store: MemoryStore,
  input: Pick<HookInput, 'session_id' | 'cwd' | 'ide'>,
): string {
  const cwd = input.cwd;
  if (!cwd) return '';
  const detected = detectRepoBranch(cwd);
  if (!detected) return '';
  const agent = deriveAgent(input.ide, detected.branch);
  const thread = TaskThread.open(store, {
    repo_root: detected.repo_root,
    branch: detected.branch,
    session_id: input.session_id,
  });
  thread.join(input.session_id, agent);

  const pending = thread.pendingHandoffsFor(input.session_id, agent);
  const pendingWakes = thread.pendingWakesFor(input.session_id, agent);
  const unreadMessages = buildAttentionInbox(store, {
    session_id: input.session_id,
    agent,
    task_ids: [thread.task_id],
    repo_root: detected.repo_root,
    include_stalled_lanes: false,
  }).unread_messages;
  const others = thread.participants().filter((p) => p.session_id !== input.session_id);

  const lines: string[] = [];
  if (
    others.length > 0 ||
    pending.length > 0 ||
    pendingWakes.length > 0 ||
    unreadMessages.length > 0
  ) {
    const who =
      others.length > 0
        ? others.map((p) => `${p.agent}@${p.session_id.slice(0, 8)}`).join(', ')
        : 'you only';
    lines.push(
      `## Task thread #${thread.task_id} (${detected.branch})`,
      `Joined with: ${who}. Post coordination via MCP tools task_post / task_claim_file / task_hand_off.`,
    );
  }
  appendMessagePreface(lines, unreadMessages, input.session_id, agent);
  for (const h of pending) {
    const minsLeft = Math.max(0, Math.round((h.meta.expires_at - Date.now()) / 60_000));
    lines.push('');
    lines.push(
      `PENDING HANDOFF #${h.id} from ${h.meta.from_agent} (expires in ${minsLeft}m):`,
      `  summary: ${h.meta.summary}`,
    );
    if (h.meta.next_steps.length) {
      lines.push(`  next: ${h.meta.next_steps.join(' | ')}`);
    }
    if (h.meta.blockers.length) {
      lines.push(`  blockers: ${h.meta.blockers.join(' | ')}`);
    }
    if (h.meta.transferred_files.length) {
      lines.push(`  transferred_files: ${h.meta.transferred_files.join(', ')}`);
    }
    // Response-threshold hint: if this handoff broadcast to 'any' with a
    // candidate ranking, surface the top match and the current agent's
    // own rank so the reader can decide if they're the best fit before
    // accepting. Purely advisory — anyone eligible can still accept.
    if (h.meta.to_agent === 'any' && h.meta.suggested_candidates?.length) {
      const top = h.meta.suggested_candidates[0];
      if (!top) continue;
      const mine = h.meta.suggested_candidates.find((c) => c.agent === agent);
      const hints = [`top match: ${top.agent} (${top.score.toFixed(2)})`];
      if (mine && mine.agent !== top.agent) {
        hints.push(`you (${agent}): ${mine.score.toFixed(2)}`);
      }
      lines.push(`  routing: ${hints.join(' | ')}`);
    }
    // Include session_id in the suggested tool calls — agents drop it
    // otherwise and the accept fails with a generic validation error.
    lines.push(
      `  accept with: task_accept_handoff(handoff_observation_id=${h.id}, session_id="${input.session_id}")`,
    );
    lines.push(
      `  decline with: task_decline_handoff(handoff_observation_id=${h.id}, session_id="${input.session_id}", reason="...")`,
    );
  }
  for (const w of pendingWakes) {
    const minsLeft = Math.max(0, Math.round((w.meta.expires_at - Date.now()) / 60_000));
    lines.push('');
    lines.push(
      `PENDING WAKE #${w.id} from ${w.meta.from_agent} (expires in ${minsLeft}m):`,
      `  reason: ${w.meta.reason}`,
    );
    if (w.meta.next_step) {
      lines.push(`  next: ${w.meta.next_step}`);
    }
    // Mirror the handoff ergonomics — inline the session_id so the ack
    // call validates on first try instead of round-tripping through an
    // "invalid arguments" error.
    lines.push(
      `  ack with: task_ack_wake(wake_observation_id=${w.id}, session_id="${input.session_id}")`,
    );
  }
  return lines.join('\n');
}

export async function buildSuggestionPreface(
  store: MemoryStore,
  input: Pick<HookInput, 'session_id' | 'cwd' | 'ide' | 'prompt' | 'metadata'>,
  deps: SuggestionPrefaceDeps = {},
): Promise<string> {
  const cwd = input.cwd;
  if (!cwd) return '';
  const detected = detectRepoBranch(cwd);
  if (!detected) return '';

  const agent = deriveAgent(input.ide, detected.branch);
  const thread = TaskThread.open(store, {
    repo_root: detected.repo_root,
    branch: detected.branch,
    session_id: input.session_id,
  });
  thread.join(input.session_id, agent);

  const core = await (deps.loadCore ?? loadSuggestionCore)();
  if (!core) return '';

  const embedder = await (deps.resolveEmbedder ?? resolveSuggestionEmbedder)(store);
  if (!embedder) return '';

  let queryEmbedding: Float32Array;
  try {
    queryEmbedding = await embedder.embed(suggestionQuery(input, detected.branch));
  } catch {
    return '';
  }

  const thresholds = core.SUGGESTION_THRESHOLDS;
  let similarTasks: SimilarTask[];
  try {
    similarTasks = core.findSimilarTasks(store, embedder, queryEmbedding, {
      repo_root: detected.repo_root,
      exclude_task_ids: [thread.task_id],
      min_similarity: thresholds.SIMILARITY_FLOOR,
    });
  } catch {
    return '';
  }
  const top = similarTasks[0];
  if (!top) return '';

  let payload: unknown;
  try {
    payload = core.buildSuggestionPayload(store, similarTasks);
  } catch {
    return '';
  }
  if (!isSuggestionPayload(payload)) return '';

  if (
    top.similarity >= thresholds.SIMILARITY_FLOOR &&
    top.similarity <= thresholds.PREFACE_INCLUSION_THRESHOLD
  ) {
    logSuggestionDebrief(store, {
      task_id: thread.task_id,
      session_id: input.session_id,
      query: suggestionQuery(input, detected.branch),
      payload,
      top_similarity: top.similarity,
      thresholds,
    });
    return '';
  }

  const confidentFiles = payload.first_files_likely_claimed
    .filter((f) => f.confidence > thresholds.PREFACE_FILE_CONFIDENCE_THRESHOLD)
    .slice(0, 3);
  if (
    payload.insufficient_data_reason ||
    payload.similar_tasks.length < thresholds.MIN_SIMILAR_TASKS_FOR_SUGGESTION ||
    top.similarity <= thresholds.PREFACE_INCLUSION_THRESHOLD ||
    confidentFiles.length === 0
  ) {
    return '';
  }

  return renderSuggestionPreface(payload, confidentFiles);
}

function isSuggestionPayload(payload: unknown): payload is SuggestionPayload {
  if (!payload || typeof payload !== 'object') return false;
  const maybe = payload as Partial<SuggestionPayload>;
  return (
    Array.isArray(maybe.similar_tasks) &&
    Array.isArray(maybe.first_files_likely_claimed) &&
    Array.isArray(maybe.patterns_to_watch)
  );
}

function renderSuggestionPreface(
  payload: SuggestionPayload,
  confidentFiles: SuggestionFileRanking[],
): string {
  const lines = [
    `Suggested approach (based on ${payload.similar_tasks.length} similar past tasks):`,
  ];
  lines.push(`  - Files agents typically claimed first: ${formatConfidentFiles(confidentFiles)}`);
  if (payload.resolution_hints) {
    lines.push(
      `  - Median similar task completed in ${Math.round(
        payload.resolution_hints.median_elapsed_minutes,
      )}m with ${Math.round(payload.resolution_hints.median_handoff_count)} handoffs`,
    );
  } else {
    lines.push('  - Median similar task completion metrics unavailable');
  }
  const pattern = payload.patterns_to_watch[0];
  if (pattern?.description) {
    lines.push(`  - Watch for: ${pattern.description}`);
  }
  lines.push('  - Run task_suggest_approach for the full pattern report.');
  return lines.join('\n');
}

function formatConfidentFiles(files: SuggestionFileRanking[]): string {
  return files.map((f) => `${f.file_path} (${f.confidence.toFixed(2)})`).join(', ');
}

function logSuggestionDebrief(
  store: MemoryStore,
  p: {
    task_id: number;
    session_id: string;
    query: string;
    payload: SuggestionPayload;
    top_similarity: number;
    thresholds: SuggestionThresholds;
  },
): void {
  const alreadyLogged = store.storage
    .taskObservationsByKind(p.task_id, 'suggestion-debrief', 50)
    .some((o) => o.session_id === p.session_id);
  if (alreadyLogged) return;

  store.addObservation({
    session_id: p.session_id,
    task_id: p.task_id,
    kind: 'suggestion-debrief',
    content: `suggestion withheld from SessionStart preface: top similarity ${p.top_similarity.toFixed(
      3,
    )} below preface threshold ${p.thresholds.PREFACE_INCLUSION_THRESHOLD}`,
    metadata: {
      query: p.query,
      top_similarity: p.top_similarity,
      similarity_floor: p.thresholds.SIMILARITY_FLOOR,
      preface_inclusion_threshold: p.thresholds.PREFACE_INCLUSION_THRESHOLD,
      payload: p.payload,
    },
  });
}

function suggestionQuery(input: Pick<HookInput, 'prompt' | 'metadata'>, branch: string): string {
  const metadata = input.metadata ?? {};
  const candidates = [
    input.prompt,
    metadata.task_description,
    metadata.taskDescription,
    metadata.description,
    metadata.title,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const compact = candidate.replace(/\s+/g, ' ').trim();
    if (compact) return compact;
  }
  return branch;
}

async function resolveSuggestionEmbedder(store: MemoryStore): Promise<Embedder | null> {
  if (cachedSuggestionEmbedder !== undefined) return cachedSuggestionEmbedder;
  try {
    const embeddingPackage = '@colony/embedding' as string;
    const embeddingModule = (await import(embeddingPackage)) as {
      createEmbedder?: (
        settings: MemoryStore['settings'],
        opts?: { log?: (line: string) => void },
      ) => Promise<Embedder | null>;
    };
    if (typeof embeddingModule.createEmbedder !== 'function') {
      cachedSuggestionEmbedder = null;
      return cachedSuggestionEmbedder;
    }
    cachedSuggestionEmbedder = await embeddingModule.createEmbedder(store.settings, {
      log: () => {},
    });
  } catch {
    cachedSuggestionEmbedder = null;
  }
  return cachedSuggestionEmbedder;
}

async function loadSuggestionCore(): Promise<SuggestionCore | null> {
  try {
    const core = (await import('@colony/core')) as Partial<SuggestionCore>;
    if (
      !core.SUGGESTION_THRESHOLDS ||
      typeof core.findSimilarTasks !== 'function' ||
      typeof core.buildSuggestionPayload !== 'function'
    ) {
      return null;
    }
    return {
      SUGGESTION_THRESHOLDS: core.SUGGESTION_THRESHOLDS,
      findSimilarTasks: core.findSimilarTasks,
      buildSuggestionPayload: core.buildSuggestionPayload,
    };
  } catch {
    return null;
  }
}

function appendMessagePreface(
  lines: string[],
  messages: InboxMessage[],
  session_id: string,
  agent: string,
): void {
  const blocking = messages.filter((m) => m.urgency === 'blocking');
  const needsReply = messages.filter((m) => m.urgency === 'needs_reply');
  const fyi = messages.filter((m) => m.urgency === 'fyi');

  for (const m of blocking) {
    appendMessage(lines, m, 'BLOCKING MESSAGE', session_id, agent);
  }
  for (const m of needsReply) {
    appendMessage(lines, m, 'MESSAGE NEEDS REPLY', session_id, agent);
  }
  if (fyi.length > 0) {
    lines.push('');
    lines.push(
      `FYI MESSAGES: ${fyi.length} unread collapsed; expand with: task_messages(session_id="${session_id}", agent="${agent}", task_ids=[${[...new Set(fyi.map((m) => m.task_id))].join(', ')}], unread_only=true)`,
    );
  }
}

function appendMessage(
  lines: string[],
  message: InboxMessage,
  label: string,
  session_id: string,
  agent: string,
): void {
  lines.push('');
  lines.push(`${label} #${message.id} from ${message.from_agent}:`);
  lines.push(`  preview: ${compactPreview(message.preview)}`);
  lines.push(
    `  reply with: task_message(task_id=${message.task_id}, session_id="${session_id}", agent="${agent}", to_agent="any", to_session_id="${message.from_session_id}", reply_to=${message.id}, urgency="fyi", content="...")`,
  );
  lines.push(
    `  mark read: task_message_mark_read(message_observation_id=${message.id}, session_id="${session_id}")`,
  );
}

function compactPreview(preview: string): string {
  return preview.replace(/\s+/g, ' ').trim();
}

/**
 * Surface pending proposals and recently promoted ones for this branch.
 * Agents see this at SessionStart so they know what ideas the colony
 * is considering, which lets them explicitly support (via MCP
 * task_reinforce) or silently ignore. A quiet queue with zero pending
 * is the right UX — the preface stays empty and doesn't waste context.
 */
export function buildProposalPreface(store: MemoryStore, input: Pick<HookInput, 'cwd'>): string {
  const cwd = input.cwd;
  if (!cwd) return '';
  const detected = detectRepoBranch(cwd);
  if (!detected) return '';

  const proposals = new ProposalSystem(store);
  const report = proposals.foragingReport(detected.repo_root, detected.branch);

  if (report.pending.length === 0 && report.promoted.length === 0) return '';

  const lines: string[] = [`## Proposals on ${detected.branch}`];
  if (report.pending.length > 0) {
    lines.push('Pending (support via task_reinforce if you agree):');
    for (const p of report.pending.slice(0, 5)) {
      lines.push(
        `  #${p.id} [${p.strength.toFixed(1)} / ${ProposalSystem.PROMOTION_THRESHOLD}] ${p.summary}`,
      );
    }
    if (report.pending.length > 5) {
      lines.push(`  (${report.pending.length - 5} more — call task_foraging_report to see all)`);
    }
  }
  if (report.promoted.length > 0) {
    lines.push('Recently promoted to tasks:');
    for (const p of report.promoted.slice(0, 3)) {
      lines.push(`  task #${p.task_id}: ${p.summary}`);
    }
  }
  return lines.join('\n');
}

function deriveAgent(ide: string | undefined, branch: string): string {
  if (ide === 'claude-code') return 'claude';
  if (ide === 'codex') return 'codex';
  // Branches under `agent/<name>/...` carry their agent in the path itself,
  // which is more reliable than the IDE hint when one agent drives another.
  const parts = branch.split('/').filter(Boolean);
  if (parts[0] === 'agent' && parts[1]) return parts[1];
  return ide ?? 'agent';
}
