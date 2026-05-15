import { resolve } from 'node:path';
import { loadSettings } from '@colony/config';
import { TaskThread, buildCoordinationSweep, inferIdeFromSessionId } from '@colony/core';
import type { Command } from 'commander';
import kleur from 'kleur';
import {
  type ReadyForAgentResult,
  buildReadyForAgent,
} from '../../../mcp-server/src/tools/ready-queue.js';
import { withStore } from '../util/store.js';

type ReadyItem = ReadyForAgentResult['ready'][number];
type QuotaReadyItem = Extract<ReadyItem, { kind: 'quota_relay_ready' }>;
type PlanReadyItem = Exclude<ReadyItem, QuotaReadyItem>;

interface TaskReadyOptions {
  session?: string;
  agent?: string;
  repoRoot?: string;
  limit?: string;
  json?: boolean;
}

interface QuotaClaimOptions {
  taskId?: string;
  session?: string;
  agent?: string;
  repoRoot?: string;
  file?: string;
  handoffObservationId?: string;
  reason?: string;
  allSafe?: boolean;
  json?: boolean;
}

function sessionFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (
    env.CODEX_SESSION_ID?.trim() ||
    env.CLAUDECODE_SESSION_ID?.trim() ||
    env.CLAUDE_SESSION_ID?.trim() ||
    undefined
  );
}

function agentFromSession(sessionId: string): string | undefined {
  const ide = inferIdeFromSessionId(sessionId);
  if (ide === 'claude-code') return 'claude';
  return ide;
}

export function registerTaskCommand(program: Command): void {
  const group = program.command('task').description('Task scheduling helpers');

  group
    .command('ready')
    .description('Pick claimable work through task_ready_for_agent')
    .option(
      '--session <id>',
      'your session_id (defaults to CODEX_SESSION_ID/CLAUDECODE_SESSION_ID)',
    )
    .option('--agent <name>', 'your agent name (e.g. claude, codex)')
    .option('--repo-root <path>', 'repo root (defaults to process.cwd())')
    .option('--limit <n>', 'max ready items to show', '5')
    .option('--json', 'emit the task_ready_for_agent payload as JSON')
    .action(async (opts: TaskReadyOptions) => {
      const session = opts.session?.trim() || sessionFromEnv();
      if (!session) {
        process.stderr.write(
          `${kleur.red('missing session')} - pass --session or set CODEX_SESSION_ID/CLAUDECODE_SESSION_ID\n`,
        );
        process.exitCode = 1;
        return;
      }
      const agent = opts.agent?.trim() || agentFromSession(session);
      if (!agent) {
        process.stderr.write(
          `${kleur.red('missing agent')} - pass --agent or use a session id prefixed with codex@/claude@\n`,
        );
        process.exitCode = 1;
        return;
      }

      const limit = parsePositiveInt(opts.limit, '--limit');
      const repoRoot = resolve(opts.repoRoot ?? process.cwd());
      const settings = loadSettings();
      await withStore(settings, async (store) => {
        const result = await buildReadyForAgent(store, {
          session_id: session,
          agent,
          repo_root: repoRoot,
          limit,
        });
        process.stdout.write(
          `${opts.json === true ? JSON.stringify(result, null, 2) : formatTaskReadyOutput(result)}\n`,
        );
      });
    });

  group
    .command('quota-accept')
    .description('Accept quota-pending claim ownership from a handoff or relay')
    .requiredOption('--task-id <id>', 'task id that owns the quota-pending claim')
    .option(
      '--session <id>',
      'your session_id (defaults to CODEX_SESSION_ID/CLAUDECODE_SESSION_ID)',
    )
    .option('--agent <name>', 'your agent name (e.g. claude, codex)')
    .option('--file <path>', 'specific quota-pending file to accept')
    .option('--handoff-observation-id <id>', 'linked handoff/relay observation id')
    .option('--json', 'emit the result as JSON')
    .action(async (opts: QuotaClaimOptions) => {
      await resolveQuotaClaim(opts, 'accept');
    });

  group
    .command('quota-decline')
    .description('Decline quota-pending claim ownership without hiding it from other agents')
    .requiredOption('--task-id <id>', 'task id that owns the quota-pending claim')
    .option(
      '--session <id>',
      'your session_id (defaults to CODEX_SESSION_ID/CLAUDECODE_SESSION_ID)',
    )
    .option('--file <path>', 'specific quota-pending file to decline')
    .option('--handoff-observation-id <id>', 'linked handoff/relay observation id')
    .option('--reason <text>', 'why this session is not taking the relay')
    .option('--json', 'emit the result as JSON')
    .action(async (opts: QuotaClaimOptions) => {
      await resolveQuotaClaim(opts, 'decline');
    });

  group
    .command('quota-release-expired')
    .description('Release expired quota-pending claims into weak audit-only ownership')
    .option('--task-id <id>', 'task id that owns the quota-pending claim')
    .option(
      '--session <id>',
      'your session_id (defaults to CODEX_SESSION_ID/CLAUDECODE_SESSION_ID)',
    )
    .option('--repo-root <path>', 'repo root for --all-safe batch sweep (defaults to cwd)')
    .option('--file <path>', 'specific expired quota-pending file to release')
    .option('--handoff-observation-id <id>', 'linked handoff/relay observation id')
    .option(
      '--all-safe',
      'release every expired quota-pending claim in the repo via coordination sweep',
    )
    .option('--json', 'emit the result as JSON')
    .action(async (opts: QuotaClaimOptions) => {
      await resolveQuotaClaim(opts, 'release-expired');
    });
}

