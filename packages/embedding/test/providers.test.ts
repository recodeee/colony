import { SettingsSchema } from '@cavemem/config';
import { describe, expect, it } from 'vitest';
import { createEmbedder } from '../src/index.js';

describe('createEmbedder', () => {
  it('returns null when provider is none', async () => {
    const settings = SettingsSchema.parse({ embedding: { provider: 'none' } });
    const embedder = await createEmbedder(settings);
    expect(embedder).toBeNull();
  });

  it('throws for openai without api key', async () => {
    const settings = SettingsSchema.parse({
      embedding: { provider: 'openai', model: 'text-embedding-3-small' },
    });
    await expect(createEmbedder(settings)).rejects.toThrow(/API key/);
  });
});
