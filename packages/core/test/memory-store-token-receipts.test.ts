import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countTokens, redactPrivate } from '@colony/compress';
import { defaultSettings } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-memory-token-receipts-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('MemoryStore token receipts', () => {
  it('stores deterministic compression receipt metadata without source text', () => {
    const content =
      'The authentication middleware is basically really important <private>secret-token-123</private> and it should be noted that we probably want to add a refresh path.';
    const id = store.addObservation({
      session_id: 's1',
      kind: 'note',
      content,
      metadata: { source: 'test', tokens_before: 999 },
    });

    const row = store.storage.getObservation(id);
    if (!row) throw new Error('observation missing');
    const metadata = JSON.parse(row.metadata ?? '{}') as Record<string, unknown>;
    const redacted = redactPrivate(content);
    const tokensBefore = countTokens(redacted);
    const tokensAfter = countTokens(row.content);
    const savedTokens = tokensBefore - tokensAfter;

    expect(metadata).toMatchObject({
      source: 'test',
      tokens_before: tokensBefore,
      tokens_after: tokensAfter,
      saved_tokens: savedTokens,
      saved_ratio: Number((savedTokens / tokensBefore).toFixed(3)),
      compression_intensity: defaultSettings.compression.intensity,
    });
    expect(JSON.stringify(metadata)).not.toContain(content);
    expect(JSON.stringify(metadata)).not.toContain('secret-token-123');
  });

  it('skips observation writes when redaction leaves no memory content', () => {
    const id = store.addObservation({
      session_id: 'private-only-observation',
      kind: 'note',
      content: '  <private>secret-token-123</private>  ',
    });

    expect(id).toBe(-1);
    expect(store.storage.countObservations()).toBe(0);
    expect(store.storage.getSession('private-only-observation')).toBeUndefined();
  });

  it('skips summary writes when redaction leaves no memory content', () => {
    const id = store.addSummary({
      session_id: 'private-only-summary',
      scope: 'turn',
      content: '\n<private>full private summary</private>\n',
    });

    expect(id).toBe(-1);
    expect(store.storage.listSummaries('private-only-summary')).toEqual([]);
    expect(store.storage.getSession('private-only-summary')).toBeUndefined();
  });
});