export function formatTaskReadyOutput(result: ReadyForAgentResult): string {
  const lines = [
    kleur.bold('colony task ready'),
    `next: ${result.next_action}`,
    `ready: ${result.ready.length}/${result.total_available}`,
  ];

  if (result.codex_mcp_call) lines.push(`claim: ${result.codex_mcp_call}`);
  if (result.empty_state) {
    lines.push(`empty: ${result.empty_state}`);
    lines.push('proposal: task_propose -> task_reinforce -> queen_plan_goal/task_plan_publish');
  }

  for (const [index, item] of result.ready.entries()) {
    lines.push('');
    const extra = item as { priority?: number; codex_mcp_call?: string };
    if (isQuotaReady(item)) {
      lines.push(
        kleur.bold(
          `${index + 1}. quota relay task ${item.task_id} priority=${extra.priority ?? index + 1}`,
        ),
      );
      lines.push(`  branch: ${item.branch}`);
      lines.push(`  reason: ${item.next_action_reason}`);
      lines.push(`  next_tool: ${item.next_tool}`);
      lines.push(`  files: ${item.files.length > 0 ? item.files.join(', ') : '-'}`);
      lines.push(
        `  claim: ${extra.codex_mcp_call ?? result.codex_mcp_call ?? 'task_claim_quota_accept(...)'}`,
      );
      lines.push(
        `  cmd: ${quotaAcceptCommand(item.task_id, item.quota_observation_id, '<session_id>', '<agent>')}`,
      );
      continue;
    }

    const planItem = item as PlanReadyItem;
    lines.push(
      kleur.bold(
        `${index + 1}. ${planItem.plan_slug}/sub-${planItem.subtask_index} priority=${extra.priority ?? index + 1}`,
      ),
    );
    lines.push(`  title: ${planItem.title}`);
    lines.push(`  reason: ${planItem.reason}`);
    lines.push(`  fit: ${planItem.fit_score.toFixed(2)}`);
    lines.push(`  next_tool: ${planItem.next_tool ?? 'task_plan_complete_subtask'}`);
    lines.push(`  files: ${planItem.file_scope.length > 0 ? planItem.file_scope.join(', ') : '-'}`);
    lines.push(
      `  claim: ${extra.codex_mcp_call ?? result.codex_mcp_call ?? 'task_plan_claim_subtask(...)'}`,
    );
  }

  return lines.join('\n');
}

