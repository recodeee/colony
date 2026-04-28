import { loadSettings } from '@colony/config';
import {
  type MemoryStore,
  type PlanInfo,
  type SubtaskInfo,
  TaskThread,
  listPlans,
} from '@colony/core';
import {
  DEFAULT_STALLED_MINUTES,
  DEFAULT_UNCLAIMED_MINUTES,
  type QueenAttentionItem,
  type QueenPlan,
  type QueenSubtask,
  planGoal,
  sweepQueenPlans,
} from '@colony/queen';
import { SpecRepository } from '@colony/spec';
import type { Command } from 'commander';
import kleur from 'kleur';
import { resolve } from 'node:path';
import { withStore } from '../util/store.js';

const QUEEN_AGENT = 'queen';
const QUEEN_SESSION_ID = 'colony-queen-cli';

interface PlanOpts {
  problem: string;
  accept: string[];
  files?: string[];
  repoRoot?: string;
  dryRun?: boolean;
}

interface RepoOpts {
  repoRoot?: string;
}

interface SweepOpts {
  repoRoot?: string;
  olderThanMinutes?: string;
  unclaimedOlderThanMinutes?: string;
  autoMessage?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export function registerQueenCommand(program: Command): void {
  const group = program
    .command('queen')
    .description('Queen coordination helpers for published plan lanes');

  group
    .command('plan')
    .description('Draft or publish a queen plan from the terminal')
    .argument('<title>', 'Plan title')
    .requiredOption('--problem <text>', 'Problem statement')
    .option('--accept <text>', 'Acceptance criterion; repeatable', collect, [])
    .option('--files <path...>', 'Files in scope')
    .option('--repo-root <path>', 'Repo root (defaults to process.cwd())')
    .option('--dry-run', 'Preview drafted sub-tasks without publishing')
    .action(async (title: string, opts: PlanOpts) => {
      if (opts.accept.length === 0) {
        throw new Error('queen plan needs at least one --accept value');
      }

      const repoRoot = resolve(opts.repoRoot ?? process.cwd());
      const plan = planGoal({
        title,
        problem: opts.problem,
        acceptance_criteria: opts.accept,
        repo_root: repoRoot,
        affected_files: opts.files ?? [],
      });

      if (opts.dryRun === true) {
        renderDraftTable(plan);
        return;
      }

      const settings = loadSettings();
      await withStore(settings, (store) => {
        store.startSession({ id: QUEEN_SESSION_ID, ide: QUEEN_AGENT, cwd: repoRoot });
        const published = publishQueenPlan(store, repoRoot, plan);
        process.stdout.write(`${kleur.green('✓')} queen plan published ${kleur.cyan(plan.slug)}\n`);
        process.stdout.write(`  spec: ${published.spec_change_path}\n`);
        process.stdout.write(renderPublishedSubtasks(plan, published.subtasks));
      });
    });

  group
    .command('list')
    .description('List queen-published plans with sub-task rollup')
    .option('--repo-root <path>', 'Repo root (defaults to process.cwd())')
    .action(async (opts: RepoOpts) => {
      const repoRoot = resolve(opts.repoRoot ?? process.cwd());
      const settings = loadSettings();
      await withStore(settings, (store) => {
        const plans = queenPlans(store, repoRoot);
        if (plans.length === 0) {
          process.stdout.write(`${kleur.dim('no queen plans')}\n`);
          return;
        }
        for (const plan of plans) renderPlanRollup(plan);
      });
    });

  group
    .command('status')
    .description('Show one queen plan and its sub-task claim state')
    .argument('<slug>', 'Plan slug')
    .option('--repo-root <path>', 'Repo root (defaults to process.cwd())')
    .action(async (slug: string, opts: RepoOpts) => {
      const repoRoot = resolve(opts.repoRoot ?? process.cwd());
      const settings = loadSettings();
      await withStore(settings, (store) => {
        const plan = queenPlans(store, repoRoot).find((candidate) => candidate.plan_slug === slug);
        if (!plan) throw new Error(`queen plan not found: ${slug}`);
        renderPlanStatus(plan);
      });
    });

  group
    .command('sweep')
    .description('List queen plans needing attention: stalled, unclaimed, ready to archive')
    .option('--repo-root <path>', 'repo root to scan')
    .option(
      '--older-than-minutes <minutes>',
      `claimed sub-task stall threshold (default ${DEFAULT_STALLED_MINUTES})`,
    )
    .option(
      '--unclaimed-older-than-minutes <minutes>',
      `available sub-task threshold (default ${DEFAULT_UNCLAIMED_MINUTES})`,
    )
    .option('--auto-message', 'send needs_reply messages to stalled claim owners')
    .option('--dry-run', 'scan only; suppress auto-messages')
    .option('--json', 'emit sweep result as JSON')
    .action(async (opts: SweepOpts) => {
      const olderThan = parseMinutes(opts.olderThanMinutes, '--older-than-minutes');
      const unclaimedOlderThan = parseMinutes(
        opts.unclaimedOlderThanMinutes,
        '--unclaimed-older-than-minutes',
      );
      if (olderThan === null || unclaimedOlderThan === null) {
        process.exitCode = 1;
        return;
      }

      const settings = loadSettings();
      await withStore(settings, (store) => {
        const result = sweepQueenPlans(store, {
          auto_message: opts.autoMessage === true && opts.dryRun !== true,
          ...(opts.repoRoot !== undefined ? { repo_root: opts.repoRoot } : {}),
          ...(olderThan !== undefined ? { older_than_minutes: olderThan } : {}),
          ...(unclaimedOlderThan !== undefined
            ? { unclaimed_older_than_minutes: unclaimedOlderThan }
            : {}),
        });

        if (opts.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          return;
        }

        process.stdout.write(`${renderSweep(result, opts)}\n`);
      });
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseMinutes(raw: string | undefined, flag: string): number | undefined | null {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    process.stderr.write(`${kleur.red('invalid value')} for ${flag}: ${raw}\n`);
    return null;
  }
  return parsed;
}

function renderSweep(result: ReturnType<typeof sweepQueenPlans>, opts: SweepOpts): string {
  const items = result.flatMap((plan) => plan.items);
  const stalled = items.filter((item) => item.reason === 'stalled');
  const unclaimed = items.filter((item) => item.reason === 'unclaimed');
  const ready = items.filter((item) => item.reason === 'ready-to-archive');
  const sent = stalled.filter((item) => item.message_observation_id !== undefined).length;

  const lines: string[] = [];
  if (items.length === 0) {
    lines.push(kleur.green('Queen sweep: no plans need attention'));
    return lines.join('\n');
  }

  lines.push(
    kleur.bold(
      `Queen sweep: ${result.length} plan(s) need attention  stalled: ${stalled.length}  unclaimed: ${unclaimed.length}  ready-to-archive: ${ready.length}`,
    ),
  );
  if (opts.autoMessage === true) {
    lines.push(
      opts.dryRun === true
        ? kleur.yellow('  dry-run: auto-message requested, no messages sent')
        : `  messages sent: ${sent}`,
    );
  }

  lines.push('');
  lines.push(kleur.cyan('Examples:'));
  for (const item of items.slice(0, 5)) {
    lines.push(`  ${renderExample(item)}`);
  }
  if (items.length > 5) {
    lines.push(`  ... ${items.length - 5} more item(s); use --json for full detail`);
  }

  return lines.join('\n');
}

function renderExample(item: QueenAttentionItem): string {
  if (item.reason === 'stalled') {
    return `${item.plan_slug}/sub-${item.subtask_index} stalled: claimed by ${item.claimed_by_agent ?? item.claimed_by_session_id} for ${item.age_minutes}m`;
  }
  if (item.reason === 'unclaimed') {
    return `${item.plan_slug}/sub-${item.subtask_index} unclaimed: available for ${item.age_minutes}m`;
  }
  return `${item.plan_slug} ready-to-archive: ${item.completed_subtask_count} completed sub-task(s), auto_archive off`;
}

function publishQueenPlan(
  store: MemoryStore,
  repoRoot: string,
  plan: QueenPlan,
): {
  spec_change_path: string;
  subtasks: Array<{ subtask_index: number; branch: string; task_id: number; title: string }>;
} {
  assertValidSubtasks(plan.subtasks);
  const repo = new SpecRepository({ repoRoot, store });
  const opened = repo.openChange({
    slug: plan.slug,
    session_id: QUEEN_SESSION_ID,
    agent: QUEEN_AGENT,
    proposal: renderProposal(plan),
  });

  store.addObservation({
    session_id: QUEEN_SESSION_ID,
    task_id: opened.task_id,
    kind: 'plan-config',
    content: `plan ${plan.slug} config: auto_archive=false`,
    metadata: {
      plan_slug: plan.slug,
      auto_archive: false,
    },
  });

  const subtasks = plan.subtasks.map((subtask, index) => {
    const branch = `spec/${plan.slug}/sub-${index}`;
    const thread = TaskThread.open(store, {
      repo_root: repoRoot,
      branch,
      session_id: QUEEN_SESSION_ID,
    });
    store.addObservation({
      session_id: QUEEN_SESSION_ID,
      task_id: thread.task_id,
      kind: 'plan-subtask',
      content: `${subtask.title}\n\n${subtask.description}`,
      metadata: {
        parent_plan_slug: plan.slug,
        parent_plan_title: plan.title,
        parent_spec_task_id: opened.task_id,
        subtask_index: index,
        file_scope: subtask.file_scope,
        depends_on: subtask.depends_on,
        capability_hint: subtask.capability_hint,
        status: 'available',
      },
    });
    return {
      subtask_index: index,
      branch,
      task_id: thread.task_id,
      title: subtask.title,
    };
  });

  return { spec_change_path: opened.path, subtasks };
}

function assertValidSubtasks(subtasks: QueenSubtask[]): void {
  if (subtasks.length < 2) throw new Error('queen plan needs at least two sub-tasks');
  for (let i = 0; i < subtasks.length; i++) {
    for (const dep of subtasks[i]?.depends_on ?? []) {
      if (dep >= i) {
        throw new Error(
          `PLAN_INVALID_DEPENDENCY: sub-task ${i} depends on ${dep}; dependencies must point to earlier indices`,
        );
      }
    }
  }

  const overlap = detectScopeOverlap(subtasks);
  if (overlap) {
    throw new Error(
      `PLAN_SCOPE_OVERLAP: sub-tasks ${overlap.a} and ${overlap.b} share files [${overlap.shared.join(', ')}] without a depends_on edge between them`,
    );
  }
}

function detectScopeOverlap(
  subtasks: QueenSubtask[],
): { a: number; b: number; shared: string[] } | null {
  for (let i = 0; i < subtasks.length; i++) {
    for (let j = i + 1; j < subtasks.length; j++) {
      const a = subtasks[i];
      const b = subtasks[j];
      if (!a || !b) continue;
      if (isDependentChain(subtasks, i, j) || isDependentChain(subtasks, j, i)) continue;
      const shared = a.file_scope.filter((file) => b.file_scope.includes(file));
      if (shared.length > 0) return { a: i, b: j, shared };
    }
  }
  return null;
}

function isDependentChain(subtasks: QueenSubtask[], from: number, to: number): boolean {
  const visited = new Set<number>();
  const stack = [from];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    const deps = subtasks[current]?.depends_on ?? [];
    if (deps.includes(to)) return true;
    stack.push(...deps);
  }
  return false;
}

function queenPlans(store: MemoryStore, repoRoot: string): PlanInfo[] {
  return listPlans(store, { repo_root: repoRoot, limit: 2000 }).filter((plan) =>
    store.storage
      .listParticipants(plan.spec_task_id)
      .some((participant) => participant.agent === QUEEN_AGENT),
  );
}

function renderDraftTable(plan: QueenPlan): void {
  const rows = [
    ['slug', 'title', 'capability', 'file_scope', 'depends_on'],
    ['---', '---', '---', '---', '---'],
    ...plan.subtasks.map((subtask, index) => [
      `${plan.slug}/sub-${index}`,
      subtask.title,
      subtask.capability_hint,
      formatFiles(subtask.file_scope),
      formatDepends(subtask.depends_on),
    ]),
  ];
  process.stdout.write(`${kleur.bold('queen plan draft')} ${kleur.cyan(plan.slug)}\n`);
  process.stdout.write(`${rows.map((row) => row.join(' | ')).join('\n')}\n`);
}

function renderPublishedSubtasks(
  plan: QueenPlan,
  published: Array<{ subtask_index: number; branch: string; task_id: number; title: string }>,
): string {
  const lines = ['', kleur.bold('subtasks:')];
  for (const task of published) {
    const draft = plan.subtasks[task.subtask_index];
    lines.push(`  sub-${task.subtask_index} ${task.title}`);
    lines.push(`    task: #${task.task_id} ${task.branch}`);
    lines.push(`    capability: ${draft?.capability_hint ?? '-'}`);
    lines.push(`    file-scope: ${formatFiles(draft?.file_scope ?? [])}`);
    lines.push(`    depends: ${formatDepends(draft?.depends_on ?? [])}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderPlanRollup(plan: PlanInfo): void {
  const counts = plan.subtask_counts;
  process.stdout.write(`${kleur.cyan(plan.plan_slug)}  ${plan.title}\n`);
  process.stdout.write(
    `  status: ${counts.available} available, ${counts.claimed} claimed, ${counts.completed} completed, ${counts.blocked} blocked\n`,
  );
  for (const task of plan.subtasks) {
    process.stdout.write(
      `  sub-${task.subtask_index} [${task.status}] ${task.title} (${task.capability_hint ?? '-'})\n`,
    );
  }
}

function renderPlanStatus(plan: PlanInfo): void {
  process.stdout.write(`${kleur.bold('queen plan')} ${kleur.cyan(plan.plan_slug)}\n`);
  process.stdout.write(`  title: ${plan.title}\n`);
  process.stdout.write(`  repo: ${plan.repo_root}\n`);
  process.stdout.write(`  spec task: #${plan.spec_task_id}\n`);
  process.stdout.write(
    `  status: ${plan.subtask_counts.available} available, ${plan.subtask_counts.claimed} claimed, ${plan.subtask_counts.completed} completed, ${plan.subtask_counts.blocked} blocked\n`,
  );
  for (const task of plan.subtasks) renderSubtaskStatus(task);
}

function renderSubtaskStatus(task: SubtaskInfo): void {
  process.stdout.write(`\nsub-${task.subtask_index} [${task.status}] ${task.title}\n`);
  process.stdout.write(`  task: #${task.task_id}\n`);
  process.stdout.write(`  capability: ${task.capability_hint ?? '-'}\n`);
  process.stdout.write(`  file-scope: ${formatFiles(task.file_scope)}\n`);
  process.stdout.write(`  depends: ${formatDepends(task.depends_on)}\n`);
  process.stdout.write(
    `  claimed: ${
      task.claimed_by_agent
        ? `${task.claimed_by_agent} (${task.claimed_by_session_id ?? 'unknown session'})`
        : '-'
    }\n`,
  );
}

function renderProposal(plan: QueenPlan): string {
  const criteria = plan.acceptance_criteria.map((criterion) => `- ${criterion}`).join('\n');
  const subtasks = plan.subtasks
    .map((subtask, index) => {
      const deps = subtask.depends_on.length
        ? ` (depends on: ${subtask.depends_on.join(', ')})`
        : '';
      return `### Sub-task ${index}: ${subtask.title}${deps}

${subtask.description}

File scope: ${subtask.file_scope.join(', ')}`;
    })
    .join('\n\n');

  return `# ${plan.title}

## Problem

${plan.problem}

## Acceptance criteria

${criteria}

## Sub-tasks

${subtasks}
`;
}

function formatFiles(files: string[]): string {
  return files.length > 0 ? files.join(', ') : '-';
}

function formatDepends(dependsOn: number[] | undefined): string {
  return dependsOn?.length ? dependsOn.map((dep) => `sub-${dep}`).join(', ') : '-';
}
