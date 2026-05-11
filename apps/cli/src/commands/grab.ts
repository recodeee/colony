import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadSettings, resolveDataDir } from '@colony/config';
import { MemoryStore } from '@colony/core';
import type { Command } from 'commander';
import kleur from 'kleur';
import { startGrabServer } from '../lib/grab/server.js';
import type { GrabServeConfig } from '../lib/grab/types.js';
import { dataDbPath } from '../util/store.js';

const DEFAULT_DEDUP_WINDOW_MS = 5 * 60 * 1000;

interface ServeOptions {
  port?: string;
  token?: string;
  origin?: string[];
  repo?: string;
  tier?: string;
  dedupMs?: string;
}

const parseTier = (raw: string | undefined): GrabServeConfig['tier'] => {
  switch (raw) {
    case 'T0':
    case 'T1':
    case 'T2':
    case 'T3':
      return raw;
    case undefined:
      return 'T1';
    default:
      throw new Error(`--tier must be one of T0|T1|T2|T3, got: ${raw}`);
  }
};

const parsePort = (raw: string | undefined): number => {
  if (raw === undefined) return 0; // 0 = OS-assigned free port
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`--port must be an integer in [0, 65535], got: ${raw}`);
  }
  return n;
};

const collectOrigin = (value: string, previous: string[] = []): string[] => [...previous, value];

export function registerGrabCommand(program: Command): void {
  const g = program
    .command('grab')
    .description('react-grab localhost intake — receive submits, create tasks, spawn codex');

  g.command('serve')
    .description('Run the grab daemon: accept POST /grab and spawn codex in a fresh agent worktree')
    .option('-p, --port <port>', 'bind port (default: random free port)')
    .option('-t, --token <token>', 'bearer token (default: random 32 bytes hex)')
    .option(
      '-o, --origin <origin>',
      'allowed Origin (repeatable); default http://localhost:5173,http://localhost:3000',
      collectOrigin,
      [] as string[],
    )
    .option('-r, --repo <path>', 'project root the daemon serves (default: cwd)')
    .option('--tier <tier>', 'gx tier for spawned worktrees (T0|T1|T2|T3, default: T1)')
    .option('--dedup-ms <ms>', `dedup window in milliseconds (default: ${DEFAULT_DEDUP_WINDOW_MS})`)
    .action(async (opts: ServeOptions) => {
      const settings = loadSettings();
      const repoRoot = resolve(opts.repo ?? process.cwd());
      if (!existsSync(repoRoot)) {
        process.stderr.write(`grab: --repo path does not exist: ${repoRoot}\n`);
        process.exit(1);
      }
      const token = opts.token ?? randomBytes(32).toString('hex');
      const originList =
        opts.origin && opts.origin.length > 0
          ? opts.origin
          : ['http://localhost:5173', 'http://localhost:3000'];
      const config: GrabServeConfig = {
        repoRoot,
        port: parsePort(opts.port),
        token,
        originAllowlist: originList,
        dedupWindowMs: opts.dedupMs ? Number.parseInt(opts.dedupMs, 10) : DEFAULT_DEDUP_WINDOW_MS,
        colonyHome: resolveDataDir(settings.dataDir),
        tier: parseTier(opts.tier),
      };

      const store = new MemoryStore({ dbPath: dataDbPath(settings), settings });
      const handle = await startGrabServer(config, store);

      const shutdown = async (signal: string) => {
        process.stderr.write(`[grab] received ${signal}, shutting down\n`);
        try {
          await handle.stop();
        } finally {
          store.close();
          process.exit(0);
        }
      };
      process.on('SIGINT', () => void shutdown('SIGINT'));
      process.on('SIGTERM', () => void shutdown('SIGTERM'));

      // The token is printed once to stdout in JSON; the daemon's own log
      // stream never echoes the raw token, only its fingerprint.
      process.stdout.write(
        `${JSON.stringify({
          event: 'grab.ready',
          url: handle.url,
          port: handle.port,
          fingerprint: handle.fingerprint,
          token,
          repo: repoRoot,
          origins: originList,
        })}\n`,
      );
    });

  g.command('attach <task-id>')
    .description('Attach to the tmux session spawned for a grab task')
    .action((taskId: string) => {
      const id = Number.parseInt(taskId, 10);
      if (!Number.isInteger(id) || id <= 0) {
        process.stderr.write(`grab attach: task-id must be a positive integer, got: ${taskId}\n`);
        process.exit(1);
      }
      const session = `rg-${id}`;
      const child = spawn('tmux', ['attach-session', '-t', session], { stdio: 'inherit' });
      child.on('exit', (code) => process.exit(code ?? 0));
    });

  g.command('status')
    .description('List grab daemons known to this $COLONY_HOME')
    .action(() => {
      const settings = loadSettings();
      const stateDir = join(resolveDataDir(settings.dataDir), 'grab');
      if (!existsSync(stateDir)) {
        process.stdout.write(`${kleur.dim('no grab daemons known')}\n`);
        return;
      }
      const files = readdirSync(stateDir).filter((f) => f.endsWith('.json'));
      if (files.length === 0) {
        process.stdout.write(`${kleur.dim('no grab daemons known')}\n`);
        return;
      }
      for (const file of files) {
        try {
          const raw = JSON.parse(readFileSync(join(stateDir, file), 'utf8')) as {
            port: number;
            repoRoot: string;
            tokenFingerprint: string;
            started: number;
          };
          process.stdout.write(
            `${kleur.cyan(raw.tokenFingerprint)} ${kleur.dim('port=')}${raw.port} ` +
              `${kleur.dim('repo=')}${raw.repoRoot} ` +
              `${kleur.dim('started=')}${new Date(raw.started).toISOString()}\n`,
          );
        } catch (err) {
          process.stderr.write(`grab status: bad state file ${file}: ${String(err)}\n`);
        }
      }
    });
}