async function resolveQuotaClaim(
  opts: QuotaClaimOptions,
  action: 'accept' | 'decline' | 'release-expired',
): Promise<void> {
  if (action === 'release-expired' && opts.allSafe === true) {
    await releaseAllSafeExpiredQuotaClaims(opts);
    return;
  }
  if (opts.taskId === undefined) {
    process.stderr.write(`${kleur.red('missing task')} - pass --task-id or --all-safe\n`);
    process.exitCode = 1;
    return;
  }
  const taskId = parsePositiveInt(opts.taskId, '--task-id');
  const handoffObservationId =
    opts.handoffObservationId === undefined
      ? undefined
      : parsePositiveInt(opts.handoffObservationId, '--handoff-observation-id');
  const session = opts.session?.trim() || sessionFromEnv();
  if (!session) {
    process.stderr.write(
      `${kleur.red('missing session')} - pass --session or set CODEX_SESSION_ID/CLAUDECODE_SESSION_ID\n`,
    );
    process.exitCode = 1;
    return;
  }
  const agent = opts.agent?.trim() || agentFromSession(session);
  if (action === 'accept' && !agent) {
    process.stderr.write(
      `${kleur.red('missing agent')} - pass --agent or use a session id prefixed with codex@/claude@\n`,
    );
    process.exitCode = 1;
    return;
  }

  const settings = loadSettings();
  await withStore(settings, async (store) => {
    if (!store.storage.getTask(taskId)) {
      throw new Error(`task ${taskId} not found`);
    }
    const thread = new TaskThread(store, taskId);
    if (action === 'accept') thread.join(session, agent ?? 'codex');
    const args = {
      task_id: taskId,
      session_id: session,
      agent,
      file_path: opts.file,
      handoff_observation_id: handoffObservationId,
      reason: opts.reason,
    };
    const result =
      action === 'accept'
        ? thread.acceptQuotaClaim(args)
        : action === 'decline'
          ? thread.declineQuotaClaim(args)
          : thread.releaseExpiredQuotaClaims(args);
    process.stdout.write(
      `${opts.json === true ? JSON.stringify(result, null, 2) : formatQuotaClaimResult(result)}\n`,
    );
  });
}

async function releaseAllSafeExpiredQuotaClaims(opts: QuotaClaimOptions): Promise<void> {
  if (
    opts.taskId !== undefined ||
    opts.file !== undefined ||
    opts.handoffObservationId !== undefined ||
    opts.reason !== undefined
  ) {
    process.stderr.write(
      `${kleur.red('invalid options')} - --all-safe cannot be combined with task-specific quota release options\n`,
    );
    process.exitCode = 1;
    return;
  }
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  const settings = loadSettings();
  await withStore(settings, (store) => {
    const result = buildCoordinationSweep(store, {
      repo_root: repoRoot,
      release_expired_quota_claims: true,
    });
    process.stdout.write(
      `${
        opts.json === true
          ? JSON.stringify(formatAllSafeQuotaJson(result), null, 2)
          : formatAllSafeQuotaResult(result)
      }\n`,
    );
  });
}

function formatAllSafeQuotaJson(result: ReturnType<typeof buildCoordinationSweep>): unknown {
  return {
    status: 'released_expired',
    mode: 'all_safe',
    summary: {
      released_expired_quota_pending_claim_count:
        result.summary.released_expired_quota_pending_claim_count,
      quota_pending_claims: result.summary.quota_pending_claims,
      skipped_active_claims: result.summary.skipped_active_claims,
      skipped_dirty_claims: result.summary.skipped_dirty_claims,
    },
    released_claims: result.released_expired_quota_pending_claims,
  };
}

function formatAllSafeQuotaResult(result: ReturnType<typeof buildCoordinationSweep>): string {
  const released = result.released_expired_quota_pending_claims.length;
  const files = result.released_expired_quota_pending_claims
    .map((claim) => claim.file_path)
    .join(', ');
  const suffix = files.length > 0 ? ` files=${files}` : '';
  return `quota released_expired mode=all_safe released=${released} quota_pending=${result.summary.quota_pending_claims}${suffix}`;
}

function formatQuotaClaimResult(result: unknown): string {
  if (!isRecord(result)) return String(result);
  const status = String(result.status ?? 'ok');
  const taskId = result.task_id === undefined ? '' : ` task=${result.task_id}`;
  const handoff =
    result.handoff_observation_id === undefined ? '' : ` handoff=${result.handoff_observation_id}`;
  const accepted = Array.isArray(result.accepted_files)
    ? ` files=${result.accepted_files.join(', ')}`
    : '';
  const declined = Array.isArray(result.declined_files)
    ? ` files=${result.declined_files.join(', ')}`
    : '';
  const released = Array.isArray(result.released_claims)
    ? ` files=${result.released_claims
        .map((claim) => (isRecord(claim) ? String(claim.file_path) : String(claim)))
        .join(', ')}`
    : '';
  return `quota ${status}${taskId}${handoff}${accepted}${declined}${released}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function quotaAcceptCommand(
  taskId: number,
  handoffObservationId: number,
  session: string,
  agent: string,
): string {
  return `colony task quota-accept --task-id ${taskId} --handoff-observation-id ${handoffObservationId} --session ${session} --agent ${agent}`;
}

function isQuotaReady(item: ReadyItem): item is QuotaReadyItem {
  return 'kind' in item && item.kind === 'quota_relay_ready';
}

function parsePositiveInt(value: string | undefined, label: string): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error(`${label} must be a positive integer`);
  return parsed;
}
