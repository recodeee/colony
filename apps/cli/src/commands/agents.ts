import { resolve } from 'node:path';
import { loadSettings } from '@colony/config';
import type { Command } from 'commander';
import kleur from 'kleur';
import {
  type GitGuardexAgent,
  buildGitGuardexSpawnPlan,
  claimGitGuardexSpawnTarget,
  runGitGuardexSpawn,
} from '../executors/gitguardex.js';
import { withStore } from '../util/store.js';

interface SpawnOpts {
  executor: string;
  dryRun?: boolean;
  plan?: string;
  subtask?: string;
  agent?: string;
  sessionId?: string;
  repoRoot?: string;
  gxCommand?: string;
  base?: string;
  verifyCommand?: string;
}

export function registerAgentsCommand(program: Command): void {
  const group = program
    .command('agents')
    .description('Launch Colony plan subtasks through an external executor');

  group
    .command('spawn')
    .description('Spawn a ready Queen subtask through GitGuardex')
    .option('--executor <name>', 'executor backend to use', 'gx')
    .option('--dry-run', 'print the gx agents start command without claiming or spawning')
    .option('--plan <slug>', 'queen plan slug')
    .option('--subtask <index>', 'queen subtask index')
    .option('--agent <agent>', 'agent runtime for gx agents start: codex or claude', 'codex')
    .option('--session-id <id>', 'Colony session id to claim the subtask as')
    .option('--repo-root <path>', 'repo root containing the Queen plan')
    .option('--gx-command <command>', 'GitGuardex command name or path', 'gx')
    .option('--base <branch>', 'base branch passed through to gx agents start')
    .option(
      '--verify-command <command>',
      'verification command included in the launch packet',
      'pnpm --filter @imdeadpool/colony-cli test',
    )
    .action(async (opts: SpawnOpts) => {
      if (opts.executor !== 'gx') {
        throw new Error(`unsupported executor: ${opts.executor}`);
      }

      const repoRoot = resolve(opts.repoRoot ?? process.cwd());
      const agent = parseAgent(opts.agent);
      const subtaskIndex = parseSubtaskIndex(opts.subtask);
      const sessionId = opts.sessionId ?? process.env.COLONY_SESSION_ID ?? `colony-cli-${agent}`;
      const settings = loadSettings();

      await withStore(settings, (store) => {
        const plan = buildGitGuardexSpawnPlan(store, {
          repoRoot,
          ...(opts.plan !== undefined ? { planSlug: opts.plan } : {}),
          ...(subtaskIndex !== undefined ? { subtaskIndex } : {}),
          agent,
          sessionId,
          command: opts.gxCommand ?? 'gx',
          ...(opts.base !== undefined ? { base: opts.base } : {}),
          ...(opts.verifyCommand !== undefined ? { verificationCommand: opts.verifyCommand } : {}),
        });

        if (opts.dryRun === true) {
          process.stdout.write(`${kleur.green('✓')} GitGuardex executor ready`);
          if (plan.availability.version !== undefined) {
            process.stdout.write(` ${plan.availability.version}`);
          }
          process.stdout.write('\n');
          process.stdout.write('gx agents start command:\n');
          process.stdout.write(`${plan.commandLine}\n\n`);
          process.stdout.write('full agent prompt:\n');
          process.stdout.write(`${plan.launchPacket.agent_prompt}\n`);
          return;
        }

        if (plan.target !== null) {
          claimGitGuardexSpawnTarget(store, plan, {
            repoRoot,
            planSlug: plan.target.plan.plan_slug,
            subtaskIndex: plan.target.subtask.subtask_index,
            agent,
            sessionId,
            command: opts.gxCommand ?? 'gx',
            ...(opts.base !== undefined ? { base: opts.base } : {}),
            ...(opts.verifyCommand !== undefined
              ? { verificationCommand: opts.verifyCommand }
              : {}),
          });
        }

        const result = runGitGuardexSpawn(plan, { cwd: repoRoot });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        if (result.error !== undefined) {
          throw result.error;
        }
        if (result.status !== 0) {
          process.stderr.write('\nGitGuardex launch packet for manual paste:\n');
          process.stderr.write(`${plan.launchPacket.agent_prompt}\n`);
          process.exitCode = result.status ?? 1;
        }
      });
    });
}

function parseAgent(value: string | undefined): GitGuardexAgent {
  if (value === 'codex' || value === 'claude') return value;
  throw new Error('--agent must be codex or claude');
}

function parseSubtaskIndex(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value) {
    throw new Error('--subtask must be a non-negative integer');
  }
  return parsed;
}
