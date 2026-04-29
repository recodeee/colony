import { loadSettings } from '@colony/config';
import {
  type HandoffMetadata,
  type ManagedWorktreeInspection,
  type MemoryStore,
  readWorktreeContentionReport,
} from '@colony/core';
import type { ObservationRow, TaskClaimRow, TaskRow } from '@colony/storage';
import type { Command } from 'commander';
import kleur from 'kleur';
import { withStore } from '../util/store.js';

type ResumeAgent = 'codex' | 'claude' | 'any';

export interface ResumeQuotaPacket {
  handoff_observation_id: number;
  status: 'active';
  task: {
    id: number;
    title: string;
    repo_root: string;
    branch: string;
  };
  previous: {
    agent: string;
    session_id: string;
  };
  handoff: {
    summary: string;
    blockers: string[];
    next_steps: string[];
    to_agent: string;
    expires_at: string;
    created_at: string;
  };
  branch: string;
  worktree: string | null;
  claimed_files: string[];
  claimed_file_owners: Array<{ file_path: string; session_id: string; claimed_at: string }>;
  dirty_files: Array<{ path: string; status: string }>;
  last_working_note: string | null;
  last_verification: string | null;
  next_recommended_mcp_call: string;
  next_recommended_shell_command: string;
}

export interface ResumeQuotaPayload {
  generated_at: string;
  repo_root: string | null;
  agent: ResumeAgent;
  count: number;
  packets: ResumeQuotaPacket[];
  empty: boolean;
  message: string;
}

interface BuildResumeQuotaOptions {
  repoRoot?: string;
  agent: ResumeAgent;
  now?: number;
  inspectWorktrees?: (repoRoot: string) => ManagedWorktreeInspection[];
}

interface Candidate {
  task: TaskRow;
  row: ObservationRow;
  meta: HandoffMetadata;
  priority: number;
}

const AUTO_USAGE_HANDOFF_SUMMARY = 'Session hit usage limit; takeover requested.';
const USAGE_LIMIT_TEXT =
  /\b(usage[-_\s]*limit|rate[-_\s]*limit|quota|token[-_\s]*limit|max(?:imum)?[-_\s]*tokens?)\b/i;
const WORKING_NOTE_KINDS = new Set(['note', 'decision', 'blocker']);
const VERIFICATION_TEXT = /\b(test|tests|typecheck|lint|verify|verification|passed|failed|green)\b/i;

export function registerResumeCommand(program: Command): void {
  const group = program.command('resume').description('Build read-only recovery packets');

  group
    .command('quota')
    .description('Print recovery packets for active quota-exhausted handoffs')
    .requiredOption('--repo-root <path>', 'repo root to prefer in recovery ordering')
    .requiredOption('--agent <agent>', 'replacement agent to route for: codex, claude, or any')
    .option('--json', 'emit stable machine-readable JSON')
    .action(async (opts: { repoRoot: string; agent: string; json?: boolean }) => {
      const agent = parseAgent(opts.agent);
      const settings = loadSettings();
      await withStore(settings, (store) => {
        const payload = buildResumeQuotaPayload(store, {
          repoRoot: opts.repoRoot,
          agent,
        });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
          return;
        }
        process.stdout.write(`${renderResumeQuotaPayload(payload)}\n`);
      });
    });
}

export function buildResumeQuotaPayload(
  store: MemoryStore,
  opts: BuildResumeQuotaOptions,
): ResumeQuotaPayload {
  const now = opts.now ?? Date.now();
  const repoRoot = opts.repoRoot?.trim() || null;
  const candidates = collectQuotaHandoffs(store, opts.agent, now).sort((left, right) => {
    const leftRepo = repoRoot !== null && left.task.repo_root === repoRoot ? 1 : 0;
    const rightRepo = repoRoot !== null && right.task.repo_root === repoRoot ? 1 : 0;
    return rightRepo - leftRepo || right.priority - left.priority || right.row.ts - left.row.ts;
  });

  const worktreeCache = new Map<string, ManagedWorktreeInspection[]>();
  const inspectWorktrees =
    opts.inspectWorktrees ??
    ((root: string) => readWorktreeContentionReport({ repoRoot: root }).worktrees);

  const packets = candidates.map((candidate) => {
    const worktrees = cachedWorktrees(worktreeCache, candidate.task.repo_root, inspectWorktrees);
    return packetFromCandidate(store, candidate, worktrees);
  });

  return {
    generated_at: new Date(now).toISOString(),
    repo_root: repoRoot,
    agent: opts.agent,
    count: packets.length,
    packets,
    empty: packets.length === 0,
    message:
      packets.length === 0
        ? 'No active quota-exhausted handoffs found.'
        : `Found ${packets.length} active quota-exhausted handoff(s).`,
  };
}

