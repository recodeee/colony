import { join } from 'node:path';
import { loadSettings, resolveDataDir } from '@cavemem/config';
import { MemoryStore } from '@cavemem/core';
import { createEmbedder } from '@cavemem/embedding';
import type { Command } from 'commander';
import kleur from 'kleur';

export function registerSearchCommand(program: Command): void {
  program
    .command('search <query>')
    .description('Query memory from the terminal')
    .option('--limit <n>', 'max results', '10')
    .option('--no-semantic', 'disable semantic re-rank, use BM25 only')
    .action(async (query: string, opts: { limit: string; semantic: boolean }) => {
      const settings = loadSettings();
      const dbPath = join(resolveDataDir(settings.dataDir), 'data.db');
      const store = new MemoryStore({ dbPath, settings });
      try {
        let embedder = undefined;
        if (opts.semantic && settings.embedding.provider !== 'none') {
          const t0 = Date.now();
          try {
            const e = await createEmbedder(settings, { log: () => {} });
            embedder = e ?? undefined;
            const dt = Date.now() - t0;
            if (dt > 500) {
              process.stderr.write(`${kleur.dim(`[embedder loaded in ${dt}ms]`)}\n`);
            }
          } catch (err) {
            process.stderr.write(
              `${kleur.yellow('semantic disabled:')} ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }
        const hits = await store.search(query, Number(opts.limit), embedder);
        for (const h of hits) {
          process.stdout.write(
            `${h.id}\t${h.score.toFixed(3)}\t${h.session_id}\t${h.snippet.replace(/\s+/g, ' ')}\n`,
          );
        }
      } finally {
        store.close();
      }
    });
}
