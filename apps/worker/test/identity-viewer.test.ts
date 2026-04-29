import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore } from '@colony/core';
import type { SessionRow } from '@colony/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderIndex, renderSession } from '../src/viewer/index.js';

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-worker-viewer-identity-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('viewer session identity labels', () => {
  it('uses inferred metadata for mcp-* sessions', () => {
    const body = renderIndex(
      [
        sessionRow({
          id: 'mcp-1654237',
          ide: 'unknown',
          metadata: JSON.stringify({
            inferred_agent: 'codex',
            confidence: 0.95,
            source: 'mcp-tool-caller:agent',
          }),
        }),
      ],
      undefined,
      store,
    );

    expect(body).toContain('data-owner="codex"');
    expect(body).toContain('codex?');
    expect(body).not.toContain('<span class="owner" data-owner="unknown"');
  });

  it('labels evidence-free sessions as unbound instead of unknown', () => {
    const session = sessionRow({ id: 'mcp-1654237', ide: 'unknown' });

    const indexBody = renderIndex([session], undefined, store);
    const sessionBody = renderSession(session, []);

    expect(indexBody).toContain('data-owner="unbound"');
    expect(indexBody).toContain('unbound?');
    expect(sessionBody).toContain('data-owner="unbound"');
    expect(sessionBody).not.toContain('<span class="owner" data-owner="unknown"');
  });
});

function sessionRow(overrides: Partial<SessionRow>): SessionRow {
  return {
    id: 'session',
    ide: 'unknown',
    cwd: null,
    started_at: Date.parse('2026-04-29T10:00:00.000Z'),
    ended_at: null,
    metadata: null,
    ...overrides,
  };
}
