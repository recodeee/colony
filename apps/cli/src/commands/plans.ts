import { resolve } from 'node:path';
import { loadSettings } from '@colony/config';
import { type MemoryStore, type PlanInfo, type SubtaskInfo, listPlans } from '@colony/core';
import type { Command } from 'commander';
import kleur from 'kleur';
import { withStore } from '../util/store.js';
import { type ColonyHealthPayload, buildColonyHealthPayload } from './health.js';

const DEFAULT_HOURS = 24;
const DEFAULT_MAX_AGENTS = 4;

export type PlanWorkPolicy = 'finish-plans';
export type PlanWorkRole =
  | 'claim-contention-janitor'
  | 'plan-finish-tail'
  | 'plan-verifier'
  | 'plan-blocker-rescue'
  | 'plan-implementer';

export interface PlanWorkLaunchPacket {
  role: PlanWorkRole;
  plan_slug: string | null;
  subtask_index: number | null;
  task_title: string;
  file_scope: string[];
  suggested_agent: string;
  startup_loop: string[];
  spawn_command: string;
  reason: string;
  priority: number;
}

export interface PlanWorkBatch {
  policy: PlanWorkPolicy;
  dry_run: true;
  repo_root: string;
  max_agents: number;
  generated_at: string;
  health_gate: {
    status: 'clear' | 'blocked';
    live_contentions: number;
    dirty_contended_files: number;
  };
  packets: PlanWorkLaunchPacket[];
}

interface PlanWorkOptions {
  repoRoot: string;
  policy: PlanWorkPolicy;
  dryRun: true;
  maxAgents: number;
  health: ColonyHealthPayload;
}

interface PlansWorkCliOptions {
  repoRoot?: string;
  policy?: string;
  dryRun?: boolean;
  maxAgents?: string;
  hours?: string;
  json?: boolean;
}

export function registerPlansCommand(program: Command): void {
  const group = program
    .command('plans')
    .description('Prepare safe launch packets for published Colony plans');

  group
    .command('work')
    .description('Dry-run plan-worker launch packets without spawning agents')
    .requiredOption('--policy <name>', 'work policy; currently finish-plans')
    .requiredOption('--dry-run', 'only print packets; do not mutate state or spawn agents')
    .option('--max-agents <n>', 'maximum launch packets to emit', String(DEFAULT_MAX_AGENTS))
    .option('--hours <n>', 'health window size in hours', String(DEFAULT_HOURS))
    .option('--repo-root <path>', 'repo root (defaults to process.cwd())')
    .option('--json', 'emit structured JSON')
    .action(async (opts: PlansWorkCliOptions) => {
      const policy = parsePolicy(opts.policy);
      if (opts.dryRun !== true) {
        throw new Error('plans work is currently safe dry-run only; pass --dry-run');
      }
      const repoRoot = resolve(opts.repoRoot ?? process.cwd());
      const maxAgents = parsePositiveInt(opts.maxAgents, '--max-agents');
      const hours = parsePositiveInt(opts.hours, '--hours');
      const settings = loadSettings();

      await withStore(
        settings,
        (store) => {
          const health = buildColonyHealthPayload(store.storage, {
            since: Date.now() - hours * 3_600_000,
            window_hours: hours,
            claim_stale_minutes: settings.claimStaleMinutes,
            repo_root: repoRoot,
          });
          const batch = buildPlanWorkBatch(store, {
            repoRoot,
            policy,
            dryRun: true,
            maxAgents,
            health,
          });
          process.stdout.write(
            `${opts.json === true ? JSON.stringify(batch, null, 2) : formatPlanWorkBatch(batch)}\n`,
          );
        },
        { readonly: true },
      );
    });
}

export function buildPlanWorkBatch(store: MemoryStore, options: PlanWorkOptions): PlanWorkBatch {
  const healthGate = {
    status: unsafeHealth(options.health) ? ('blocked' as const) : ('clear' as const),
    live_contentions: options.health.live_contention_health.live_file_contentions,
    dirty_contended_files: options.health.live_contention_health.dirty_contended_files,
  };
  const packets =
    healthGate.status === 'blocked'
      ? [janitorPacket(options)]
      : rankedPlanPackets(store, options).slice(0, options.maxAgents);

  return {
    policy: options.policy,
    dry_run: true,
    repo_root: options.repoRoot,
    max_agents: options.maxAgents,
    generated_at: options.health.generated_at,
    health_gate: healthGate,
    packets,
  };
}

