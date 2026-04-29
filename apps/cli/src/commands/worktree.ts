import { readWorktreeContentionReport } from '@colony/core';
import type { Command } from 'commander';
import kleur from 'kleur';

interface WorktreeContentionCommandOptions {
  repoRoot?: string;
  json?: boolean;
}

export function registerWorktreeCommand(program: Command): void {
  const worktree = program.command('worktree').description('Inspect managed worktrees');

  worktree
    .command('contention')
    .description('Report dirty-file contention across managed worktrees')
    .option('--repo-root <path>', 'Repository root to inspect')
    .option('--json', 'Emit JSON output')
    .action((options: WorktreeContentionCommandOptions) => {
      const report = readWorktreeContentionReport(
        options.repoRoot ? { repoRoot: options.repoRoot } : {},
      );
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return;
      }

      renderHumanReport(report);
    });
}

function renderHumanReport(report: ReturnType<typeof readWorktreeContentionReport>): void {
  process.stdout.write(`${kleur.bold('Worktree contention')}\n\n`);
  process.stdout.write(`repo: ${report.repo_root}\n`);
  process.stdout.write(`managed worktrees: ${report.summary.worktree_count}\n`);
  process.stdout.write(`dirty worktrees: ${report.summary.dirty_worktree_count}\n`);
  process.stdout.write(`contentions: ${report.summary.contention_count}\n`);

  if (report.contentions.length === 0) {
    process.stdout.write('\nNo same-file dirty contention found.\n');
    return;
  }

  process.stdout.write('\nDirty file contention:\n');
  for (const contention of report.contentions) {
    process.stdout.write(`- ${kleur.yellow(contention.file_path)}\n`);
    for (const worktree of contention.worktrees) {
      const session = worktree.active_session_key ? ` session=${worktree.active_session_key}` : '';
      const claimed = worktree.claimed ? ' claimed' : '';
      process.stdout.write(`  ${worktree.branch} ${worktree.dirty_status}${claimed}${session}\n`);
    }
  }
}
