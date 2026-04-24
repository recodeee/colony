import { describe, expect, it } from 'vitest';
import { ImportRecord } from '../src/commands/export.js';

describe('ImportRecord schema', () => {
  it('accepts a well-formed session row', () => {
    const ok = ImportRecord.safeParse({
      type: 'session',
      id: 'claude@abc',
      ide: 'claude-code',
      cwd: '/repo',
      started_at: 123,
      metadata: null,
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a well-formed observation row with numeric compressed flag', () => {
    const ok = ImportRecord.safeParse({
      type: 'observation',
      session_id: 's1',
      kind: 'note',
      content: 'hello',
      compressed: 1,
      intensity: 'full',
      ts: 1000,
    });
    expect(ok.success).toBe(true);
    if (ok.success && ok.data.type === 'observation') {
      expect(ok.data.compressed).toBe(true);
    }
  });

  it('rejects rows with an unknown discriminator', () => {
    const res = ImportRecord.safeParse({ type: 'garbage', id: 'x' });
    expect(res.success).toBe(false);
  });

  it('rejects a session with a non-numeric started_at', () => {
    const res = ImportRecord.safeParse({
      type: 'session',
      id: 'a',
      ide: 'claude-code',
      cwd: null,
      started_at: 'yesterday',
      metadata: null,
    });
    expect(res.success).toBe(false);
  });

  it('rejects an observation missing required content', () => {
    const res = ImportRecord.safeParse({
      type: 'observation',
      session_id: 's',
      kind: 'note',
      compressed: true,
    });
    expect(res.success).toBe(false);
  });
});
