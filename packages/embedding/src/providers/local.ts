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
  log(`[colony:embed] loading local model ${model}`);
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

  const embedBatch = async (texts: readonly string[]): Promise<Float32Array[]> => {
    const input = texts.length === 1 ? (texts[0] ?? '') : [...texts];
    const out = await extractor(input, {
      pooling: 'mean',
      normalize: true,
    });
    // Tensor.data is a typed array — for mean-pooled sentence embeddings it's
    // one row per input. Copy into dense Float32Array rows the storage layer
    // can persist directly.
    const tensor = out as { data: ArrayLike<number>; dims?: number[] };
    const data = tensor.data;
    const inferredDim =
      texts.length > 1 && tensor.dims && tensor.dims.length >= 2
        ? (tensor.dims.at(-1) ?? 0)
        : data.length;
    if (dim === 0) dim = inferredDim;
    const rowDim = dim || inferredDim;
    if (rowDim <= 0 || data.length !== texts.length * rowDim) {
      throw new Error(`Local embedder returned ${data.length} values for ${texts.length} inputs`);
    }
    const vectors: Float32Array[] = [];
    for (let row = 0; row < texts.length; row++) {
      const vec = new Float32Array(rowDim);
      const offset = row * rowDim;
      for (let i = 0; i < rowDim; i++) vec[i] = data[offset + i] ?? 0;
      vectors.push(vec);
    }
    return vectors;
  };

  const embed = async (text: string): Promise<Float32Array> => {
    const [vec] = await embedBatch([text]);
    if (!vec) throw new Error('Local embedder returned no vector');
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
    embedBatch,
  };
}
