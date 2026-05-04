import * as childProcess from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type MemoryStore,
  type PlanInfo,
  type SubtaskInfo,
  TaskThread,
  areDepsMet,
  guardedClaimFile,
  listPlans,
} from '@colony/core';

export type GitGuardexAgent = 'codex' | 'claude';

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error & { code?: string };
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: childProcess.SpawnSyncOptionsWithStringEncoding,
) => CommandResult;

let commandRunnerOverride: CommandRunner | null = null;

export function setGitGuardexCommandRunnerForTests(runner: CommandRunner | null): void {
  commandRunnerOverride = runner;
}

export interface GitGuardexAvailability {
  available: boolean;
  command: string;
  version?: string;
  reason?: string;
}

export interface GitGuardexSpawnOptions {
  repoRoot: string;
  planSlug?: string;
  subtaskIndex?: number;
  agent: GitGuardexAgent;
  sessionId: string;
  command?: string;
  base?: string;
  verificationCommand?: string;
}

export interface GitGuardexSpawnTarget {
  plan: PlanInfo;
  subtask: SubtaskInfo;
}

export interface PlanAwareSiblingAgent {
  subtask_index: number;
  title: string;
  status: SubtaskInfo['status'];
  wave: string;
  files: string[];
  agent: string | null;
  session_id: string | null;
}

export interface PlanAwareLaunchPacket {
  colony_metadata: {
    plan: string | null;
    subtask: number | null;
    task_id: number | null;
    session_id: string;
  };
  plan: {
    slug: string;
    title: string;
    goal: string;
  } | null;
  wave: {
    index: number;
    name: string;
  } | null;
  subtask: {
    index: number;
    title: string;
    description: string;
    task_id: number;
  } | null;
  claimed_files: string[];
  sibling_agents: PlanAwareSiblingAgent[];
  sibling_files: string[];
  do_not_touch: string[];
  startup_loop: string[];
  collaboration_contract: string[];
  verification_command: string;
  handoff_instructions: string[];
  agent_prompt: string;
}

export interface GitGuardexSpawnPlan {
  availability: GitGuardexAvailability;
  command: string;
  args: string[];
  commandLine: string;
  target: GitGuardexSpawnTarget | null;
  launchPacket: PlanAwareLaunchPacket;
}

export class GitGuardexExecutorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'GitGuardexExecutorError';
    this.code = code;
  }
}

