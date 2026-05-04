import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore, buildCocoIndexSessionRecords } from '../src/index.js';

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-cocoindex-source-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('buildCocoIndexSessionRecords', () => {
  it('exports compact Codex and Claude sessions with token savings', () => {
    store.startSession({ id: 'codex@a', ide: 'codex', cwd: '/repo' });
    store.startSession({ id: 'claude@b', ide: 'claude-code', cwd: '/repo' });
    store.startSession({ id: 'gemini@c', ide: 'gemini', cwd: '/repo' });

    store.addObservation({
      session_id: 'codex@a',
      kind: 'note',
      content: 'The implementation branch should keep a compact source for downstream token usage.',
    });
    store.addSummary({
      session_id: 'claude@b',
      scope: 'session',
      content: 'Claude finished verification and left a compact handoff.',
    });
    store.addObservation({
      session_id: 'gemini@c',
      kind: 'note',
      content: 'This non-target session should not appear.',
    });

    const records = buildCocoIndexSessionRecords(store.storage);

    expect(records.map((record) => record.id).sort()).toEqual(['claude@b', 'codex@a']);
    expect(records.find((record) => record.id === 'codex@a')).toMatchObject({
      agent: 'codex',
      observation_count: 1,
      tokens_before: expect.any(Number),
      tokens_after: expect.any(Number),
      saved_tokens: expect.any(Number),
    });
    expect(records.find((record) => record.id === 'claude@b')?.compact_context).toContain(
      'Claude finished verification',
    );
  });

  it('infers agent identity from session id when ide is unknown', () => {
    store.startSession({ id: 'agent/codex/task-slug', ide: 'unknown', cwd: '/repo' });
    store.addObservation({
      session_id: 'agent/codex/task-slug',
      kind: 'note',
      content: 'Codex session inferred from branch-shaped session id.',
    });

    const records = buildCocoIndexSessionRecords(store.storage, { agents: ['codex'] });

    expect(records).toHaveLength(1);
    expect(records[0]?.agent).toBe('codex');
  });
});
