import type { Embedder, EmbeddingFactoryOptions } from '../types.js';

interface OllamaResponse {
  embedding?: number[];
  embeddings?: number[][];
  error?: string;
}

/**
 * Ollama embedding provider. Requires a running Ollama instance.
 * Endpoint defaults to http://127.0.0.1:11434. Model defaults to
 * "nomic-embed-text" if the configured model doesn't look like an Ollama one;
 * otherwise uses the configured model as-is.
 */
export async function createOllamaEmbedder(
  model: string,
  endpoint: string | undefined,
  opts: EmbeddingFactoryOptions = {},
): Promise<Embedder> {
  const base = (endpoint ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const log = opts.log ?? (() => {});

  let dim = 0;

  const embed = async (text: string): Promise<Float32Array> => {
    const res = await fetch(`${base}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
    });
    if (!res.ok) {
      throw new Error(`Ollama embed failed: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as OllamaResponse;
    if (json.error) throw new Error(`Ollama embed error: ${json.error}`);
    const raw = json.embedding ?? json.embeddings?.[0];
    if (!raw) throw new Error('Ollama response missing embedding field');
    const vec = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) vec[i] = raw[i] ?? 0;
    if (dim === 0) dim = vec.length;
    return vec;
  };

  // Warm-up probe — checks the endpoint is reachable and captures dim.
  log(`[colony:embed] probing ollama at ${base} with model ${model}`);
  const probe = await embed(' ');
  dim = probe.length;

  return {
    model,
    get dim() {
      return dim;
    },
    embed,
  };
}
