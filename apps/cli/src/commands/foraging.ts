import { loadSettings } from '@colony/config';
import type { MemoryStore } from '@colony/core';
import { buildIntegrationPlan, expandForagingConceptQuery, scanExamples } from '@colony/foraging';
import type { Command } from 'commander';
import kleur from 'kleur';
import { withStore } from '../util/store.js';

const FORAGING_SESSION_ID = 'foraging';

/**
 * The foraging session owns every `foraged-pattern` observation. It's a
 * fixed session id (not per-invocation) so repeat scans land on the same
 * row and session-wide cleanups ("drop everything foraging ever wrote")
 * stay trivial.
 */
function ensureForagingSession(store: MemoryStore): void {
  store.startSession({
    id: FORAGING_SESSION_ID,
    ide: 'foraging',
    cwd: process.cwd(),
  });
}

export function registerForagingCommand(program: Command): void {
  program
    .command('examples_query <query>')
    .description('Search example concepts with compact foraged hits')
    .option('--repo-root <path>', 'Repo root to scan/query (defaults to process.cwd())')
    .option('--example-name <name>', 'Scope search to one example')
    .option('--limit <n>', 'max results', '10')
    .option('--json', 'Emit JSON')
    .action(
      async (
        query: string,
        opts: { repoRoot?: string; exampleName?: string; limit: string; json?: boolean },
      ) => {
        const settings = loadSettings();
        const repo_root = opts.repoRoot ?? process.cwd();
        await withStore(settings, async (store) => {
          scanRepoIfEnabled(settings, store, repo_root);
          const filter: { kind: string; metadata?: Record<string, string> } = {
            kind: 'foraged-pattern',
          };
          const metadata: Record<string, string> = { repo_root };
          if (opts.exampleName) metadata.example_name = opts.exampleName;
          filter.metadata = metadata;
          const hits = await store.search(
            expandForagingConceptQuery(query),
            Number(opts.limit),
            undefined,
            filter,
          );
          const compact = enrichForagingHits(store, hits);
          if (opts.json) {
            process.stdout.write(`${JSON.stringify(compact)}\n`);
            return;
          }
          for (const h of compact) {
            process.stdout.write(
              `${h.id}\t${h.score.toFixed(3)}\t${h.example_name ?? ''}\t${h.file_path ?? ''}\t${h.snippet.replace(/\s+/g, ' ')}\n`,
            );
          }
        });
      },
    );

  program
    .command('examples_integrate_plan <example_name>')
    .description('Plan concept ports from an indexed example')
    .option('--repo-root <path>', 'Repo root to scan/plan (defaults to process.cwd())')
    .option('--target-hint <path>', 'Target package manifest path')
    .option('--json', 'Emit JSON')
    .action(
      async (
        example_name: string,
        opts: { repoRoot?: string; targetHint?: string; json?: boolean },
      ) => {
        const settings = loadSettings();
        const repo_root = opts.repoRoot ?? process.cwd();
        await withStore(settings, async (store) => {
          scanRepoIfEnabled(settings, store, repo_root);
          const plan = buildIntegrationPlan(store.storage, {
            repo_root,
            example_name,
            ...(opts.targetHint !== undefined ? { target_hint: opts.targetHint } : {}),
          });
          if (opts.json) {
            process.stdout.write(`${JSON.stringify(plan)}\n`);
            return;
          }
          process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
        });
      },
    );

  const group = program
    .command('foraging')
    .description('Index and query <repo_root>/examples food sources');

  group
    .command('scan')
    .description('Scan <cwd>/examples for changed food sources and re-index them')
    .option('--cwd <path>', 'Repo root to scan (defaults to process.cwd())')
    .action(async (opts: { cwd?: string }) => {
      const settings = loadSettings();
      if (!settings.foraging.enabled) {
        process.stdout.write(`${kleur.yellow('foraging disabled')} — set foraging.enabled true\n`);
        return;
      }
      const repo_root = opts.cwd ?? process.cwd();
      await withStore(settings, (store) => {
        ensureForagingSession(store);
        const result = scanExamples({
          repo_root,
          store,
          session_id: FORAGING_SESSION_ID,
          limits: {
            max_depth: settings.foraging.maxDepth,
            max_file_bytes: settings.foraging.maxFileBytes,
            max_files_per_source: settings.foraging.maxFilesPerSource,
          },
          extra_secret_env_names: settings.foraging.extraSecretEnvNames,
        });
        const changed = result.scanned.length - result.skipped_unchanged;
        process.stdout.write(
          `${kleur.green('✓')} foraging: ${result.scanned.length} source(s), ${changed} re-indexed, ${result.skipped_unchanged} skipped (unchanged), ${result.indexed_observations} observation(s)\n`,
        );
      });
    });

  group
    .command('list')
    .description('List indexed example food sources')
    .option('--cwd <path>', 'Repo root to list (defaults to process.cwd())')
    .action(async (opts: { cwd?: string }) => {
      const settings = loadSettings();
      const repo_root = opts.cwd ?? process.cwd();
      await withStore(settings, (store) => {
        const rows = store.storage.listExamples(repo_root);
        if (rows.length === 0) {
          process.stdout.write(
            `${kleur.gray('no indexed examples — run `colony foraging scan`')}\n`,
          );
          return;
        }
        for (const r of rows) {
          const when = new Date(r.last_scanned_at).toISOString().slice(0, 19).replace('T', ' ');
          process.stdout.write(
            `  ${kleur.cyan(r.example_name.padEnd(28))} ${kleur.dim((r.manifest_kind ?? 'unknown').padEnd(8))} ${r.observation_count} obs  ${kleur.dim(when)}\n`,
          );
        }
      });
    });

  group
    .command('clear')
    .description('Delete indexed example rows (and their foraged observations)')
    .option('--cwd <path>', 'Repo root to clear (defaults to process.cwd())')
    .option('--example <name>', 'Clear a single example rather than all of them')
    .action(async (opts: { cwd?: string; example?: string }) => {
      const settings = loadSettings();
      const repo_root = opts.cwd ?? process.cwd();
      await withStore(settings, (store) => {
        const targets = opts.example
          ? store.storage.listExamples(repo_root).filter((r) => r.example_name === opts.example)
          : store.storage.listExamples(repo_root);
        if (targets.length === 0) {
          process.stdout.write(`${kleur.gray('nothing to clear')}\n`);
          return;
        }
        let dropped = 0;
        for (const row of targets) {
          dropped += store.storage.deleteForagedObservations(repo_root, row.example_name);
          store.storage.deleteExample(repo_root, row.example_name);
        }
        process.stdout.write(
          `${kleur.green('✓')} cleared ${targets.length} example(s), dropped ${dropped} observation(s)\n`,
        );
      });
    });
}

