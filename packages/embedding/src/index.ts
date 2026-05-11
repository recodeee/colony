import { join } from 'node:path';
import { type Settings, resolveDataDir } from '@colony/config';
import { createCodexGpuEmbedder } from './providers/codex-gpu.js';
import { createLocalEmbedder } from './providers/local.js';
import { createOllamaEmbedder } from './providers/ollama.js';
import { createOpenAIEmbedder } from './providers/openai.js';
import type { Embedder, EmbeddingFactoryOptions } from './types.js';

export type { Embedder, EmbeddingFactoryOptions };

/**
 * Construct an Embedder from settings, or return null if the provider is
 * "none". Throws on misconfiguration (bad endpoint, missing API key).
 *
 * Callers should cache the result per-process — model loading is expensive
 * (~400–800 ms for local) and we don't want it repeated per search call.
 */
export async function createEmbedder(
  settings: Settings,
  opts: EmbeddingFactoryOptions = {},
): Promise<Embedder | null> {
  const provider = settings.embedding.provider;
  if (provider === 'none') return null;

  const log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
  const cacheDir = opts.cacheDir ?? join(resolveDataDir(settings.dataDir), 'models');
  const model = settings.embedding.model;

  switch (provider) {
    case 'local':
      return createLocalEmbedder(model, { cacheDir, log });
    case 'ollama':
      return createOllamaEmbedder(model, settings.embedding.endpoint, { log });
    case 'openai':
      return createOpenAIEmbedder(model, settings.embedding.endpoint, settings.embedding.apiKey, {
        log,
      });
    case 'codex-gpu':
      return createCodexGpuEmbedder(model, settings.embedding.endpoint, { log });
    default: {
      // Exhaustiveness check — if a new provider is added to the schema, this
      // throws at runtime so tests catch it immediately.
      const _never: never = provider;
      throw new Error(`Unknown embedding provider: ${String(_never)}`);
    }
  }
}
