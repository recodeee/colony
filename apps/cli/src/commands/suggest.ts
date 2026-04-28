import { loadSettings } from '@colony/config';
import {
  type Embedder,
  type MemoryStore,
  SIMILARITY_FLOOR,
  type SuggestionPayload,
  buildSuggestionPayload,
  findSimilarTasks,
  insufficientSuggestionPayload,
} from '@colony/core';
import { createEmbedder } from '@colony/embedding';
import type { Command } from 'commander';
import kleur from 'kleur';
import { withStore } from '../util/store.js';

type SuggestOptions = {
  repoRoot?: string;
  limit?: string;
  json?: boolean;
};

export function registerSuggestCommand(program: Command): void {
  program
    .command('suggest <description...>')
    .description('Suggest an approach from similar past task history')
    .option('--repo-root <path>', 'scope suggestions to a repository root')
    .option('--limit <n>', 'max similar tasks to inspect', '10')
    .option('--json', 'emit structured JSON')
    .action(async (description: string[], opts: SuggestOptions) => {
      const settings = loadSettings();
      const query = description.join(' ').trim();
      await withStore(settings, async (store) => {
        const payload = await suggestForCli(store, query, {
          limit: Number(opts.limit ?? 10),
          ...(opts.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : {}),
          resolveEmbedder: async () => {
            try {
              return await createEmbedder(settings, { log: () => {} });
            } catch {
              return null;
            }
          },
        });
        process.stdout.write(
          `${formatSuggestionOutput(payload, query, opts.json ? { json: true } : {})}\n`,
        );
      });
    });
}

export async function suggestForCli(
  store: MemoryStore,
  query: string,
  opts: {
    repoRoot?: string;
    limit?: number;
    resolveEmbedder: () => Promise<Embedder | null>;
  },
): Promise<SuggestionPayload> {
  const embedder = await opts.resolveEmbedder();
  if (!embedder) return insufficientSuggestionPayload('embedder unavailable');

  let queryEmbedding: Float32Array;
  try {
    queryEmbedding = await embedder.embed(query);
  } catch {
    return insufficientSuggestionPayload('query embedding failed');
  }
  if (queryEmbedding.length !== embedder.dim) {
    return insufficientSuggestionPayload('query embedding failed');
  }

  const similarTasks = findSimilarTasks(store, embedder, queryEmbedding, {
    min_similarity: SIMILARITY_FLOOR,
    ...(opts.repoRoot !== undefined ? { repo_root: opts.repoRoot } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  });

  return buildSuggestionPayload(store, similarTasks);
}

export function formatSuggestionOutput(
  payload: SuggestionPayload,
  query: string,
  opts: { json?: boolean } = {},
): string {
  if (opts.json) return JSON.stringify(payload, null, 2);
  if (payload.insufficient_data_reason) {
    return kleur.yellow(`No suggestion for "${query}": ${payload.insufficient_data_reason}.`);
  }

  const lines: string[] = [];
  lines.push(`${kleur.bold('colony suggest')}  ${kleur.dim(query)}`);
  lines.push(kleur.dim('─'.repeat(60)));

  lines.push('');
  lines.push(kleur.cyan('Similar tasks:'));
  for (const task of payload.similar_tasks) {
    lines.push(
      `  #${task.task_id} ${task.similarity.toFixed(3)} ${task.status.padEnd(11)} ${task.branch} ${kleur.dim(task.repo_root)}`,
    );
  }

  if (payload.first_files_likely_claimed.length > 0) {
    lines.push('');
    lines.push(kleur.cyan('Files likely claimed first:'));
    for (const file of payload.first_files_likely_claimed) {
      lines.push(
        `  ${file.file_path}  ${kleur.dim(`${file.appears_in_count} task(s), confidence ${file.confidence.toFixed(3)}`)}`,
      );
    }
  }

  if (payload.patterns_to_watch.length > 0) {
    lines.push('');
    lines.push(kleur.yellow('Patterns to watch:'));
    for (const pattern of payload.patterns_to_watch) {
      lines.push(`  ${pattern.kind} in task #${pattern.seen_in_task_id}: ${pattern.description}`);
    }
  }

  if (payload.resolution_hints) {
    const hints = payload.resolution_hints;
    lines.push('');
    lines.push(kleur.cyan('Resolution hints:'));
    lines.push(
      `  median elapsed ${hints.median_elapsed_minutes.toFixed(1)}m; handoffs ${hints.median_handoff_count}; subtasks ${hints.median_subtask_count ?? 'n/a'}; completed sample ${hints.completed_sample_size}`,
    );
  }

  return lines.join('\n');
}