export function renderResumeQuotaPayload(payload: ResumeQuotaPayload): string {
  if (payload.empty) {
    return `${kleur.green('No active quota-exhausted handoffs found.')}\n  repo: ${
      payload.repo_root ?? '<any>'
    }\n  next: colony inbox --repo-root ${quote(payload.repo_root ?? process.cwd())}`;
  }

  const lines: string[] = [];
  lines.push(kleur.bold(payload.message));
  for (const packet of payload.packets) {
    lines.push('');
    lines.push(
      kleur.cyan(
        `Task ${packet.task.id}: ${packet.task.title} (${packet.previous.agent}/${packet.previous.session_id})`,
      ),
    );
    lines.push(`  branch: ${packet.branch}`);
    lines.push(`  worktree: ${packet.worktree ?? '<not found>'}`);
    lines.push(
      `  claimed files: ${packet.claimed_files.length ? packet.claimed_files.join(', ') : '<none>'}`,
    );
    lines.push(
      `  dirty files: ${
        packet.dirty_files.length
          ? packet.dirty_files
              .map((file) => `${file.status.trim() || '??'} ${file.path}`)
              .join(', ')
          : '<none>'
      }`,
    );
    lines.push(`  last working note: ${packet.last_working_note ?? '<none>'}`);
    lines.push(`  last verification: ${packet.last_verification ?? '<none>'}`);
    lines.push('  copy/paste:');
    lines.push(`    ${packet.next_recommended_mcp_call}`);
    lines.push(`    ${packet.next_recommended_shell_command}`);
  }
  return lines.join('\n');
}

function parseAgent(input: string): ResumeAgent {
  const agent = input.trim().toLowerCase();
  if (agent === 'codex' || agent === 'claude' || agent === 'any') return agent;
  throw new Error('--agent must be codex, claude, or any');
}

function collectQuotaHandoffs(store: MemoryStore, agent: ResumeAgent, now: number): Candidate[] {
  const out: Candidate[] = [];
  for (const task of store.storage.listTasks(1_000)) {
    for (const row of store.storage.taskObservationsByKind(task.id, 'handoff', 1_000)) {
      const meta = parseHandoff(row);
      if (!meta) continue;
      if (meta.status !== 'pending' || now >= meta.expires_at) continue;
      if (!isAddressedToAgent(meta, agent)) continue;
      if (!isQuotaHandoff(meta)) continue;
      out.push({ task, row, meta, priority: candidatePriority(meta, agent) });
    }
  }
  return out;
}

function packetFromCandidate(
  store: MemoryStore,
  candidate: Candidate,
  worktrees: ManagedWorktreeInspection[],
): ResumeQuotaPacket {
  const { task, row, meta } = candidate;
  const claims = store.storage.listClaims(task.id);
  const worktree = worktrees.find((entry) => entry.branch === task.branch) ?? null;
  const lastWorkingNote = latestExpandedContent(
    store,
    store.storage
      .taskTimeline(task.id, 100)
      .filter((obs) => WORKING_NOTE_KINDS.has(obs.kind) && obs.id !== row.id),
  );
  const lastVerification = latestVerificationContent(store, store.storage.taskTimeline(task.id, 150));
  const agentPlaceholder = meta.to_agent === 'any' ? '<codex|claude>' : meta.to_agent;
  const shellCommand =
    worktree !== null
      ? `cd ${quote(worktree.path)} && git status --short`
      : `cd ${quote(task.repo_root)} && gx branch start ${quote(task.title)} ${quote(agentPlaceholder)}`;

  return {
    handoff_observation_id: row.id,
    status: 'active',
    task: {
      id: task.id,
      title: task.title,
      repo_root: task.repo_root,
      branch: task.branch,
    },
    previous: {
      agent: meta.from_agent,
      session_id: meta.from_session_id,
    },
    handoff: {
      summary: meta.summary,
      blockers: meta.blockers,
      next_steps: meta.next_steps,
      to_agent: meta.to_agent,
      expires_at: new Date(meta.expires_at).toISOString(),
      created_at: new Date(row.ts).toISOString(),
    },
    branch: task.branch,
    worktree: worktree?.path ?? null,
    claimed_files: claims.map((claim) => claim.file_path),
    claimed_file_owners: claims.map(claimOwner),
    dirty_files: worktree?.dirty_files ?? [],
    last_working_note: lastWorkingNote,
    last_verification: lastVerification,
    next_recommended_mcp_call: `task_accept_handoff(handoff_observation_id=${row.id}, session_id="<new-session-id>")`,
    next_recommended_shell_command: shellCommand,
  };
}

