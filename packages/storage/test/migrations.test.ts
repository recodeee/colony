import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '../src/index.js';

let dir: string;
let storage: Storage;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-migrations-'));
  storage = new Storage(join(dir, 'test.db'));
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('storage migrations', () => {
  it('creates scout/executor proposal columns and defaults on a fresh DB', () => {
    const db = new Database(join(dir, 'test.db'));
    try {
      expect(columnNames(db, 'tasks')).toEqual(
        expect.arrayContaining(['proposal_status', 'approved_by', 'observation_evidence_ids']),
      );
      expect(columnNames(db, 'agent_profiles')).toEqual(
        expect.arrayContaining(['role', 'open_proposal_count']),
      );

      db.prepare('INSERT INTO agent_profiles(agent, capabilities, updated_at) VALUES (?, ?, ?)').run(
        'codex',
        '{}',
        1_000,
      );
      expect(db.prepare('SELECT role, open_proposal_count FROM agent_profiles').get()).toEqual({
        role: 'executor',
        open_proposal_count: 0,
      });
      expect(indexNames(db, 'tasks')).toContain('idx_task_threads_proposal_status');
    } finally {
      db.close();
    }
  });
});

function columnNames(db: Database.Database, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => (row as { name: string }).name);
}

function indexNames(db: Database.Database, table: string): string[] {
  return db
    .prepare(`PRAGMA index_list(${table})`)
    .all()
    .map((row) => (row as { name: string }).name);
}
