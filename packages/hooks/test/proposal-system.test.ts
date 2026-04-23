import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@cavemem/config';
import { MemoryStore, ProposalSystem, TaskThread } from '@cavemem/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reinforceAdjacentProposals } from '../src/handlers/post-tool-use.js';

let dir: string;
let store: MemoryStore;

function seedTwoSessionTask(): { task_id: number; repo_root: string; branch: string } {
  store.startSession({ id: 'A', ide: 'claude-code', cwd: '/repo' });
  store.startSession({ id: 'B', ide: 'codex', cwd: '/repo' });
  const thread = TaskThread.open(store, {
    repo_root: '/repo',
    branch: 'feat/proposals',
    session_id: 'A',
  });
  thread.join('A', 'claude');
  thread.join('B', 'codex');
  return { task_id: thread.task_id, repo_root: '/repo', branch: 'feat/proposals' };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cavemem-proposal-hooks-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('reinforceAdjacentProposals', () => {
  it('reinforces every pending proposal whose touches_files includes the edited path', () => {
    const { repo_root, branch } = seedTwoSessionTask();
    const proposals = new ProposalSystem(store);
    const id = proposals.propose({
      repo_root,
      branch,
      summary: 'refactor viewer',
      rationale: '...',
      touches_files: ['viewer.tsx'],
      session_id: 'A',
    });
    // B edits viewer.tsx — should count as adjacent reinforcement.
    const result = reinforceAdjacentProposals(store, {
      session_id: 'B',
      tool_name: 'Edit',
      tool_input: { file_path: 'viewer.tsx' },
    });
    expect(result.reinforced).toEqual([id]);
    // Strength should now be proposer (1.0) + adjacent (0.3) = 1.3.
    expect(proposals.currentStrength(id)).toBeCloseTo(1.3, 5);
  });

  it('is a no-op when the edited file is not in any proposal', () => {
    const { repo_root, branch } = seedTwoSessionTask();
    const proposals = new ProposalSystem(store);
    proposals.propose({
      repo_root,
      branch,
      summary: 's',
      rationale: '',
      touches_files: ['other.ts'],
      session_id: 'A',
    });
    const result = reinforceAdjacentProposals(store, {
      session_id: 'B',
      tool_name: 'Edit',
      tool_input: { file_path: 'unrelated.ts' },
    });
    expect(result.reinforced).toEqual([]);
  });

  it('is a no-op for non-write tools', () => {
    seedTwoSessionTask();
    const result = reinforceAdjacentProposals(store, {
      session_id: 'B',
      tool_name: 'Read',
      tool_input: { file_path: 'viewer.tsx' },
    });
    expect(result.reinforced).toEqual([]);
  });

  it('is a no-op for solo sessions not joined to any task', () => {
    store.startSession({ id: 'solo', ide: 'claude-code', cwd: '/repo' });
    const result = reinforceAdjacentProposals(store, {
      session_id: 'solo',
      tool_name: 'Edit',
      tool_input: { file_path: 'viewer.tsx' },
    });
    expect(result.reinforced).toEqual([]);
  });

  it('can push a proposal across the promotion threshold via repeated adjacencies', () => {
    const { repo_root, branch, task_id } = seedTwoSessionTask();
    // Add more sessions so we have enough actors, and join them so the
    // hook's findActiveTaskForSession lookup succeeds for each.
    for (const id of ['C', 'D', 'E']) {
      store.startSession({ id, ide: 'codex', cwd: '/repo' });
      store.storage.addTaskParticipant({ task_id, session_id: id, agent: 'codex' });
    }

    const proposals = new ProposalSystem(store);
    const id = proposals.propose({
      repo_root,
      branch,
      summary: 'heavy file refactor',
      rationale: '',
      touches_files: ['hot.ts'],
      session_id: 'A',
    });
    // Proposer = 1.0. Explicit support from B = +1.0 (total 2.0, still
    // below 2.5). Then three adjacencies from C/D/E push over the bar.
    proposals.reinforce({ proposal_id: id, session_id: 'B', kind: 'explicit' });
    for (const sess of ['C', 'D', 'E']) {
      reinforceAdjacentProposals(store, {
        session_id: sess,
        tool_name: 'Edit',
        tool_input: { file_path: 'hot.ts' },
      });
    }
    // The last reinforcement should have triggered promotion.
    expect(store.storage.getProposal(id)?.status).toBe('active');
  });
});
