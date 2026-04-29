import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadSettings } from '@colony/config';
import {
  type MemoryStore,
  type PlanInfo,
  type SubtaskInfo,
  TaskThread,
  listPlans,
} from '@colony/core';
import {
  type CapabilityHint,
  DEFAULT_STALLED_MINUTES,
  DEFAULT_UNCLAIMED_MINUTES,
  type Goal,
  type QueenAttentionItem,
  type QueenPlan,
  type QueenSubtask,
  type QueenSweepWaveSummary,
  colonyAdoptionFixesPlan,
  planGoal,
  publishOrderedPlan,
  sweepQueenPlans,
} from '@colony/queen';
import type { Command } from 'commander';
import kleur from 'kleur';
import { withStore } from '../util/store.js';

const QUEEN_AGENT = 'queen';
const QUEEN_SESSION_ID = 'colony-queen-cli';

interface PlanOpts {
  problem?: string;
  accept: string[];
  file?: string;
  files?: string[];
  repoRoot?: string;
  dryRun?: boolean;
  json?: boolean;
}

interface RepoOpts {
  repoRoot?: string;
}

interface AdoptionFixesOpts extends RepoOpts {
  json?: boolean;
}

interface SweepOpts {
  repoRoot?: string;
  olderThanMinutes?: string;
  unclaimedOlderThanMinutes?: string;
  autoMessage?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

interface ResolvedPlanDraft {
  plan: QueenPlan;
  repoRoot: string;
  sourceRationales: string[];
  finalizer?: string | undefined;
}

interface PlanPreviewSubtask {
  index: number;
  ref: string;
  title: string;
  capability_hint: CapabilityHint;
  file_scope: string[];
  depends_on: number[];
  depends_on_refs: string[];
  is_finalizer: boolean;
}

interface PlanPreviewWave {
  index: number;
  label: string;
  blocked_by: number[];
  blocked_by_refs: string[];
  parallel_subtasks: PlanPreviewSubtask[];
  rationale: string;
}

interface PlanPreview {
  dry_run: true;
  plan: {
    slug: string;
    title: string;
    problem: string;
    acceptance_criteria: string[];
  };
  waves: PlanPreviewWave[];
  depends_on_edges: Array<{ from: string; to: string; reason: string }>;
  blocked_future_work: Array<{
    subtask_index: number;
    ref: string;
    title: string;
    blocked_by: number[];
    blocked_by_refs: string[];
  }>;
  finalizer_tasks: PlanPreviewSubtask[];
  rationale: string[];
}

export function registerQueenCommand(program: Command): void {
  const group = program
    .command('queen')
    .description('Queen coordination helpers for published plan lanes');

  group
    .command('plan')
    .description('Draft or publish a queen plan from the terminal')
    .argument('[title]', 'Plan title; omit when --file supplies one')
    .option('--problem <text>', 'Problem statement')
    .option('--accept <text>', 'Acceptance criterion; repeatable', collect, [])
    .option('--file <path>', 'Read a queen goal JSON file')
    .option('--files <path...>', 'Files in scope')
    .option('--repo-root <path>', 'Repo root (defaults to process.cwd())')
    .option('--dry-run', 'Preview drafted sub-tasks without publishing')
    .option('--json', 'Emit dry-run preview as JSON')
    .action(async (title: string | undefined, opts: PlanOpts) => {
      const draft = resolvePlanDraft(title, opts);
      const { plan, repoRoot } = draft;

      if (opts.dryRun === true) {
        const preview = buildPlanPreview(plan, draft);
        if (opts.json === true) {
          process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
          return;
        }
        renderDraftTable(plan);
        process.stdout.write(renderPlanPreview(preview));
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
    .command('adoption-fixes')
    .description('Publish current Colony adoption-fix waves into the local DB')
    .option('--repo-root <path>', 'Repo root (defaults to process.cwd())')
    .option('--json', 'Emit publish status as JSON')
    .action(async (opts: AdoptionFixesOpts) => {
      const repoRoot = resolve(opts.repoRoot ?? process.cwd());
      const settings = loadSettings();
      await withStore(settings, (store) => {
        store.startSession({ id: QUEEN_SESSION_ID, ide: QUEEN_AGENT, cwd: repoRoot });
        const existing = queenPlans(store, repoRoot).find(
          (candidate) => candidate.plan_slug === colonyAdoptionFixesPlan.slug,
        );
        const published =
          existing === undefined
            ? publishQueenPlanStructure(store, repoRoot, colonyAdoptionFixesPlan)
            : null;
        const plan = queenPlans(store, repoRoot).find(
          (candidate) => candidate.plan_slug === colonyAdoptionFixesPlan.slug,
        );
        if (!plan)
          throw new Error(`queen plan not found after publish: ${colonyAdoptionFixesPlan.slug}`);

        if (opts.json === true) {
          process.stdout.write(
            `${JSON.stringify(adoptionFixesPayload(plan, published !== null), null, 2)}\n`,
          );
          return;
        }

        process.stdout.write(
          `${kleur.green('✓')} queen adoption-fixes ${
            published === null ? 'already active' : 'published'
          } ${kleur.cyan(plan.plan_slug)}\n`,
        );
        process.stdout.write(
          `  ready: ${plan.next_available.length}; blocked: ${blockedFutureSubtaskCount(plan)}; agents pull with task_ready_for_agent\n`,
        );
        renderPlanRollup(plan);
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

function resolvePlanDraft(titleArg: string | undefined, opts: PlanOpts): ResolvedPlanDraft {
  const fileInput = opts.file ? readPlanFile(opts.file) : {};
  const title = titleArg ?? fileString(fileInput, 'goal_title') ?? fileString(fileInput, 'title');
  if (!title) throw new Error('queen plan needs a title or --file goal_title/title');

  const problem =
    opts.problem ?? fileString(fileInput, 'problem') ?? fileString(fileInput, 'description');
  if (!problem) throw new Error('queen plan needs --problem or --file problem');

  const acceptanceCriteria =
    opts.accept.length > 0
      ? opts.accept
      : (fileStringArray(fileInput, 'acceptance_criteria') ??
        fileStringArray(fileInput, 'acceptance') ??
        fileStringArray(fileInput, 'accept') ??
        []);
  if (acceptanceCriteria.length === 0) {
    throw new Error('queen plan needs at least one --accept value or --file acceptance_criteria');
  }

  const repoRoot = resolve(opts.repoRoot ?? fileString(fileInput, 'repo_root') ?? process.cwd());
  const orderingHint = fileString(fileInput, 'ordering_hint');
  if (orderingHint !== undefined && orderingHint !== 'wave') {
    throw new Error(`unsupported queen ordering_hint: ${orderingHint}`);
  }

  const sourceWaves = fileWaves(fileInput);
  const finalizer = fileString(fileInput, 'finalizer');
  const affectedFiles =
    opts.files ??
    fileStringArray(fileInput, 'affected_files') ??
    fileStringArray(fileInput, 'files') ??
    [];
  const goal: Goal = {
    title,
    problem,
    acceptance_criteria: acceptanceCriteria,
    repo_root: repoRoot,
    affected_files: affectedFiles,
    ...(orderingHint === 'wave' ? { ordering_hint: orderingHint } : {}),
    ...(sourceWaves !== undefined ? { waves: sourceWaves } : {}),
    ...(finalizer !== undefined ? { finalizer } : {}),
  };

  return {
    plan: planGoal(goal),
    repoRoot,
    sourceRationales:
      sourceWaves?.flatMap((wave) => (wave.rationale ? [wave.rationale] : [])) ?? [],
    ...(finalizer !== undefined ? { finalizer } : {}),
  };
}

function readPlanFile(filePath: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(resolve(filePath), 'utf8')) as unknown;
  if (!isRecord(raw)) throw new Error(`queen plan file must contain a JSON object: ${filePath}`);
  return raw;
}

function fileString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function fileStringArray(input: Record<string, unknown>, key: string): string[] | undefined {
  const value = input[key];
  if (typeof value === 'string' && value.trim().length > 0) return [value.trim()];
  if (!Array.isArray(value)) return undefined;
  const values = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function fileNumberArray(input: Record<string, unknown>, key: string): number[] | undefined {
  const value = input[key];
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is number => Number.isInteger(item) && item >= 0);
  return values.length > 0 ? values : undefined;
}

function fileWaves(input: Record<string, unknown>): NonNullable<Goal['waves']> | undefined {
  const raw = input.waves;
  if (!Array.isArray(raw)) return undefined;
  const waves = raw.filter(isRecord).map((wave) => ({
    ...((fileString(wave, 'name') ?? fileString(wave, 'title') ?? fileString(wave, 'id'))
      ? { name: fileString(wave, 'name') ?? fileString(wave, 'title') ?? fileString(wave, 'id') }
      : {}),
    ...(fileStringArray(wave, 'subtask_refs') !== undefined
      ? { subtask_refs: fileStringArray(wave, 'subtask_refs') }
      : {}),
    ...(fileStringArray(wave, 'titles') !== undefined
      ? { titles: fileStringArray(wave, 'titles') }
      : {}),
    ...(fileStringArray(wave, 'files') !== undefined
      ? { files: fileStringArray(wave, 'files') }
      : {}),
    ...(fileStringArray(wave, 'affected_files') !== undefined
      ? { affected_files: fileStringArray(wave, 'affected_files') }
      : {}),
    ...(fileNumberArray(wave, 'depends_on') !== undefined
      ? { depends_on: fileNumberArray(wave, 'depends_on') }
      : {}),
    ...(fileString(wave, 'rationale') !== undefined
      ? { rationale: fileString(wave, 'rationale') }
      : {}),
  }));
  return waves.length > 0 ? waves : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

  const waveDiagnostics = renderWaveDiagnostics(result);
  if (waveDiagnostics.length > 0) {
    lines.push('');
    lines.push(kleur.cyan('Wave diagnostics:'));
    lines.push(...waveDiagnostics);
  }

  const validationDiagnostics = renderValidationDiagnostics(result);
  if (validationDiagnostics.length > 0) {
    lines.push('');
    lines.push(kleur.cyan('Plan validation:'));
    lines.push(...validationDiagnostics);
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

function renderValidationDiagnostics(result: ReturnType<typeof sweepQueenPlans>): string[] {
  const lines: string[] = [];
  for (const plan of result) {
    const validation = plan.validation_summary;
    if (!validation || validation.finding_count === 0) continue;
    lines.push(
      `  ${plan.plan_slug}: ${validation.finding_count} finding(s), errors ${validation.counts.error}, warnings ${validation.counts.warning}, info ${validation.counts.info}`,
    );
    for (const finding of validation.top_findings.slice(0, 3)) {
      lines.push(`    ${finding.severity}: ${finding.message}`);
    }
  }
  return lines;
}

function renderWaveDiagnostics(result: ReturnType<typeof sweepQueenPlans>): string[] {
  const lines: string[] = [];
  for (const plan of result) {
    const planLines = (plan.waves ?? []).flatMap(renderWaveSummary);
    if (planLines.length === 0) continue;
    lines.push(`  ${plan.plan_slug}:`);
    lines.push(...planLines.map((line) => `    ${line}`));
  }
  return lines;
}

function renderWaveSummary(wave: QueenSweepWaveSummary): string[] {
  const lines: string[] = [];
  if (wave.stalled_subtask_count > 0) {
    lines.push(
      `${wave.label} has ${wave.stalled_subtask_count} ${plural(wave.stalled_subtask_count, 'stalled subtask')}`,
    );
  }
  if (wave.unclaimed_subtask_count > 0) {
    lines.push(
      `${wave.label} has ${wave.unclaimed_subtask_count} ${plural(wave.unclaimed_subtask_count, 'unclaimed subtask')}`,
    );
  }
  if (wave.waiting_on_subtask_count > 0) {
    if (wave.is_finalizer === true) {
      lines.push(
        `${wave.label} waiting on ${wave.waiting_on_subtask_count} ${plural(wave.waiting_on_subtask_count, 'subtask')}`,
      );
    } else if (wave.blocked_by.length > 0) {
      lines.push(
        `${wave.label} is blocked by ${formatWaveBlockers(wave.blocked_by.map((blocker) => blocker.label))}`,
      );
    }
  }
  return lines;
}

function renderExample(item: QueenAttentionItem): string {
  if (item.reason === 'stalled') {
    const replacement = item.replacement_recommendation
      ? `; replacement ${item.replacement_recommendation.recommended_replacement_agent} (${item.replacement_recommendation.reason}; next ${item.replacement_recommendation.next_tool})`
      : '';
    return `${item.plan_slug}/sub-${item.subtask_index} stalled: claimed by ${item.claimed_by_agent ?? item.claimed_by_session_id} for ${item.age_minutes}m${replacement}`;
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
  return publishOrderedPlan({
    store,
    plan,
    repo_root: repoRoot,
    session_id: QUEEN_SESSION_ID,
    agent: QUEEN_AGENT,
    auto_archive: false,
  });
}

function queenPlans(store: MemoryStore, repoRoot: string): PlanInfo[] {
  return listPlans(store, { repo_root: repoRoot, limit: 2000 }).filter((plan) =>
    store.storage
      .listParticipants(plan.spec_task_id)
      .some((participant) => participant.agent === QUEEN_AGENT),
  );
}

function publishQueenPlanStructure(
  store: MemoryStore,
  repoRoot: string,
  plan: QueenPlan,
): {
  spec_task_id: number;
  subtasks: Array<{ subtask_index: number; branch: string; task_id: number; title: string }>;
} {
  const parent = TaskThread.open(store, {
    repo_root: repoRoot,
    branch: `spec/${plan.slug}`,
    title: plan.title,
    session_id: QUEEN_SESSION_ID,
  });
  parent.join(QUEEN_SESSION_ID, QUEEN_AGENT);
  store.addObservation({
    session_id: QUEEN_SESSION_ID,
    task_id: parent.task_id,
    kind: 'plan-config',
    content: `queen plan ${plan.slug} config: auto_archive=false`,
    metadata: {
      plan_slug: plan.slug,
      auto_archive: false,
      source: 'queen',
      source_tool: 'queen adoption-fixes',
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
        parent_spec_task_id: parent.task_id,
        subtask_index: index,
        title: subtask.title,
        description: subtask.description,
        file_scope: subtask.file_scope,
        depends_on: subtask.depends_on,
        spec_row_id: null,
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

  return { spec_task_id: parent.task_id, subtasks };
}

function adoptionFixesPayload(
  plan: PlanInfo,
  published: boolean,
): {
  plan_slug: string;
  status: 'published' | 'already_active';
  active_plans: number;
  ready_subtasks: number;
  blocked_subtasks: number;
  claimable_current_wave: Array<{
    subtask_index: number;
    title: string;
    wave_index: number;
    wave_name: string;
    claim_args: {
      plan_slug: string;
      subtask_index: number;
      session_id: '<session_id>';
      agent: '<agent>';
    };
  }>;
} {
  return {
    plan_slug: plan.plan_slug,
    status: published ? 'published' : 'already_active',
    active_plans: 1,
    ready_subtasks: plan.next_available.length,
    blocked_subtasks: blockedFutureSubtaskCount(plan),
    claimable_current_wave: plan.next_available.map((subtask) => ({
      subtask_index: subtask.subtask_index,
      title: subtask.title,
      wave_index: subtask.wave_index,
      wave_name: subtask.wave_name,
      claim_args: {
        plan_slug: plan.plan_slug,
        subtask_index: subtask.subtask_index,
        session_id: '<session_id>',
        agent: '<agent>',
      },
    })),
  };
}

function blockedFutureSubtaskCount(plan: PlanInfo): number {
  return plan.subtasks.filter(
    (subtask) => subtask.status === 'available' && subtask.blocked_by_count > 0,
  ).length;
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

function buildPlanPreview(plan: QueenPlan, draft: ResolvedPlanDraft): PlanPreview {
  const waves = computePlanWaves(plan);
  const subtaskPreviews = plan.subtasks.map((subtask, index) =>
    previewSubtask(subtask, index, draft.finalizer),
  );
  const dependsOnEdges = plan.subtasks.flatMap((subtask, index) =>
    subtask.depends_on.map((dep) => ({
      from: subtaskRef(dep),
      to: subtaskRef(index),
      reason: `${subtaskRef(dep)} must finish before ${subtaskRef(index)} can start`,
    })),
  );
  const previewWaves = waves.map((wave, index) => {
    const blockedBy = uniqueSorted(
      wave.flatMap((subtaskIndex) => plan.subtasks[subtaskIndex]?.depends_on ?? []),
    );
    return {
      index,
      label: `Wave ${index + 1}`,
      blocked_by: blockedBy,
      blocked_by_refs: blockedBy.map(subtaskRef),
      parallel_subtasks: wave
        .map((subtaskIndex) => subtaskPreviews[subtaskIndex])
        .filter(isDefined),
      rationale: waveRationale(index, blockedBy, draft.sourceRationales[index]),
    };
  });
  const firstWave = new Set(waves[0] ?? []);
  const blockedFutureWork = subtaskPreviews
    .filter((subtask) => !firstWave.has(subtask.index))
    .map((subtask) => ({
      subtask_index: subtask.index,
      ref: subtask.ref,
      title: subtask.title,
      blocked_by: subtask.depends_on,
      blocked_by_refs: subtask.depends_on_refs,
    }));
  const finalizerTasks = subtaskPreviews.filter((subtask) => subtask.is_finalizer);

  return {
    dry_run: true,
    plan: {
      slug: plan.slug,
      title: plan.title,
      problem: plan.problem,
      acceptance_criteria: plan.acceptance_criteria,
    },
    waves: previewWaves,
    depends_on_edges: dependsOnEdges,
    blocked_future_work: blockedFutureWork,
    finalizer_tasks: finalizerTasks,
    rationale: [
      'Wave 1 contains all currently claimable sub-tasks.',
      'Later waves are grouped by depends_on edges; sub-tasks in the same wave can be launched in parallel after blockers complete.',
      ...draft.sourceRationales,
    ],
  };
}

function computePlanWaves(plan: QueenPlan): number[][] {
  const pending = new Set(plan.subtasks.map((_, index) => index));
  const completed = new Set<number>();
  const waves: number[][] = [];

  while (pending.size > 0) {
    const ready = [...pending]
      .filter((index) =>
        (plan.subtasks[index]?.depends_on ?? []).every((dep) => completed.has(dep)),
      )
      .sort((a, b) => a - b);
    const wave = ready.length > 0 ? ready : [...pending].sort((a, b) => a - b);
    waves.push(wave);
    for (const index of wave) {
      pending.delete(index);
      completed.add(index);
    }
  }

  return waves;
}

function previewSubtask(
  subtask: QueenSubtask,
  index: number,
  explicitFinalizer: string | undefined,
): PlanPreviewSubtask {
  return {
    index,
    ref: subtaskRef(index),
    title: subtask.title,
    capability_hint: subtask.capability_hint,
    file_scope: [...subtask.file_scope],
    depends_on: [...subtask.depends_on],
    depends_on_refs: subtask.depends_on.map(subtaskRef),
    is_finalizer: isFinalizerSubtask(subtask, explicitFinalizer),
  };
}

function isFinalizerSubtask(subtask: QueenSubtask, explicitFinalizer: string | undefined): boolean {
  if (explicitFinalizer && normalizeLabel(subtask.title) === normalizeLabel(explicitFinalizer)) {
    return true;
  }
  return /\b(final|finalize|finalizer|verify|verification|qa|release)\b/i.test(subtask.title);
}

function waveRationale(
  index: number,
  blockedBy: number[],
  sourceRationale: string | undefined,
): string {
  if (sourceRationale) return sourceRationale;
  if (index === 0) return 'No depends_on blockers; launch these sub-tasks in parallel first.';
  return `Blocked until ${formatDepends(blockedBy)} completes.`;
}

function renderPlanPreview(preview: PlanPreview): string {
  const lines = ['', kleur.bold('waves:')];
  for (const wave of preview.waves) {
    lines.push(`  ${wave.label}: ${wave.parallel_subtasks.map((task) => task.ref).join(', ')}`);
    lines.push(`    parallel: ${wave.parallel_subtasks.map((task) => task.title).join(' / ')}`);
    lines.push(
      `    blocked-by: ${wave.blocked_by_refs.length > 0 ? wave.blocked_by_refs.join(', ') : '-'}`,
    );
    lines.push(`    rationale: ${wave.rationale}`);
  }

  lines.push('', kleur.bold('depends_on edges:'));
  if (preview.depends_on_edges.length === 0) {
    lines.push('  -');
  } else {
    for (const edge of preview.depends_on_edges) lines.push(`  ${edge.from} -> ${edge.to}`);
  }

  lines.push('', kleur.bold('blocked future work:'));
  if (preview.blocked_future_work.length === 0) {
    lines.push('  -');
  } else {
    for (const task of preview.blocked_future_work) {
      lines.push(`  ${task.ref} ${task.title} blocked by ${task.blocked_by_refs.join(', ')}`);
    }
  }

  lines.push('', kleur.bold('finalizer tasks:'));
  if (preview.finalizer_tasks.length === 0) {
    lines.push('  -');
  } else {
    for (const task of preview.finalizer_tasks) lines.push(`  ${task.ref} ${task.title}`);
  }

  lines.push('', kleur.bold('rationale:'));
  for (const reason of preview.rationale) lines.push(`  - ${reason}`);
  return `${lines.join('\n')}\n`;
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

function formatFiles(files: string[]): string {
  return files.length > 0 ? files.join(', ') : '-';
}

function formatDepends(dependsOn: number[] | undefined): string {
  return dependsOn?.length ? dependsOn.map((dep) => `sub-${dep}`).join(', ') : '-';
}

function subtaskRef(index: number): string {
  return `sub-${index}`;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function formatWaveBlockers(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? 'earlier waves';
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}
