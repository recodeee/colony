import { spawn } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SpawnPrimitives } from './types.js';

const runCapture = (
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args as string[], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `${command} ${args.join(' ')} exited ${code}: ${(stderr || stdout).slice(0, 800)}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });

/**
 * Real spawn primitives. The grab server takes these via DI so tests can
 * substitute pure mocks and never shell out.
 */
export const realSpawn: SpawnPrimitives = {
  async startWorktree({ repoRoot, slug, tier }) {
    // gx prints `branch: agent/...` and `Worktree: /path/...` lines among
    // other diagnostics; parse both deterministically.
    const { stdout, stderr } = await runCapture(
      'gx',
      ['branch', 'start', '--tier', tier, slug, 'codex'],
      repoRoot,
    );
    const combined = `${stdout}\n${stderr}`;
    const branch = combined.match(/branch:\s+(\S+)/)?.[1];
    const worktree = combined.match(/Worktree:\s+(\S+)/i)?.[1];
    if (!branch || !worktree) {
      throw new Error(
        `could not parse gx branch start output (slug=${slug}): ${combined.slice(0, 800)}`,
      );
    }
    return { branch, worktree };
  },

  async writeIntake(worktree, content) {
    const dir = join(worktree, '.colony');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'INTAKE.md');
    await writeFile(path, content, 'utf8');
    await chmod(path, 0o644);
  },

  async startTmux({ session, cwd }) {
    // Detached session; the user attaches via `colony grab attach <task_id>`.
    // Codex is launched with no initial prompt — INTAKE.md sits in the
    // worktree for codex to pick up on its first message from the user.
    await runCapture('tmux', ['new-session', '-d', '-s', session, '-c', cwd, 'codex'], cwd);
  },
};