function enrichForagingHits(
  store: MemoryStore,
  hits: Array<{
    id: number;
    score: number;
    snippet: string;
  }>,
): Array<{
  id: number;
  score: number;
  snippet: string;
  example_name?: string;
  file_path?: string;
  entry_kind?: string;
  concept_tags?: string[];
}> {
  const rows = store.storage.getObservations(hits.map((h) => h.id));
  const metadataById = new Map<number, Record<string, unknown>>();
  for (const row of rows) {
    if (!row.metadata) continue;
    try {
      metadataById.set(row.id, JSON.parse(row.metadata) as Record<string, unknown>);
    } catch {}
  }
  return hits.map((h) => {
    const md = metadataById.get(h.id);
    const conceptTags = Array.isArray(md?.concept_tags)
      ? md.concept_tags.filter((tag): tag is string => typeof tag === 'string')
      : undefined;
    return {
      id: h.id,
      score: h.score,
      snippet: h.snippet,
      ...(typeof md?.example_name === 'string' ? { example_name: md.example_name } : {}),
      ...(typeof md?.file_path === 'string' ? { file_path: md.file_path } : {}),
      ...(typeof md?.entry_kind === 'string' ? { entry_kind: md.entry_kind } : {}),
      ...(conceptTags ? { concept_tags: conceptTags } : {}),
    };
  });
}

function scanRepoIfEnabled(
  settings: ReturnType<typeof loadSettings>,
  store: MemoryStore,
  repo_root: string,
): void {
  if (!settings.foraging.enabled) return;
  ensureForagingSession(store);
  scanExamples({
    repo_root,
    store,
    session_id: FORAGING_SESSION_ID,
    limits: {
      max_depth: settings.foraging.maxDepth,
      max_file_bytes: settings.foraging.maxFileBytes,
      max_files_per_source: settings.foraging.maxFilesPerSource,
    },
    extra_secret_env_names: settings.foraging.extraSecretEnvNames,
  });
}
