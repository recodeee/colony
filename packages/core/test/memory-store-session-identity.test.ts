import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-memory-identity-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('MemoryStore session identity', () => {
  it('stores MCP caller identity metadata when observations create the session', () => {
    store.addObservation({
      session_id: 'mcp-1654237',
      kind: 'note',
      content: 'Tool: colony.task_post',
      metadata: { agent: 'codex' },
    });

    const row = store.storage.getSession('mcp-1654237');
    expect(row).toMatchObject({ ide: 'codex' });
    expect(JSON.parse(row?.metadata ?? '{}')).toMatchObject({
      inferred_agent: 'codex',
      confidence: 0.95,
      source: 'observation:agent',
    });
  });

  it('upgrades unbound placeholder metadata when richer session evidence arrives', () => {
    store.addObservation({
      session_id: 'mcp-1654237',
      kind: 'note',
      content: 'Tool: colony.search',
    });

    expect(store.storage.getSession('mcp-1654237')).toMatchObject({ ide: 'unknown' });

    store.startSession({
      id: 'mcp-1654237',
      ide: 'codex',
      cwd: '/repo',
      metadata: { inferred_agent: 'codex', confidence: 0.95, source: 'mcp-tool-caller:agent' },
    });

    const row = store.storage.getSession('mcp-1654237');
    expect(row).toMatchObject({ ide: 'codex', cwd: '/repo' });
    expect(JSON.parse(row?.metadata ?? '{}')).toMatchObject({
      inferred_agent: 'codex',
      confidence: 0.95,
      source: 'mcp-tool-caller:agent',
    });
  });
});
