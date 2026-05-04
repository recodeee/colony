import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadSettings, resolveDataDir, settingsPath } from '@colony/config';
import type { Command } from 'commander';
import kleur from 'kleur';
import {
  type GitGuardexColonyClaim,
  type GitGuardexLanesPayload,
  collectGitGuardexColonyClaims,
  formatGitGuardexLanesOutput,
  readGitGuardexLanes,
} from '../lib/gitguardex.js';
import { dataDbPath, withStorage } from '../util/store.js';

interface WorkerState {
  provider?: string;
  model?: string;
  dim?: number;
  embedded?: number;
  total?: number;
  lastBatchAt?: number | null;
  lastBatchMs?: number | null;
  lastError?: string | null;
  startedAt?: number;
}

interface StatusPayload {
  settings: {
    path: string;
    exists: boolean;
  };
  data_dir: string;
  db: {
    path: string;
    status: 'ok' | 'fail';
    observations: number;
    sessions: number;
    error: string | null;
  };
  ides: string[];
  embedding: {
    provider: string;
    model: string;
    worker_state: WorkerState | null;
  };
  worker: {
    status: 'running' | 'stale_pidfile' | 'not_running';
    pid: number | null;
    port: number;
  };
  gitguardex_lanes: GitGuardexLanesPayload;
}

function readWorkerState(dir: string): WorkerState | null {
  const p = join(dir, 'worker.state.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as WorkerState;
  } catch {
    return null;
  }
}

function readPid(dir: string): number | null {
  const p = join(dir, 'worker.pid');
  if (!existsSync(p)) return null;
  const n = Number(readFileSync(p, 'utf8').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fmtAgo(ts: number | null | undefined): string {
  if (!ts) return kleur.dim('never');
  const ms = Date.now() - ts;
  if (ms < 1000) return `${ms}ms ago`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show colony wiring, data, and worker state')
    .option('--json', 'emit structured JSON')
    .option('--repo-root <path>', 'repo root for GitGuardex lane status (defaults to cwd)')
    .action(async (opts: { json?: boolean; repoRoot?: string }) => {
      const sp = settingsPath();
      const settings = loadSettings();
      const dir = resolveDataDir(settings.dataDir);
      const dbPath = dataDbPath(settings);
      const repoRoot = resolve(opts.repoRoot ?? process.cwd());

      let obsCount = 0;
      let sessCount = 0;
      let dbError: string | null = null;
      let colonyClaims: GitGuardexColonyClaim[] = [];
      try {
        await withStorage(settings, (s) => {
          obsCount = s.countObservations();
          sessCount = s.listSessions(10_000).length;
          const tasks = s.listTasks(2000);
          colonyClaims = collectGitGuardexColonyClaims(tasks, (taskId) => s.listClaims(taskId));
        });
      } catch (err) {
        dbError = String(err);
        process.exitCode = 1;
      }

      const enabled = Object.entries(settings.ides)
        .filter(([, v]) => v)
        .map(([k]) => k);
      const state = readWorkerState(dir);
      const provider = settings.embedding.provider;
      const model = settings.embedding.model;
      const pid = readPid(dir);
      const workerStatus = pid && isAlive(pid) ? 'running' : pid ? 'stale_pidfile' : 'not_running';
      const gitguardexLanes = readGitGuardexLanes({
        cwd: repoRoot,
        colony_claims: colonyClaims,
      });
      const payload: StatusPayload = {
        settings: {
          path: sp,
          exists: existsSync(sp),
        },
        data_dir: dir,
        db: {
          path: dbPath,
          status: dbError === null ? 'ok' : 'fail',
          observations: obsCount,
          sessions: sessCount,
          error: dbError,
        },
        ides: enabled,
        embedding: {
          provider,
          model,
          worker_state: state,
        },
        worker: {
          status: workerStatus,
          pid,
          port: settings.workerPort,
        },
        gitguardex_lanes: gitguardexLanes,
      };

      if (opts.json === true) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
      }

      process.stdout.write(`${kleur.bold('colony status')}\n\n`);
      process.stdout.write(
        `settings:   ${sp} ${payload.settings.exists ? kleur.green('✓') : kleur.yellow('default')}\n`,
      );
      process.stdout.write(`data dir:   ${dir}\n`);
      if (payload.db.status === 'ok') {
        process.stdout.write(
          `db:         ${dbPath} ${kleur.green('✓')} (${obsCount} observations, ${sessCount} sessions)\n`,
        );
      } else {
        process.stdout.write(`db:         ${dbPath} ${kleur.red('fail')} ${payload.db.error}\n`);
      }
      process.stdout.write(
        `ides:       ${enabled.length ? enabled.join(', ') : kleur.dim('none installed — try `colony install`')}\n`,
      );
      process.stdout.write(`embedding:  ${provider} / ${model}\n`);
      if (provider === 'none') {
        process.stdout.write(`backfill:   ${kleur.dim('disabled (provider=none)')}\n`);
      } else if (state) {
        const embedded = state.embedded ?? 0;
        const total = state.total ?? obsCount;
        const pct = total > 0 ? Math.round((embedded / total) * 100) : 0;
        const colour = pct === 100 ? kleur.green : pct > 0 ? kleur.yellow : kleur.dim;
        process.stdout.write(
          `backfill:   ${colour(`${embedded} / ${total}`)} (${pct}%)  last batch ${fmtAgo(state.lastBatchAt)}\n`,
        );
        if (state.lastError) {
          process.stdout.write(`  ${kleur.red('error:')} ${state.lastError}\n`);
          const remediation = embeddingRemediation(provider, state.lastError);
          if (remediation) process.stdout.write(`  ${kleur.yellow('fix:')} ${remediation}\n`);
        }
      } else {
        process.stdout.write(
          `backfill:   ${kleur.dim('no worker state yet — run `colony start`')}\n`,
        );
      }
      if (workerStatus === 'running' && pid) {
        const uptime = state?.startedAt ? fmtAgo(state.startedAt).replace(' ago', '') : '?';
        process.stdout.write(
          `worker:     ${kleur.green('running')} (pid ${pid}, up ${uptime})  http://127.0.0.1:${settings.workerPort}\n`,
        );
      } else if (workerStatus === 'stale_pidfile' && pid) {
        process.stdout.write(`worker:     ${kleur.red('stale pidfile')} (pid ${pid})\n`);
      } else {
        process.stdout.write(
          `worker:     ${kleur.dim('not running')} — starts automatically on next hook\n`,
        );
      }
      process.stdout.write(`\n${kleur.bold('GitGuardex lanes')}\n`);
      process.stdout.write(`${formatGitGuardexLanesOutput(gitguardexLanes).join('\n')}\n`);
    });
}

function embeddingRemediation(provider: string, error: string): string | null {
  if (provider === 'local' && /@xenova\/transformers|transformers/i.test(error)) {
    return 'local provider requires @xenova/transformers — install it or switch embedding.provider to none, ollama, or openai.';
  }
  return null;
}
