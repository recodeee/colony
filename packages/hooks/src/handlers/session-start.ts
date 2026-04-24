import {
  type InboxMessage,
  type MemoryStore,
  ProposalSystem,
  TaskThread,
  buildAttentionInbox,
  detectRepoBranch,
} from '@colony/core';
import { spawnNodeScript } from '@colony/process';
import type { HookInput } from '../types.js';

export async function sessionStart(store: MemoryStore, input: HookInput): Promise<string> {
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
  const proposalPreface = buildProposalPreface(store, input);
  const foragingPreface = buildForagingPreface(store, input);

  return [priorPreface, taskPreface, proposalPreface, foragingPreface].filter(Boolean).join('\n\n');
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
