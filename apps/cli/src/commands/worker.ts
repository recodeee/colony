import { join } from 'node:path';
import { loadSettings, resolveDataDir } from '@colony/config';
import {
  isAlive,
  readPidFile,
  removePidFile,
  spawnNodeScript,
  writePidFile,
} from '@colony/process';
import type { Command } from 'commander';
import kleur from 'kleur';
import { resolveCliPath } from '../util/resolve.js';

function pidFile(): string {
  return join(resolveDataDir(loadSettings().dataDir), 'worker.pid');
}

export function registerWorkerCommand(program: Command): void {
  const w = program.command('worker').description('Manage local worker daemon');

  w.command('start')
    .description('Start the worker in the background')
    .action(async () => {
      const pf = pidFile();
      const existing = readPidFile(pf);
      if (existing !== null) {
        if (isAlive(existing)) {
          process.stdout.write(`${kleur.yellow('already running')} (pid ${existing})\n`);
          return;
        }
        removePidFile(pf);
      }
      const child = spawnNodeScript(resolveCliPath(), ['worker', 'run']);
      if (child.pid) writePidFile(pf, child.pid);
      process.stdout.write(`${kleur.green('started')} (pid ${child.pid})\n`);
    });

  w.command('run')
    .description('Run the worker in the foreground (internal)')
    .action(async () => {
      const mod = await import('@colony/worker');
      await mod.start();
    });

  w.command('stop')
    .description('Stop the worker daemon')
    .action(async () => {
      const pf = pidFile();
      const pid = readPidFile(pf);
      if (pid === null) {
        process.stdout.write(`${kleur.dim('not running')}\n`);
        return;
      }
      try {
        process.kill(pid);
        process.stdout.write(`${kleur.green('stopped')} (pid ${pid})\n`);
      } catch (e) {
        process.stdout.write(`${kleur.yellow('stale pidfile')} ${String(e)}\n`);
      } finally {
        removePidFile(pf);
      }
    });

  w.command('status')
    .description('Show worker status')
    .action(async () => {
      const pf = pidFile();
      const pid = readPidFile(pf);
      if (pid === null) {
        process.stdout.write(`${kleur.dim('not running')}\n`);
        return;
      }
      process.stdout.write(
        `${isAlive(pid) ? kleur.green('running') : kleur.red('dead')} (pid ${pid})\n`,
      );
    });
}
