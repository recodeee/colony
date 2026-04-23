import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '../src/index.js';

let dir: string;
let storage: Storage;

function seed(...ids: string[]): void {
  for (const id of ids) {
    storage.createSession({
      id,
      ide: 'claude-code',
      cwd: '/tmp',
      started_at: Date.now(),
      metadata: null,
    });
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cavemem-proposals-'));
  storage = new Storage(join(dir, 'test.db'));
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('proposals storage', () => {
  it('insert + get round-trip preserves every field', () => {
    seed('A');
    const id = storage.insertProposal({
      repo_root: '/r',
      branch: 'b',
      summary: 'split search',
      rationale: 'bm25 and semantic should be separable',
      touches_files: JSON.stringify(['src/core.ts', 'src/ranker.ts']),
      proposed_by: 'A',
      proposed_at: 1_000,
    });
    const row = storage.getProposal(id);
    expect(row).toMatchObject({
      id,
      repo_root: '/r',
      branch: 'b',
      summary: 'split search',
      rationale: 'bm25 and semantic should be separable',
      status: 'pending',
      proposed_by: 'A',
      proposed_at: 1_000,
      promoted_at: null,
      task_id: null,
    });
    expect(JSON.parse(row!.touches_files)).toEqual(['src/core.ts', 'src/ranker.ts']);
  });

  it('updateProposal applies partial patch and leaves other fields intact', () => {
    seed('A');
    const task = storage.findOrCreateTask({
      title: 'placeholder',
      repo_root: '/r',
      branch: 'b/proposal-target',
      created_by: 'A',
    });
    const id = storage.insertProposal({
      repo_root: '/r',
      branch: 'b',
      summary: 's',
      rationale: 'r',
      touches_files: '[]',
      proposed_by: 'A',
    });
    storage.updateProposal(id, { status: 'active', promoted_at: 5_000, task_id: task.id });
    const row = storage.getProposal(id);
    expect(row).toMatchObject({ status: 'active', promoted_at: 5_000, task_id: task.id });
  });

  it('listProposalsForBranch filters by (repo_root, branch) and orders newest first', () => {
    seed('A');
    storage.insertProposal({
      repo_root: '/r',
      branch: 'b1',
      summary: 'p1',
      rationale: '',
      touches_files: '[]',
      proposed_by: 'A',
      proposed_at: 1_000,
    });
    storage.insertProposal({
      repo_root: '/r',
      branch: 'b1',
      summary: 'p2',
      rationale: '',
      touches_files: '[]',
      proposed_by: 'A',
      proposed_at: 2_000,
    });
    storage.insertProposal({
      repo_root: '/r',
      branch: 'other',
      summary: 'p3',
      rationale: '',
      touches_files: '[]',
      proposed_by: 'A',
      proposed_at: 3_000,
    });
    const rows = storage.listProposalsForBranch('/r', 'b1');
    expect(rows.map((r) => r.summary)).toEqual(['p2', 'p1']);
  });

  it('reinforcements insert + list round-trip and cascade on proposal delete', () => {
    seed('A', 'B');
    const id = storage.insertProposal({
      repo_root: '/r',
      branch: 'b',
      summary: 's',
      rationale: 'r',
      touches_files: '[]',
      proposed_by: 'A',
    });
    storage.insertReinforcement({
      proposal_id: id,
      session_id: 'A',
      kind: 'explicit',
      weight: 1.0,
      reinforced_at: 1_000,
    });
    storage.insertReinforcement({
      proposal_id: id,
      session_id: 'B',
      kind: 'adjacent',
      weight: 0.3,
      reinforced_at: 2_000,
    });
    expect(storage.listReinforcements(id)).toHaveLength(2);

    // Delete the proposal; reinforcements must cascade.
    (
      storage as unknown as {
        db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } };
      }
    ).db
      .prepare('DELETE FROM proposals WHERE id = ?')
      .run(id);
    expect(storage.listReinforcements(id)).toEqual([]);
  });
});
