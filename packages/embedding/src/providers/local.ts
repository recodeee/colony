import type { Embedder, EmbeddingFactoryOptions } from '../types.js';

// Known model dimensions — lets callers build an Embedder without waiting for
// the first embed() call to discover dim. If the model isn't in this table,
// the loader infers dim from the first embed call and caches it on the instance.
const MODEL_DIMS: Record<string, number> = {
  'Xenova/all-MiniLM-L6-v2': 384,
  'Xenova/all-MiniLM-L12-v2': 384,
  'Xenova/all-mpnet-base-v2': 768,
  'Xenova/bge-small-en-v1.5': 384,
  'Xenova/bge-base-en-v1.5': 768,
  'Xenova/gte-small': 384,
  'Xenova/gte-base': 768,
};

/**
 * Local embedder backed by @xenova/transformers. Imports the package lazily
 * so installations with provider="none" or a remote provider don't pay the
 * ONNX runtime cost just to load the config.
 */
export async function createLocalEmbedder(
  model: string,
  opts: EmbeddingFactoryOptions = {},
): Promise<Embedder> {
  const log = opts.log ?? (() => {});
  log(`[cavemem:embed] loading local model ${model}`);
  const transformers = (await import('@xenova/transformers').catch((err) => {
    throw new Error(
      `Local embedding provider requires @xenova/transformers. Install it or set embedding.provider to 'none'. (${String(
        err,
      )})`,
    );
  })) as typeof import('@xenova/transformers');

  if (opts.cacheDir) {
    transformers.env.cacheDir = opts.cacheDir;
    // Let the model load from disk without hitting the Hub if already cached.
    transformers.env.allowLocalModels = true;
  }

  const extractor = await transformers.pipeline('feature-extraction', model, {
    quantized: true,
  });

  let dim = MODEL_DIMS[model] ?? 0;

  const embed = async (text: string): Promise<Float32Array> => {
    const out = await extractor(text, { pooling: 'mean', normalize: true });
    // Tensor.data is a typed array — for mean-pooled sentence embeddings it's
    // a single row whose length === dim. Copy into a dense Float32Array the
    // storage layer can persist directly.
    const data = (out as { data: ArrayLike<number> }).data;
    const vec = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) vec[i] = data[i] ?? 0;
    if (dim === 0) dim = vec.length;
    return vec;
  };

  // Force one warm-up embed so dim is known before first real call — keeps
  // the Embedder contract honest (dim is readonly and must be correct).
  if (dim === 0) {
    const probe = await embed(' ');
    dim = probe.length;
  }

  return {
    model,
    get dim() {
      return dim;
    },
    embed,
  };
}
