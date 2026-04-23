import { type MemoryStore, TaskThread, detectRepoBranch } from '@cavemem/core';
import type { HookInput } from '../types.js';

export async function sessionStart(store: MemoryStore, input: HookInput): Promise<string> {
  // Idempotent: Claude Code re-fires SessionStart on resume/clear/compact with
  // the same session_id. We must not blow up on the duplicate.
  store.startSession({
    id: input.session_id,
    ide: input.ide ?? 'unknown',
    cwd: input.cwd ?? null,
  });

  const priorPreface = buildPriorPreface(store, input);
  const taskPreface = buildTaskPreface(store, input);

  return [priorPreface, taskPreface].filter(Boolean).join('\n\n');
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
  const others = thread.participants().filter((p) => p.session_id !== input.session_id);

  const lines: string[] = [];
  if (others.length > 0 || pending.length > 0) {
    const who =
      others.length > 0
        ? others.map((p) => `${p.agent}@${p.session_id.slice(0, 8)}`).join(', ')
        : 'you only';
    lines.push(
      `## Task thread #${thread.task_id} (${detected.branch})`,
      `Joined with: ${who}. Post coordination via MCP tools task_post / task_claim_file / task_hand_off.`,
    );
  }
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
    // Include session_id in the suggested tool calls — agents drop it
    // otherwise and the accept fails with a generic validation error.
    lines.push(
      `  accept with: task_accept_handoff(handoff_observation_id=${h.id}, session_id="${input.session_id}")`,
    );
    lines.push(
      `  decline with: task_decline_handoff(handoff_observation_id=${h.id}, session_id="${input.session_id}", reason="...")`,
    );
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
