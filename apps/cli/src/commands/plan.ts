import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadSettings } from '@colony/config';
import {
  type PlanCapabilityHint,
  type PlanWorkspaceTaskInput,
  PublishPlanError,
  SpecRepository,
  SyncEngine,
  createPlanWorkspace,
  listPlanWorkspaces,
  parseSpec,
  planTaskCounts,
  publishPlan,
  readPlanWorkspace,
  serializeSpec,
} from '@colony/spec';
import type { Command } from 'commander';
import kleur from 'kleur';
import { withStore } from '../util/store.js';

interface PlanCreateOptions {
  cwd?: string;
  title?: string;
  problem?: string;
  acceptance: string[];
  task: string[];
  force?: boolean;
  publish?: boolean;
  publishSession?: string;
  publishAgent?: string;
  publishAutoArchive?: boolean;
}

interface PlanPublishOptions {
  cwd?: string;
  session?: string;
  agent?: string;
  autoArchive?: boolean;
}

interface PlanStatusOptions {
  cwd?: string;
}

interface PlanCloseOptions {
  cwd?: string;
  session?: string;
  agent?: string;
}

export function registerPlanCommand(program: Command): void {
  const group = program
    .command('plan')
    .description('Create and operate OpenSpec-like Colony plan workspaces');

  group
    .command('create')
    .description('Create openspec/plans/<slug> with plan/tasks/checkpoint role files')
    .argument('<slug>', 'kebab-case plan slug')
    .option('--cwd <path>', 'Repo root (defaults to process.cwd())')
    .option('--title <title>', 'Plan title')
    .option('--problem <text>', 'Problem statement')
    .option('--acceptance <text>', 'Acceptance criterion; repeatable', collect, [])
    .option('--task <json>', 'Task JSON; repeatable', collect, [])
    .option('--force', 'Overwrite an existing plan workspace')
    .option(
      '--publish',
      'Also register the plan in Colony immediately (chains into `plan publish`). Requires ≥2 --task entries.',
    )
    .option('--publish-session <id>', 'Session id for audit trail when --publish is set')
    .option('--publish-agent <name>', 'Agent name for audit trail when --publish is set')
    .option(
      '--publish-auto-archive',
      'Pass --auto-archive through to the chained publish step',
    )
    .action(async (slug: string, opts: PlanCreateOptions) => {
      const repoRoot = resolve(opts.cwd ?? process.cwd());
      const tasks = parseTaskOptions(opts.task);
      const workspace = createPlanWorkspace({
        repoRoot,
        slug,
        title: opts.title ?? titleFromSlug(slug),
        problem: opts.problem,
        acceptanceCriteria: opts.acceptance,
        tasks,
        force: opts.force ?? false,
      });
      process.stdout.write(`${kleur.green('✓')} plan ${slug} created at ${workspace.dir}\n`);

      if (opts.publish === true) {
        if (workspace.manifest.tasks.length < 2) {
          throw new Error(
            '--publish needs at least two --task entries; rerun without --publish or add more tasks',
          );
        }
        const session = opts.publishSession ?? 'colony-plan-cli';
        const agent = opts.publishAgent ?? 'colony';
        const settings = loadSettings();
        await withStore(settings, (store) => {
          store.startSession({ id: session, ide: agent, cwd: repoRoot });
          try {
            const result = publishPlan({
              store,
              repo_root: repoRoot,
              slug,
              session_id: session,
              agent,
              title: workspace.manifest.title,
              problem: workspace.manifest.problem,
              acceptance_criteria: workspace.manifest.acceptance_criteria,
              subtasks: workspace.manifest.tasks.map((task) => ({
                title: task.title,
                description: task.description,
                file_scope: task.file_scope,
                depends_on: task.depends_on,
                spec_row_id: task.spec_row_id ?? undefined,
                capability_hint: task.capability_hint ?? undefined,
              })),
              auto_archive: opts.publishAutoArchive ?? workspace.manifest.published.auto_archive,
            });
            process.stdout.write(`${kleur.green('✓')} published ${slug}\n`);
            process.stdout.write(`  spec: ${result.spec_change_path}\n`);
            process.stdout.write(`  plan: ${result.plan_workspace_path}\n`);
            process.stdout.write(`  subtasks: ${result.subtasks.length}\n`);
          } catch (err) {
            if (err instanceof PublishPlanError) {
              throw new Error(`${err.code}: ${err.message}`);
            }
            throw err;
          }
        });
      }
    });

  group
    .command('status')
    .description('Show one plan workspace or list all local plan workspaces')
    .argument('[slug]', 'Plan slug')
    .option('--cwd <path>', 'Repo root (defaults to process.cwd())')
    .action((slug: string | undefined, opts: PlanStatusOptions) => {
      const repoRoot = resolve(opts.cwd ?? process.cwd());
      const workspaces = slug ? [readPlanWorkspace(repoRoot, slug)] : listPlanWorkspaces(repoRoot);
      if (workspaces.length === 0) {
        process.stdout.write(`${kleur.dim('no plan workspaces')}\n`);
        return;
      }
      for (const workspace of workspaces) {
        const counts = planTaskCounts(workspace.manifest.tasks);
        process.stdout.write(
          `${kleur.cyan(workspace.manifest.plan_slug)}  ${workspace.manifest.title}\n`,
        );
        process.stdout.write(
          `  tasks: ${counts.completed} completed, ${counts.claimed} claimed, ${counts.available} available, ${counts.blocked} blocked\n`,
        );
        process.stdout.write(`  path:  ${workspace.dir}\n`);
      }
    });

  group
    .command('publish')
    .description('Publish a plan workspace into Colony task threads and openspec/changes')
    .argument('<slug>', 'Plan slug')
    .option('--cwd <path>', 'Repo root (defaults to process.cwd())')
    .option('--session <id>', 'Session id for audit trail', 'colony-plan-cli')
    .option('--agent <name>', 'Agent name for audit trail', 'colony')
    .option('--auto-archive', 'Archive the linked spec change when final subtask completes')
    .action(async (slug: string, opts: PlanPublishOptions) => {
      const repoRoot = resolve(opts.cwd ?? process.cwd());
      const workspace = readPlanWorkspace(repoRoot, slug);
      if (workspace.manifest.tasks.length < 2) {
        throw new Error(
          'plan publish needs at least two tasks; use task threads directly for one task',
        );
      }
      const settings = loadSettings();
      await withStore(settings, (store) => {
        store.startSession({
          id: opts.session ?? 'colony-plan-cli',
          ide: opts.agent ?? 'colony',
          cwd: repoRoot,
        });
        try {
          const result = publishPlan({
            store,
            repo_root: repoRoot,
            slug,
            session_id: opts.session ?? 'colony-plan-cli',
            agent: opts.agent ?? 'colony',
            title: workspace.manifest.title,
            problem: workspace.manifest.problem,
            acceptance_criteria: workspace.manifest.acceptance_criteria,
            subtasks: workspace.manifest.tasks.map((task) => ({
              title: task.title,
              description: task.description,
              file_scope: task.file_scope,
              depends_on: task.depends_on,
              spec_row_id: task.spec_row_id ?? undefined,
              capability_hint: task.capability_hint ?? undefined,
            })),
            auto_archive: opts.autoArchive ?? workspace.manifest.published.auto_archive,
          });
          process.stdout.write(`${kleur.green('✓')} published ${slug}\n`);
          process.stdout.write(`  spec: ${result.spec_change_path}\n`);
          process.stdout.write(`  plan: ${result.plan_workspace_path}\n`);
          process.stdout.write(`  subtasks: ${result.subtasks.length}\n`);
        } catch (err) {
          if (err instanceof PublishPlanError) {
            throw new Error(`${err.code}: ${err.message}`);
          }
          throw err;
        }
      });
    });

  group
    .command('close')
    .description('Archive a fully completed published plan change')
    .argument('<slug>', 'Plan slug')
    .option('--cwd <path>', 'Repo root (defaults to process.cwd())')
    .option('--session <id>', 'Session id for audit trail', 'colony-plan-cli')
    .option('--agent <name>', 'Agent name for audit trail', 'colony')
    .action(async (slug: string, opts: PlanCloseOptions) => {
      const repoRoot = resolve(opts.cwd ?? process.cwd());
      const workspace = readPlanWorkspace(repoRoot, slug);
      const incomplete = workspace.manifest.tasks.filter((task) => task.status !== 'completed');
      if (incomplete.length > 0) {
        throw new Error(`plan has ${incomplete.length} incomplete subtask(s); refusing to close`);
      }
      const changePath = join(repoRoot, 'openspec/changes', slug, 'CHANGE.md');
      if (!existsSync(changePath)) {
        throw new Error(`CHANGE.md not found at ${changePath}`);
      }
      const settings = loadSettings();
      await withStore(settings, (store) => {
        store.startSession({
          id: opts.session ?? 'colony-plan-cli',
          ide: opts.agent ?? 'colony',
          cwd: repoRoot,
        });
        const repo = new SpecRepository({ repoRoot, store });
        const currentRoot = repo.readRoot();
        const change = repo.readChange(slug);
        const baseRoot =
          currentRoot.rootHash === change.baseRootHash
            ? currentRoot
            : parseSpec(serializeSpec(currentRoot));
        const merge = new SyncEngine('three_way').merge(currentRoot, baseRoot, change);
        if (!merge.clean) {
          throw new Error(`plan close blocked by ${merge.conflicts.length} spec conflict(s)`);
        }
        repo.writeRoot(merge.spec, {
          session_id: opts.session ?? 'colony-plan-cli',
          agent: opts.agent ?? 'colony',
          reason: `Close plan ${slug}: all subtasks completed`,
        });
        const archived = repo.archiveChange(slug);
        process.stdout.write(`${kleur.green('✓')} closed ${slug}\n`);
        process.stdout.write(`  archived: ${archived}\n`);
      });
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseTaskOptions(values: string[]): PlanWorkspaceTaskInput[] {
  return values.map((value, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch (err) {
      throw new Error(
        `invalid --task JSON at index ${index}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return normalizeTask(parsed, index);
  });
}

function normalizeTask(value: unknown, index: number): PlanWorkspaceTaskInput {
  if (!value || typeof value !== 'object') {
    throw new Error(`task ${index} must be a JSON object`);
  }
  const task = value as Record<string, unknown>;
  if (typeof task.title !== 'string' || task.title.length === 0) {
    throw new Error(`task ${index} needs string field title`);
  }
  if (typeof task.description !== 'string' || task.description.length === 0) {
    throw new Error(`task ${index} needs string field description`);
  }
  if (
    !Array.isArray(task.file_scope) ||
    !task.file_scope.every((file) => typeof file === 'string')
  ) {
    throw new Error(`task ${index} needs string[] field file_scope`);
  }
  return {
    title: task.title,
    description: task.description,
    file_scope: task.file_scope,
    depends_on: Array.isArray(task.depends_on)
      ? task.depends_on.filter((dep): dep is number => Number.isInteger(dep))
      : [],
    spec_row_id: typeof task.spec_row_id === 'string' ? task.spec_row_id : null,
    capability_hint: isCapabilityHint(task.capability_hint) ? task.capability_hint : null,
  };
}

function isCapabilityHint(value: unknown): value is PlanCapabilityHint {
  return (
    value === 'ui_work' ||
    value === 'api_work' ||
    value === 'test_work' ||
    value === 'infra_work' ||
    value === 'doc_work'
  );
}

function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}
