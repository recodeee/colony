import { loadSettings, resolveDataDir } from '@colony/config';
import { Storage } from '@colony/storage';
import type { Command } from 'commander';
import kleur from 'kleur';

/**
 * Refresh cadence. Three seconds is a compromise: fast enough that new
 * claims show up while you're still looking at the screen, slow enough
 * that the redraw flicker isn't distracting in peripheral vision.
 */
const REFRESH_MS = 3000;

const OBSERVATION_LIMIT = 50;

export function renderFrame(storage: Storage): string {
  return storage
    .recentObservations(OBSERVATION_LIMIT)
    .map((row) => {
      const ts = new Date(row.ts).toISOString().slice(11, 19);
      const session = colorSession(row.session_id)(row.session_id.slice(0, 8).padEnd(8));
      const kind = row.kind.padEnd(15);
      const snippet = row.content.replace(/\s+/g, ' ').trim().slice(0, 50);
      return `${kleur.dim(ts)}  ${session}  ${kind} ${snippet}`;
    })
    .join('\n');
}

function colorSession(sessionId: string): (value: string) => string {
  const palette = [kleur.cyan, kleur.magenta, kleur.yellow, kleur.green, kleur.blue, kleur.red];
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = (hash * 31 + sessionId.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length] ?? kleur.white;
}

export function registerObserveCommand(program: Command): void {
  program
    .command('observe')
    .description('Live dashboard of collaboration state. Run in a spare terminal during a session.')
    .option('--interval <ms>', 'Refresh interval in milliseconds', String(REFRESH_MS))
    .action((opts: { interval: string }) => {
      const settings = loadSettings();
      const dataDir = resolveDataDir(settings.dataDir).replace(/[\\/]+$/, '');
      const dbPath = `${dataDir}/data.db`;
      const storage = new Storage(dbPath);
      const intervalMs = Math.max(500, Number(opts.interval));

      // \x1b[3J clears scrollback where supported, \x1b[2J clears the
      // visible screen, and \x1b[H sends the cursor home. Minimal
      // cross-platform approach — avoids heavyweight `blessed`/`ink` deps
      // for what is ultimately a glorified printf loop.
      const paint = () => {
        process.stdout.write('\x1b[3J\x1b[H\x1b[2J');
        process.stdout.write(renderFrame(storage));
        process.stdout.write(`\n\n${kleur.dim(`refresh ${intervalMs}ms · ctrl-c to exit`)}\n`);
      };

      paint();
      const handle = setInterval(paint, intervalMs);

      const stop = () => {
        clearInterval(handle);
        storage.close();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
}
