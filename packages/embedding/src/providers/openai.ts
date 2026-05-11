import type { Embedder, EmbeddingFactoryOptions } from '../types.js';

interface OpenAIResponse {
  data?: Array<{ embedding: number[] }>;
  error?: { message: string };
}

const MODEL_DIMS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

/**
 * OpenAI-compatible embeddings endpoint. Works with OpenAI, Azure, and any
 * OpenAI-compatible server (Together, Groq, etc.) by pointing `endpoint` at
 * their base URL.
 */
export async function createOpenAIEmbedder(
  model: string,
  endpoint: string | undefined,
  apiKey: string | undefined,
  opts: EmbeddingFactoryOptions = {},
): Promise<Embedder> {
  if (!apiKey) {
    throw new Error(
      'OpenAI embedding provider requires an API key. Set via `colony config set embedding.apiKey <KEY>`.',
    );
  }
  const base = (endpoint ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const log = opts.log ?? (() => {});
  let dim = MODEL_DIMS[model] ?? 0;

  const embedBatch = async (texts: readonly string[]): Promise<Float32Array[]> => {
    const res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: texts.length === 1 ? texts[0] : texts }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI embed failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as OpenAIResponse;
    if (json.error) throw new Error(`OpenAI embed error: ${json.error.message}`);
    const rows = json.data;
    if (!rows || rows.length !== texts.length) {
      throw new Error(
        `OpenAI response returned ${rows?.length ?? 0} embeddings for ${texts.length} inputs`,
      );
    }
    const vectors = rows.map((row) => {
      const raw = row.embedding;
      if (!raw) throw new Error('OpenAI response missing embedding field');
      const vec = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) vec[i] = raw[i] ?? 0;
      if (dim === 0) dim = vec.length;
      return vec;
    });
    return vectors;
  };

  const embed = async (text: string): Promise<Float32Array> => {
    const [vec] = await embedBatch([text]);
    if (!vec) throw new Error('OpenAI response missing embedding field');
    return vec;
  };

  if (dim === 0) {
    log(`[colony:embed] probing openai model ${model} for dim`);
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
