import { resolve } from 'node:path';
import { loadSettings } from '@colony/config';
import type { Command } from 'commander';
import kleur from 'kleur';
import {
  GitGuardexExecutorError,
  type GitGuardexAgent,
  type GitGuardexSpawnResult,
  spawnGitGuardexAgent,
} from '../lib/gitguardex.js';
import { withStore } from '../util/store.js';

interface SpawnOptions {
  executor?: string;
  dryRun?: boolean;
  plan?: string;
  subtask?: string;
  agent?: string;
  base?: string;
  repoRoot?: string;
  json?: boolean;
}

export function registerAgentsCommand(program: Command): void {
  const group = program.command('agents').description('Launch plan sub-task agents through executors');

  group
    .command('spawn')
    .description('Spawn a Colony plan sub-task agent through GitGuardex')
    .requiredOption('--executor <executor>', 'Executor id (supported: gx)')
    .option('--plan <plan-slug>', 'Queen/task plan slug')
    .option('--subtask <index>', 'Plan sub-task index')
    .option('--agent <agent>', 'Agent runtime for gx agents start (codex or claude)', 'codex')
    .option('--base <branch>', 'Base branch for gx agent lane', 'main')
    .option('--repo-root <path>', 'Repo root (defaults to process.cwd())')
    .option('--dry-run', 'Print the gx agents start command without launching')
    .option('--json', 'Emit structured JSON')
    .action(async (opts: SpawnOptions) => {
      if (opts.executor !== 'gx') {
        throw new Error(`unsupported executor: ${opts.executor ?? '(missing)'}`);
      }
      const agent = parseAgent(opts.agent);
      const subtaskIndex = parseOptionalSubtask(opts.subtask);
      const repoRoot = resolve(opts.repoRoot ?? process.cwd());
      const settings = loadSettings();

      await withStore(settings, (store) => {
        try {
          const result = spawnGitGuardexAgent({
            store,
            repoRoot,
            agent,
            base: opts.base ?? 'main',
            dryRun: opts.dryRun === true,
            ...(opts.plan !== undefined ? { planSlug: opts.plan } : {}),
            ...(subtaskIndex !== undefined ? { subtaskIndex } : {}),
          });
          process.stdout.write(renderSpawnResult(result, opts.json === true));
        } catch (err) {
          if (
            opts.dryRun === true &&
            err instanceof GitGuardexExecutorError &&
            err.code === 'NO_READY_SUBTASK'
          ) {
            process.stdout.write(
              opts.json === true
                ? `${JSON.stringify({ dry_run: true, ready: false, error: err.message }, null, 2)}\n`
                : `${kleur.yellow('no ready Colony plan subtasks')}\n${err.message}\n`,
            );
            return;
          }
          throw err;
        }
      });
    });
}

function renderSpawnResult(result: GitGuardexSpawnResult, json: boolean): string {
  if (json) return `${JSON.stringify(result, null, 2)}\n`;
  const lines = [
    result.dry_run
      ? `${kleur.green('gitguardex spawn dry-run')} ${result.plan_slug}/sub-${result.subtask_index}`
      : `${kleur.green('gitguardex spawn')} ${result.plan_slug}/sub-${result.subtask_index}`,
    `command: ${result.command}`,
    `files: ${result.files.length > 0 ? result.files.join(', ') : '-'}`,
  ];
  if (result.colony_session_id) lines.push(`colony_session: ${result.colony_session_id}`);
  if (result.gx_stdout) lines.push('', result.gx_stdout.trimEnd());
  return `${lines.join('\n')}\n`;
}

function parseAgent(value: string | undefined): GitGuardexAgent {
  if (value === 'codex' || value === 'claude') return value;
  throw new Error(`--agent must be codex or claude, got ${value ?? '(missing)'}`);
}

function parseOptionalSubtask(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--subtask must be a non-negative integer, got ${value}`);
  }
  return parsed;
}