export function defaultCommandRunner(
  command: string,
  args: string[],
  options: childProcess.SpawnSyncOptionsWithStringEncoding,
): CommandResult {
  if (commandRunnerOverride !== null) {
    return commandRunnerOverride(command, args, options);
  }
  const result = childProcess.spawnSync(command, args, {
    ...options,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    ...(result.error !== undefined ? { error: result.error as Error & { code?: string } } : {}),
  };
}

export function detectGitGuardexAvailability(
  command = 'gx',
  runner: CommandRunner = defaultCommandRunner,
): GitGuardexAvailability {
  const version = runner(command, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (version.error?.code === 'ENOENT') {
    return {
      available: false,
      command,
      reason: `${command} not found on PATH`,
    };
  }
  if (version.error !== undefined) {
    return {
      available: false,
      command,
      reason: version.error.message,
    };
  }

  const versionText = version.status === 0 ? version.stdout.trim() : '';
  return {
    available: true,
    command,
    ...(versionText ? { version: versionText } : {}),
  };
}

export function buildGitGuardexSpawnPlan(
  store: MemoryStore,
  opts: GitGuardexSpawnOptions,
  runner: CommandRunner = defaultCommandRunner,
): GitGuardexSpawnPlan {
  const command = opts.command ?? 'gx';
  const availability = detectGitGuardexAvailability(command, runner);
  if (!availability.available) {
    throw new GitGuardexExecutorError(
      'GX_UNAVAILABLE',
      `GitGuardex executor unavailable: ${availability.reason ?? 'gx unavailable'}`,
    );
  }

  const target = resolveSpawnTarget(store, opts);
  const launchPacket = buildPlanAwareLaunchPacket(store, target, opts);
  const args = buildGitGuardexArgs(launchPacket, target, opts);
  return {
    availability,
    command,
    args,
    commandLine: formatCommand(command, args),
    target,
    launchPacket,
  };
}

export function claimGitGuardexSpawnTarget(
  store: MemoryStore,
  plan: GitGuardexSpawnPlan,
  opts: GitGuardexSpawnOptions,
): void {
  const target = plan.target;
  if (target === null) return;
  store.storage.transaction(() => {
    const fresh = resolveExplicitSpawnTarget(store, {
      ...opts,
      planSlug: target.plan.plan_slug,
      subtaskIndex: target.subtask.subtask_index,
    });
    assertSpawnable(fresh.plan, fresh.subtask, opts.sessionId);

    store.addObservation({
      session_id: opts.sessionId,
      task_id: fresh.subtask.task_id,
      kind: 'plan-subtask-claim',
      content: `${opts.agent} claimed sub-task ${fresh.subtask.subtask_index} of plan ${fresh.plan.plan_slug} for gx spawn`,
      metadata: {
        status: 'claimed',
        session_id: opts.sessionId,
        agent: opts.agent,
        plan_slug: fresh.plan.plan_slug,
        subtask_index: fresh.subtask.subtask_index,
        executor: 'gx',
      },
    });

    const thread = new TaskThread(store, fresh.subtask.task_id);
    thread.join(opts.sessionId, opts.agent);
    for (const file of fresh.subtask.file_scope) {
      const guarded = guardedClaimFile(store, {
        task_id: fresh.subtask.task_id,
        file_path: file,
        session_id: opts.sessionId,
        agent: opts.agent,
      });
      if (guarded.status === 'takeover_recommended') {
        throw new GitGuardexExecutorError(
          'CLAIM_TAKEOVER_RECOMMENDED',
          guarded.recommendation ?? 'release or take over inactive claim before claiming',
        );
      }
      if (guarded.status === 'blocked_active_owner') {
        throw new GitGuardexExecutorError(
          'CLAIM_HELD_BY_ACTIVE_OWNER',
          guarded.recommendation ?? 'request handoff or explicit takeover before claiming',
        );
      }
    }
  });
}

export function runGitGuardexSpawn(
  plan: GitGuardexSpawnPlan,
  opts: { cwd: string; runner?: CommandRunner },
): CommandResult {
  return (opts.runner ?? defaultCommandRunner)(plan.command, plan.args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function resolveSpawnTarget(
  store: MemoryStore,
  opts: GitGuardexSpawnOptions,
): GitGuardexSpawnTarget | null {
  if (opts.planSlug !== undefined || opts.subtaskIndex !== undefined) {
    if (opts.planSlug === undefined || opts.subtaskIndex === undefined) {
      throw new GitGuardexExecutorError(
        'PLAN_SUBTASK_REQUIRED',
        '--plan and --subtask must be provided together',
      );
    }
    return resolveExplicitSpawnTarget(store, {
      ...opts,
      planSlug: opts.planSlug,
      subtaskIndex: opts.subtaskIndex,
    });
  }

  const plans = listPlans(store, { repo_root: opts.repoRoot, limit: 2000 });
  const [target] = plans
    .flatMap((plan) => plan.next_available.map((subtask) => ({ plan, subtask })))
    .sort(compareTargets);
  return target ?? null;
}

function resolveExplicitSpawnTarget(
  store: MemoryStore,
  opts: GitGuardexSpawnOptions & { planSlug: string; subtaskIndex: number },
): GitGuardexSpawnTarget {
  const plan = listPlans(store, { repo_root: opts.repoRoot, limit: 2000 }).find(
    (candidate) => candidate.plan_slug === opts.planSlug,
  );
  if (!plan) {
    throw new GitGuardexExecutorError('PLAN_NOT_FOUND', `queen plan not found: ${opts.planSlug}`);
  }
  const subtask = plan.subtasks.find((candidate) => candidate.subtask_index === opts.subtaskIndex);
  if (!subtask) {
    throw new GitGuardexExecutorError(
      'PLAN_SUBTASK_NOT_FOUND',
      `queen subtask not found: ${opts.planSlug}/sub-${opts.subtaskIndex}`,
    );
  }
  assertSpawnable(plan, subtask, opts.sessionId);
  return { plan, subtask };
}

function assertSpawnable(plan: PlanInfo, subtask: SubtaskInfo, sessionId: string): void {
  if (subtask.status === 'claimed') {
    const owner = subtask.claimed_by_session_id ?? 'unknown owner';
    const suffix =
      owner === sessionId
        ? ' by this session; duplicate spawn refused'
        : ` by active owner ${owner}`;
    throw new GitGuardexExecutorError(
      'PLAN_SUBTASK_ALREADY_CLAIMED',
      `${plan.plan_slug}/sub-${subtask.subtask_index} already claimed${suffix}`,
    );
  }
  if (subtask.status !== 'available') {
    throw new GitGuardexExecutorError(
      'PLAN_SUBTASK_NOT_AVAILABLE',
      `${plan.plan_slug}/sub-${subtask.subtask_index} is ${subtask.status}`,
    );
  }
  if (!areDepsMet(subtask, plan.subtasks)) {
    throw new GitGuardexExecutorError(
      'PLAN_SUBTASK_DEPS_UNMET',
      `${plan.plan_slug}/sub-${subtask.subtask_index} dependencies are not complete`,
    );
  }
}

function buildGitGuardexArgs(
  launchPacket: PlanAwareLaunchPacket,
  target: GitGuardexSpawnTarget | null,
  opts: GitGuardexSpawnOptions,
): string[] {
  const args = [
    'agents',
    'start',
    launchPacket.agent_prompt,
    '--agent',
    opts.agent,
    '--target',
    opts.repoRoot,
  ];
  if (opts.base !== undefined) args.push('--base', opts.base);
  for (const file of target?.subtask.file_scope ?? []) {
    args.push('--claim', file);
  }
  return args;
}

export function buildPlanAwareLaunchPacket(
  store: MemoryStore,
  target: GitGuardexSpawnTarget | null,
  opts: GitGuardexSpawnOptions,
): PlanAwareLaunchPacket {
  const plan = target?.plan ?? null;
  const subtask = target?.subtask ?? null;
  const siblingAgents = plan === null || subtask === null ? [] : buildSiblingAgents(plan, subtask);
  const claimedFiles = subtask?.file_scope ?? [];
  const siblingFiles = unique(
    siblingAgents
      .flatMap((sibling) => sibling.files)
      .filter((file) => !claimedFiles.includes(file)),
  );
  const verificationCommand =
    opts.verificationCommand ?? 'pnpm --filter @imdeadpool/colony-cli test';
  const packetWithoutPrompt: Omit<PlanAwareLaunchPacket, 'agent_prompt'> = {
    colony_metadata: {
      plan: plan?.plan_slug ?? null,
      subtask: subtask?.subtask_index ?? null,
      task_id: subtask?.task_id ?? null,
      session_id: opts.sessionId,
    },
    plan:
      plan === null
        ? null
        : {
            slug: plan.plan_slug,
            title: plan.title,
            goal: readPlanGoal(store, plan),
          },
    wave:
      subtask === null
        ? null
        : {
            index: subtask.wave_index,
            name: subtask.wave_name,
          },
    subtask:
      subtask === null
        ? null
        : {
            index: subtask.subtask_index,
            title: subtask.title,
            description: subtask.description,
            task_id: subtask.task_id,
          },
    claimed_files: claimedFiles,
    sibling_agents: siblingAgents,
    sibling_files: siblingFiles,
    do_not_touch: siblingFiles,
    startup_loop: [
      'Call mcp__colony__hivemind_context for this repo and session.',
      'Call mcp__colony__attention_inbox before choosing work.',
      'Confirm the assigned Queen plan, wave, subtask, and claimed files.',
      'Write task_note_working with branch, task, blocker, next, and evidence.',
    ],
    collaboration_contract: [
      'You are one parallel worker in this Queen plan',
      'Do not modify sibling files',
      'Coordinate through task_note_working/task_message',
      'Stop and hand off if quota or conflict',
    ],
    verification_command: verificationCommand,
    handoff_instructions: [
      'Use task_note_working after meaningful progress.',
      'Use task_message for directed coordination with sibling agents.',
      'If quota, conflict, or active-owner contention blocks you, stop and create a task_hand_off or task_relay.',
      'Include branch, task, claimed files, dirty files, last verification, and next step in the handoff.',
    ],
  };
  return {
    ...packetWithoutPrompt,
    agent_prompt: formatPlanAwarePrompt(packetWithoutPrompt),
  };
}

function buildSiblingAgents(plan: PlanInfo, subtask: SubtaskInfo): PlanAwareSiblingAgent[] {
  return plan.subtasks
    .filter((candidate) => candidate.subtask_index !== subtask.subtask_index)
    .map((candidate) => ({
      subtask_index: candidate.subtask_index,
      title: candidate.title,
      status: candidate.status,
      wave: candidate.wave_name,
      files: candidate.file_scope,
      agent: candidate.claimed_by_agent,
      session_id: candidate.claimed_by_session_id,
    }));
}

function formatPlanAwarePrompt(packet: Omit<PlanAwareLaunchPacket, 'agent_prompt'>): string {
  const lines = ['# Colony Plan-Aware Launch Packet', ''];
  lines.push(
    'Colony metadata:',
    `- colony.plan: ${packet.colony_metadata.plan ?? '<none>'}`,
    `- colony.subtask: ${packet.colony_metadata.subtask ?? '<none>'}`,
    `- colony.task_id: ${packet.colony_metadata.task_id ?? '<none>'}`,
    `- colony.session_id: ${packet.colony_metadata.session_id}`,
    '',
  );
  if (packet.plan === null || packet.subtask === null || packet.wave === null) {
    lines.push('Plan: <none>', 'Mode: normal Colony launch packet', '');
  } else {
    lines.push(
      'You are one parallel worker in this Queen plan',
      '',
      `Plan slug: ${packet.plan.slug}`,
      `Plan title: ${packet.plan.title}`,
      `Plan goal: ${packet.plan.goal}`,
      `Wave: ${packet.wave.name} (${packet.wave.index})`,
      `Subtask: ${packet.subtask.index} - ${packet.subtask.title}`,
      `Task id: ${packet.subtask.task_id}`,
      `Description: ${singleLine(packet.subtask.description)}`,
      '',
    );
  }
  lines.push(
    'Claimed files:',
    ...formatList(packet.claimed_files),
    '',
    'Sibling agents:',
    ...formatSiblingAgents(packet.sibling_agents),
    '',
    'Sibling files:',
    ...formatList(packet.sibling_files),
    '',
    'Do-not-touch list:',
    ...formatList(packet.do_not_touch),
    '',
    'Startup loop:',
    ...formatNumberedList(packet.startup_loop),
    '',
    'Collaboration contract:',
    ...formatList(packet.collaboration_contract),
    '',
    `Verification command: ${packet.verification_command}`,
    '',
    'Handoff instructions:',
    ...formatNumberedList(packet.handoff_instructions),
  );
  return lines.join('\n');
}

function formatList(values: string[]): string[] {
  return values.length === 0 ? ['- <none>'] : values.map((value) => `- ${value}`);
}

function formatNumberedList(values: string[]): string[] {
  return values.map((value, index) => `${index + 1}. ${value}`);
}

function formatSiblingAgents(siblings: PlanAwareSiblingAgent[]): string[] {
  if (siblings.length === 0) return ['- <none>'];
  return siblings.map((sibling) => {
    const owner =
      sibling.agent === null && sibling.session_id === null
        ? 'unclaimed'
        : `${sibling.agent ?? 'unknown'}@${sibling.session_id ?? 'unknown'}`;
    return `- sub-${sibling.subtask_index} ${sibling.title} [${sibling.status}, ${sibling.wave}, ${owner}] files=${sibling.files.join(', ') || '<none>'}`;
  });
}

function readPlanGoal(store: MemoryStore, plan: PlanInfo): string {
  const changePath = join(plan.repo_root, 'openspec', 'changes', plan.plan_slug, 'CHANGE.md');
  if (existsSync(changePath)) {
    const fromFile = extractProblem(readFileSync(changePath, 'utf8'));
    if (fromFile !== null) return fromFile;
  }
  const rows = store.storage.taskTimeline(plan.spec_task_id, 100);
  const proposal = rows.find((row) => row.kind === 'spec-delta')?.content;
  const fromTimeline = proposal ? extractProblem(proposal) : null;
  return fromTimeline ?? plan.title;
}

function extractProblem(markdown: string): string | null {
  const match = markdown.match(/## Problem\s+([\s\S]*?)(?:\n## |\n# |$)/);
  const problem = match?.[1]?.trim();
  return problem ? singleLine(problem) : null;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function compareTargets(left: GitGuardexSpawnTarget, right: GitGuardexSpawnTarget): number {
  return (
    left.plan.created_at - right.plan.created_at ||
    left.plan.plan_slug.localeCompare(right.plan.plan_slug) ||
    left.subtask.wave_index - right.subtask.wave_index ||
    left.subtask.subtask_index - right.subtask.subtask_index
  );
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(' ');
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
