import type { Embedder, EmbeddingFactoryOptions } from '../types.js';

interface CodexGpuResponse {
  vector?: number[];
  backend?: string;
  dim?: number;
}

interface CodexGpuBatchResponse {
  vectors?: number[][];
  backend?: string;
  dim?: number;
  count?: number;
}

interface CodexGpuError {
  error?: string;
  message?: string;
}

/**
 * codex-gpu-embedder provider. Targets the local recodee
 * `codex-gpu-embedder` HTTP service (rust/codex-gpu-embedder), which exposes
 * `POST /embed { text }` and returns `{ vector, backend, dim }`.
 *
 * Why this exists: Colony's default `local` provider runs Transformers.js
 * in-process on CPU (~200 ms per single embed on the dev box). The recodee
 * GPU embedder serves the same MiniLM model on the CUDA Execution Provider
 * via Microsoft onnxruntime and answers in ~16 ms. Pointing Colony's
 * worker at it cuts the embedding-backfill cost by ~14x without touching
 * MemoryStore, the SQLite vector table, or the search path.
 *
 * Endpoint defaults to `http://127.0.0.1:8100` (the codex-gpu-embedder
 * default bind). Override via `settings.embedding.endpoint`. The dim is
 * captured by a one-shot warm-up probe at init time, matching the
 * contract every Colony embedding provider must satisfy.
 */
export async function createCodexGpuEmbedder(
  model: string,
  endpoint: string | undefined,
  opts: EmbeddingFactoryOptions = {},
): Promise<Embedder> {
  const base = (endpoint ?? 'http://127.0.0.1:8100').replace(/\/+$/, '');
  const log = opts.log ?? (() => {});

  let dim = 0;

  const requestJson = async <T>(path: string, body: unknown): Promise<T> => {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`codex-gpu-embedder fetch ${base}${path} failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      // Try to read the error body for a clearer message; fall through to
      // status text if the body is not JSON.
      let detail = '';
      try {
        const body = (await res.json()) as CodexGpuError;
        detail = body.error ?? body.message ?? '';
      } catch {
        try {
          detail = await res.text();
        } catch {
          detail = '';
        }
      }
      throw new Error(
        `codex-gpu-embedder ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`,
      );
    }
    return (await res.json()) as T;
  };

  const embed = async (text: string): Promise<Float32Array> => {
    const json = await requestJson<CodexGpuResponse>('/embed', { text });
    const raw = json.vector;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error('codex-gpu-embedder response missing or empty `vector` field');
    }
    const vec = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) vec[i] = raw[i] ?? 0;
    if (dim === 0) dim = vec.length;
    return vec;
  };

  const embedBatch = async (texts: readonly string[]): Promise<Float32Array[]> => {
    if (texts.length === 1) {
      const [text] = texts;
      return [await embed(text ?? '')];
    }
    const json = await requestJson<CodexGpuBatchResponse>('/embed/batch', { texts: [...texts] });
    const rows = json.vectors;
    if (!Array.isArray(rows) || rows.length !== texts.length) {
      throw new Error(
        `codex-gpu-embedder returned ${rows?.length ?? 0} vectors for ${texts.length} texts`,
      );
    }
    return rows.map((raw) => {
      const vec = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) vec[i] = raw[i] ?? 0;
      if (dim === 0) dim = vec.length;
      return vec;
    });
  };

  // Warm-up probe — confirms the endpoint is reachable, captures `dim`,
  // and forces the codex-gpu-embedder server to load its model so the
  // first real worker batch does not pay the cold-start cost on this
  // side either. The codex-gpu-embedder rejects empty strings with 400,
  // so use a single space (which the server tokenizes fine).
  log(`[colony:embed] probing codex-gpu-embedder at ${base} (model=${model})`);
  const probe = await embed(' ');
  dim = probe.length;

  return {
    model,
    get dim() {
      return dim;
    },
    embed,
    embedBatch,
  };
}
