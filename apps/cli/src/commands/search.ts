import { loadSettings } from '@colony/config';
import { createEmbedder } from '@colony/embedding';
import type { Command } from 'commander';
import kleur from 'kleur';
import { withStore } from '../util/store.js';

export function registerSearchCommand(program: Command): void {
  program
    .command('search <query>')
    .description('Query memory from the terminal')
    .option('--limit <n>', 'max results', '10')
    .option('--no-semantic', 'disable semantic re-rank, use BM25 only')
    .option('--rust', 'require the Rust full-text sidecar for this search')
    .option('--no-rust', 'disable the Rust full-text sidecar for this search')
    .action(async (query: string, opts: { limit: string; semantic: boolean; rust?: boolean }) => {
      const settings = loadSettings();
      await withStore(
        settings,
        async (store) => {
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
          const rustMode =
            opts.rust === true
              ? ('required' as const)
              : opts.rust === false
                ? ('off' as const)
                : undefined;
          const searchOptions = rustMode ? { rust: rustMode } : undefined;
          const hits = await store.search(
            query,
            Number(opts.limit),
            embedder,
            undefined,
            searchOptions,
          );
          for (const h of hits) {
            process.stdout.write(
              `${h.id}\t${h.score.toFixed(3)}\t${h.session_id}\t${h.snippet.replace(/\s+/g, ' ')}\n`,
            );
          }
        },
        { readonly: true },
      );
    });
}