export function formatPlanWorkBatch(batch: PlanWorkBatch): string {
  const lines = [
    kleur.bold('colony plans work'),
    `policy: ${batch.policy}`,
    'mode: dry-run (no state mutations; no agents spawned)',
    `repo_root: ${batch.repo_root}`,
    `health_gate: ${batch.health_gate.status}`,
    `health: live_contentions=${batch.health_gate.live_contentions}, dirty_contended_files=${batch.health_gate.dirty_contended_files}`,
    `packets: ${batch.packets.length}/${batch.max_agents}`,
  ];

  for (const [index, packet] of batch.packets.entries()) {
    lines.push(
      '',
      kleur.bold(`packet ${index + 1}: ${packet.role}`),
      `  plan_slug: ${packet.plan_slug ?? '-'}`,
      `  subtask_index: ${packet.subtask_index ?? '-'}`,
      `  task_title: ${packet.task_title}`,
      `  suggested_agent: ${packet.suggested_agent}`,
      `  reason: ${packet.reason}`,
      `  file_scope: ${packet.file_scope.length > 0 ? packet.file_scope.join(', ') : '-'}`,
      '  startup_loop:',
      ...packet.startup_loop.map((step) => `    - ${step}`),
      `  spawn_command: ${packet.spawn_command}`,
    );
  }

  return lines.join('\n');
}

function rankedPlanPackets(store: MemoryStore, options: PlanWorkOptions): PlanWorkLaunchPacket[] {
  const plans = listPlans(store, { repo_root: options.repoRoot, limit: 200 });
  const availablePackets = plans.flatMap((plan) =>
    plan.next_available.map((subtask) => subtaskPacket(plan, subtask, options)),
  );
  const rescue = rescuePacket(options);
  const packets = rescue ? [...availablePackets, rescue] : availablePackets;
  return packets.sort(
    (left, right) =>
      left.priority - right.priority ||
      String(left.plan_slug).localeCompare(String(right.plan_slug)) ||
      (left.subtask_index ?? Number.MAX_SAFE_INTEGER) -
        (right.subtask_index ?? Number.MAX_SAFE_INTEGER),
  );
}

function unsafeHealth(health: ColonyHealthPayload): boolean {
  return (
    health.live_contention_health.live_file_contentions > 0 ||
    health.live_contention_health.dirty_contended_files > 0
  );
}

function janitorPacket(options: PlanWorkOptions): PlanWorkLaunchPacket {
  const health = options.health.live_contention_health;
  const fileScope = health.top_conflicts.map((conflict) => conflict.file_path);
  const title = 'Resolve live Colony claim/contention gate';
  return packet({
    role: 'claim-contention-janitor',
    planSlug: null,
    subtaskIndex: null,
    title,
    fileScope,
    suggestedAgent: 'codex',
    reason: `health gate blocked: live_contentions=${health.live_file_contentions}, dirty_contended_files=${health.dirty_contended_files}`,
    priority: 0,
    repoRoot: options.repoRoot,
  });
}

function rescuePacket(options: PlanWorkOptions): PlanWorkLaunchPacket | null {
  const recommendation = options.health.queen_wave_health.replacement_recommendation;
  if (!recommendation) return null;
  const args = recommendation.claim_args as {
    plan_slug?: string;
    subtask_index?: number;
    file_scope?: string[];
  };
  if (typeof args.plan_slug !== 'string' || typeof args.subtask_index !== 'number') return null;
  return packet({
    role: 'plan-blocker-rescue',
    planSlug: args.plan_slug,
    subtaskIndex: args.subtask_index,
    title: `Rescue blocked subtask ${args.plan_slug}/sub-${args.subtask_index}`,
    fileScope: Array.isArray(args.file_scope) ? args.file_scope : [],
    suggestedAgent: recommendation.recommended_replacement_agent,
    reason: recommendation.reason,
    priority: 3,
    repoRoot: options.repoRoot,
  });
}

function subtaskPacket(
  plan: PlanInfo,
  subtask: SubtaskInfo,
  options: PlanWorkOptions,
): PlanWorkLaunchPacket {
  const role = classifySubtaskRole(subtask);
  return packet({
    role,
    planSlug: plan.plan_slug,
    subtaskIndex: subtask.subtask_index,
    title: subtask.title,
    fileScope: subtask.file_scope,
    suggestedAgent: suggestedAgent(role, subtask),
    reason: roleReason(role),
    priority: rolePriority(role),
    repoRoot: options.repoRoot,
  });
}