function claimOwner(claim: TaskClaimRow): ResumeQuotaPacket['claimed_file_owners'][number] {
  return {
    file_path: claim.file_path,
    session_id: claim.session_id,
    claimed_at: new Date(claim.claimed_at).toISOString(),
  };
}

function cachedWorktrees(
  cache: Map<string, ManagedWorktreeInspection[]>,
  repoRoot: string,
  inspect: (repoRoot: string) => ManagedWorktreeInspection[],
): ManagedWorktreeInspection[] {
  const cached = cache.get(repoRoot);
  if (cached) return cached;
  let worktrees: ManagedWorktreeInspection[] = [];
  try {
    worktrees = inspect(repoRoot);
  } catch {
    worktrees = [];
  }
  cache.set(repoRoot, worktrees);
  return worktrees;
}

function latestExpandedContent(store: MemoryStore, rows: ObservationRow[]): string | null {
  const row = rows.sort((a, b) => b.ts - a.ts)[0];
  if (!row) return null;
  return (
    store.getObservations([row.id], { expand: true })[0]?.content.replace(/\s+/g, ' ').trim() ||
    null
  );
}

function latestVerificationContent(store: MemoryStore, rows: ObservationRow[]): string | null {
  const sorted = rows.sort((a, b) => b.ts - a.ts);
  for (const row of sorted) {
    const content =
      store.getObservations([row.id], { expand: true })[0]?.content.replace(/\s+/g, ' ').trim() ??
      '';
    if (row.kind === 'verification') return content || null;
    if (row.kind === 'tool_use' && VERIFICATION_TEXT.test(content)) return content || null;
  }
  return null;
}

function parseHandoff(row: ObservationRow): HandoffMetadata | null {
  const parsed = parseRecord(row.metadata);
  if (parsed.kind !== 'handoff') return null;
  if (typeof parsed.status !== 'string') return null;
  if (typeof parsed.from_session_id !== 'string') return null;
  if (typeof parsed.from_agent !== 'string') return null;
  if (typeof parsed.summary !== 'string') return null;
  if (typeof parsed.expires_at !== 'number') return null;
  return {
    kind: 'handoff',
    from_session_id: parsed.from_session_id,
    from_agent: parsed.from_agent,
    to_agent: parseTarget(parsed.to_agent),
    to_session_id: typeof parsed.to_session_id === 'string' ? parsed.to_session_id : null,
    summary: parsed.summary,
    next_steps: stringArray(parsed.next_steps),
    blockers: stringArray(parsed.blockers),
    released_files: stringArray(parsed.released_files),
    transferred_files: stringArray(parsed.transferred_files),
    status: parsed.status as HandoffMetadata['status'],
    accepted_by_session_id:
      typeof parsed.accepted_by_session_id === 'string' ? parsed.accepted_by_session_id : null,
    accepted_at: typeof parsed.accepted_at === 'number' ? parsed.accepted_at : null,
    expires_at: parsed.expires_at,
    handoff_ttl_ms:
      typeof parsed.handoff_ttl_ms === 'number'
        ? parsed.handoff_ttl_ms
        : Math.max(0, parsed.expires_at - row.ts),
  };
}

function parseTarget(value: unknown): HandoffMetadata['to_agent'] {
  return value === 'codex' || value === 'claude' || value === 'any' ? value : 'any';
}

function isAddressedToAgent(meta: HandoffMetadata, agent: ResumeAgent): boolean {
  if (agent === 'any') return true;
  return meta.to_agent === 'any' || meta.to_agent === agent;
}

function isQuotaHandoff(meta: HandoffMetadata): boolean {
  if (meta.summary === AUTO_USAGE_HANDOFF_SUMMARY) return true;
  return [meta.summary, ...meta.blockers, ...meta.next_steps].some((text) =>
    USAGE_LIMIT_TEXT.test(text),
  );
}

function candidatePriority(meta: HandoffMetadata, agent: ResumeAgent): number {
  let score = 0;
  if (agent !== 'any' && meta.to_agent === agent) score += 20;
  if (meta.to_agent === 'any') score += 10;
  if (meta.summary === AUTO_USAGE_HANDOFF_SUMMARY) score += 5;
  if (meta.blockers.length > 0) score += 1;
  return score;
}

function parseRecord(input: string | null): Record<string, unknown> {
  if (!input) return {};
  try {
    const parsed = JSON.parse(input) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function quote(value: string): string {
  return JSON.stringify(value);
}
