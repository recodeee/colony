import { resolve } from 'node:path';
import { loadSettings } from '@colony/config';
import type { Command } from 'commander';
import kleur from 'kleur';
import {
  type GitGuardexAgent,
  defaultCockpitSessionName,
  nextReadySpawnCommands,
  runGitGuardexCockpit,
} from '../lib/gitguardex.js';
import { withStore } from '../util/store.js';

interface CockpitOptions {
  repoRoot?: string;
  session?: string;
  dryRun?: boolean;
  agent?: string;
  base?: string;
  json?: boolean;
}

export function registerCockpitCommand(program: Command): void {
  program
    .command('cockpit')
    .description('Open a GitGuardex cockpit for Colony-managed plan lanes')
    .option('--repo-root <path>', 'Repo root (defaults to process.cwd())')
    .option('--session <name>', 'tmux session name (default colony-<repo-slug>)')
    .option('--agent <agent>', 'Agent shown in next spawn commands', 'codex')
    .option('--base <branch>', 'Base branch shown in next spawn commands', 'main')
    .option('--dry-run', 'Print the gx cockpit command and ready subtask spawn commands')
    .option('--json', 'Emit structured JSON')
    .action(async (opts: CockpitOptions) => {
      const repoRoot = resolve(opts.repoRoot ?? process.cwd());
      const sessionName = opts.session ?? defaultCockpitSessionName(repoRoot);
      const agent = parseAgent(opts.agent);
      const settings = loadSettings();
      await withStore(settings, (store) => {
        const result = runGitGuardexCockpit({
          repoRoot,
          sessionName,
          dryRun: opts.dryRun === true,
        });
        const next = nextReadySpawnCommands(store, repoRoot, agent, opts.base ?? 'main');
        if (opts.json === true) {
          process.stdout.write(`${JSON.stringify({ ...result, next_spawn_commands: next }, null, 2)}\n`);
          return;
        }
        const lines = [
          result.dry_run ? kleur.green('gitguardex cockpit dry-run') : kleur.green('gitguardex cockpit'),
          `command: ${result.command}`,
        ];
        if (result.stdout) lines.push('', result.stdout.trimEnd());
        lines.push('', 'next ready spawn commands:');
        if (next.length === 0) lines.push('  no ready Colony plan subtasks');
        else lines.push(...next.map((command) => `  ${command}`));
        process.stdout.write(`${lines.join('\n')}\n`);
      });
    });
}

function parseAgent(value: string | undefined): GitGuardexAgent {
  if (value === 'codex' || value === 'claude') return value;
  throw new Error(`--agent must be codex or claude, got ${value ?? '(missing)'}`);
}