function classifySubtaskRole(subtask: SubtaskInfo): PlanWorkRole {
  const haystack =
    `${subtask.title} ${subtask.description} ${subtask.file_scope.join(' ')}`.toLowerCase();
  if (/\b(pr|merge|merged|cleanup|closeout|finish|final|archive|release)\b/.test(haystack)) {
    return 'plan-finish-tail';
  }
  if (/\b(verify|verification|test|tests|typecheck|lint|qa|smoke)\b/.test(haystack)) {
    return 'plan-verifier';
  }
  if (/\b(blocker|blocked|stale|rescue|handoff|takeover)\b/.test(haystack)) {
    return 'plan-blocker-rescue';
  }
  return 'plan-implementer';
}

function rolePriority(role: PlanWorkRole): number {
  if (role === 'claim-contention-janitor') return 0;
  if (role === 'plan-finish-tail') return 1;
  if (role === 'plan-verifier') return 2;
  if (role === 'plan-blocker-rescue') return 3;
  return 4;
}

function roleReason(role: PlanWorkRole): string {
  if (role === 'plan-finish-tail') return 'PR/merge/cleanup tail ranks first';
  if (role === 'plan-verifier') return 'verification task ranks second';
  if (role === 'plan-blocker-rescue') return 'stale/blocker rescue ranks third';
  return 'implementation task ranks last';
}

function suggestedAgent(role: PlanWorkRole, subtask: SubtaskInfo): string {
  if (role === 'plan-verifier') return 'verifier';
  if (role === 'plan-finish-tail') return 'codex';
  if (role === 'plan-blocker-rescue') return 'codex';
  if (subtask.capability_hint === 'test_work') return 'test-engineer';
  if (subtask.capability_hint === 'doc_work') return 'writer';
  return 'executor';
}

function packet(input: {
  role: PlanWorkRole;
  planSlug: string | null;
  subtaskIndex: number | null;
  title: string;
  fileScope: string[];
  suggestedAgent: string;
  reason: string;
  priority: number;
  repoRoot: string;
}): PlanWorkLaunchPacket {
  return {
    role: input.role,
    plan_slug: input.planSlug,
    subtask_index: input.subtaskIndex,
    task_title: input.title,
    file_scope: input.fileScope,
    suggested_agent: input.suggestedAgent,
    startup_loop: startupLoop(input),
    spawn_command: spawnCommand(input),
    reason: input.reason,
    priority: input.priority,
  };
}

function startupLoop(input: {
  planSlug: string | null;
  subtaskIndex: number | null;
  repoRoot: string;
}): string[] {
  const taskScope =
    input.planSlug === null || input.subtaskIndex === null
      ? 'task_ids: []'
      : `plan_slug: "${input.planSlug}", subtask_index: ${input.subtaskIndex}`;
  return [
    `mcp__colony__hivemind_context({ agent: "<agent>", session_id: "<session_id>", repo_root: ${JSON.stringify(input.repoRoot)}, query: "finish-plans", mode: "overview" })`,
    `mcp__colony__attention_inbox({ agent: "<agent>", session_id: "<session_id>", repo_root: ${JSON.stringify(input.repoRoot)} })`,
    `mcp__colony__task_ready_for_agent({ agent: "<agent>", session_id: "<session_id>", repo_root: ${JSON.stringify(input.repoRoot)} })`,
    `mcp__colony__search({ query: "finish-plans ${taskScope}", limit: 5 }) only if prior decisions, earlier lanes, file history, or error context matter`,
  ];
}

function spawnCommand(input: {
  role: PlanWorkRole;
  planSlug: string | null;
  subtaskIndex: number | null;
  title: string;
  fileScope: string[];
  suggestedAgent: string;
  repoRoot: string;
}): string {
  const args = [
    'colony',
    'agents',
    'spawn',
    '--executor',
    'gx',
    '--agent',
    input.suggestedAgent,
    '--role',
    input.role,
    '--repo-root',
    input.repoRoot,
  ];
  if (input.planSlug !== null) args.push('--plan-slug', input.planSlug);
  if (input.subtaskIndex !== null) args.push('--subtask-index', String(input.subtaskIndex));
  args.push('--task-title', input.title);
  for (const file of input.fileScope) args.push('--file-scope', file);
  return args.map(shellQuote).join(' ');
}

function parsePolicy(value: string | undefined): PlanWorkPolicy {
  if (value === 'finish-plans') return value;
  throw new Error(`unsupported plans work policy: ${value ?? '(missing)'}`);
}

function parsePositiveInt(value: string | undefined, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`);
  return n;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
