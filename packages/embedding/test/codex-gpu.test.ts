import { SettingsSchema } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmbedder } from '../src/index.js';
import { createCodexGpuEmbedder } from '../src/providers/codex-gpu.js';

describe('codex-gpu provider', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    // Each test reassigns fetch; restore is in afterEach.
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('issues warm-up probe at init and reports the dim from the response', async () => {
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      calls.push({ url: String(input), body: String(init?.body) });
      return new Response(
        JSON.stringify({
          vector: new Array(384).fill(0.0001),
          backend: 'ort-cuda-minilm',
          dim: 384,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const embedder = await createCodexGpuEmbedder('all-MiniLM-L6-v2', undefined);
    expect(embedder.dim).toBe(384);
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe('http://127.0.0.1:8100/embed');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ text: ' ' });
  });

  it('strips trailing slashes from the endpoint', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ vector: [1] }), { status: 200 });
    }) as unknown as typeof fetch;

    await createCodexGpuEmbedder('m', 'http://example.test:9000///');
    expect(calls[0]).toBe('http://example.test:9000/embed');
  });

  it('produces a Float32Array of the response vector length', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ vector: [0.1, 0.2, 0.3] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const embedder = await createCodexGpuEmbedder('m', 'http://127.0.0.1:8100');
    const out = await embedder.embed('hello');
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(3);
    expect(out[0]).toBeCloseTo(0.1);
  });

  it('sends text arrays to the batch endpoint', async () => {
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      calls.push({ url: String(input), body: String(init?.body) });
      if (String(input).endsWith('/embed/batch')) {
        return new Response(JSON.stringify({ vectors: [[0.1], [0.2]], count: 2, dim: 1 }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ vector: [0] }), { status: 200 });
    }) as unknown as typeof fetch;
    const embedder = await createCodexGpuEmbedder('m', 'http://127.0.0.1:8100');

    const out = await embedder.embedBatch?.(['hello', 'world']);

    expect(out?.map((vec) => Array.from(vec))).toEqual([
      [expect.closeTo(0.1, 5)],
      [expect.closeTo(0.2, 5)],
    ]);
    expect(calls[1]?.url).toBe('http://127.0.0.1:8100/embed/batch');
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({ texts: ['hello', 'world'] });
  });

  it('throws a clear error on non-2xx response, including the server message', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'text must be non-empty' }), {
          status: 400,
          statusText: 'Bad Request',
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    await expect(createCodexGpuEmbedder('m', undefined)).rejects.toThrow(/400/);
    await expect(createCodexGpuEmbedder('m', undefined)).rejects.toThrow(/text must be non-empty/);
  });

  it('throws when response is missing the vector field', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ backend: 'ort-cuda-minilm', dim: 384 }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(createCodexGpuEmbedder('m', undefined)).rejects.toThrow(
      /missing or empty `vector`/,
    );
  });

  it('throws when fetch itself rejects (server unreachable)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(createCodexGpuEmbedder('m', undefined)).rejects.toThrow(
      /codex-gpu-embedder fetch/,
    );
    await expect(createCodexGpuEmbedder('m', undefined)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('createEmbedder factory routes codex-gpu provider correctly', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ vector: new Array(384).fill(0) }), { status: 200 }),
    ) as unknown as typeof fetch;
    const settings = SettingsSchema.parse({
      embedding: {
        provider: 'codex-gpu',
        model: 'all-MiniLM-L6-v2',
        endpoint: 'http://127.0.0.1:8100',
      },
    });
    const embedder = await createEmbedder(settings);
    expect(embedder).not.toBeNull();
    expect(embedder?.dim).toBe(384);
  });
});
