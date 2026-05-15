import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import {
  DEFAULT_CAPABILITIES,
  loadProfile,
  rankCandidates,
  saveProfile,
  scoreHandoff,
} from '../src/response-thresholds.js';
import { TaskThread } from '../src/task-thread.js';

let dir: string;
let store: MemoryStore;

function seed(...ids: string[]): void {
  for (const id of ids) {
    store.startSession({ id, ide: 'claude-code', cwd: '/r' });
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-thresholds-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('scoreHandoff', () => {
  const uiAgent = {
    agent: 'ui-specialist',
    capabilities: {
      ...DEFAULT_CAPABILITIES,
      ui_work: 0.9,
      api_work: 0.2,
      test_work: 0.2,
      infra_work: 0.1,
      doc_work: 0.2,
    },
    updated_at: 0,
  };
  const apiAgent = {
    agent: 'api-specialist',
    capabilities: {
      ...DEFAULT_CAPABILITIES,
      ui_work: 0.1,
      api_work: 0.9,
      test_work: 0.4,
      infra_work: 0.3,
      doc_work: 0.2,
    },
    updated_at: 0,
  };

  it('scores a UI handoff higher for the UI specialist', () => {
    const handoff = {
      summary: 'Refactor the viewer component layout',
      next_steps: ['split into two components', 'add responsive breakpoints'],
    };
    expect(scoreHandoff(handoff, uiAgent)).toBeGreaterThan(scoreHandoff(handoff, apiAgent));
  });

  it('scores an API handoff higher for the API specialist', () => {
    const handoff = {
      summary: 'Add an endpoint to accept handoff requests',
      next_steps: ['validate the request payload', 'update the MCP tool signature'],
    };
    expect(scoreHandoff(handoff, apiAgent)).toBeGreaterThan(scoreHandoff(handoff, uiAgent));
  });

  it('ambiguous handoffs produce near-equal scores', () => {
    const handoff = { summary: 'fix a small bug', next_steps: [] };
    const diff = Math.abs(scoreHandoff(handoff, uiAgent) - scoreHandoff(handoff, apiAgent));
    expect(diff).toBeLessThan(0.2);
  });
});

describe('rankCandidates', () => {
  it('ranks agents by best capability fit, preserving full list', () => {
    const profiles = [
      {
        agent: 'ui',
        capabilities: { ...DEFAULT_CAPABILITIES, ui_work: 0.95 },
        updated_at: 0,
      },
      {
        agent: 'api',
        capabilities: { ...DEFAULT_CAPABILITIES, api_work: 0.95 },
        updated_at: 0,
      },
      {
        agent: 'infra',
        capabilities: { ...DEFAULT_CAPABILITIES, infra_work: 0.95 },
        updated_at: 0,
      },
    ];
    const ranked = rankCandidates(
      { summary: 'redesign the viewer tsx and the CSS layout' },
      profiles,
    );
    expect(ranked[0].agent).toBe('ui');
    expect(ranked).toHaveLength(3);
  });
});

describe('loadProfile / saveProfile', () => {
  it('loadProfile returns the default capabilities for unknown agents', () => {
    const profile = loadProfile(store.storage, 'unknown');
    expect(profile.role).toBe('executor');
    expect(profile.openProposalCount).toBe(0);
    expect(profile.capabilities).toEqual(DEFAULT_CAPABILITIES);
    expect(profile.updated_at).toBe(0);
  });

  it('saveProfile merges the patch on top of existing capabilities', () => {
    saveProfile(store.storage, 'claude', { ui_work: 0.9, api_work: 0.4 });
    saveProfile(store.storage, 'claude', { ui_work: 0.95 });
    const profile = loadProfile(store.storage, 'claude');
    expect(profile.role).toBe('executor');
    expect(profile.openProposalCount).toBe(0);
    expect(profile.capabilities.ui_work).toBe(0.95);
    // Other values preserved from previous save.
    expect(profile.capabilities.api_work).toBe(0.4);
    // Untouched dimensions keep their defaults.
    expect(profile.capabilities.test_work).toBe(DEFAULT_CAPABILITIES.test_work);
  });

  it('loadProfile falls back to defaults if stored capabilities JSON is malformed', () => {
    store.storage.upsertAgentProfile({
      agent: 'broken',
      capabilities: '{not json',
      updated_at: 1,
    });
    expect(loadProfile(store.storage, 'broken').capabilities).toEqual(DEFAULT_CAPABILITIES);
  });
});

describe('TaskThread.handOff suggested_candidates integration', () => {
  it("populates suggested_candidates for 'any' handoffs, ranking by fit", () => {
    seed('claude-a', 'codex-a');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'x',
      session_id: 'claude-a',
    });
    thread.join('claude-a', 'claude');
    thread.join('codex-a', 'codex');
    saveProfile(store.storage, 'claude', {
      ui_work: 0.95,
      api_work: 0.3,
      test_work: 0.3,
      infra_work: 0.1,
      doc_work: 0.5,
    });
    saveProfile(store.storage, 'codex', {
      ui_work: 0.2,
      api_work: 0.95,
      test_work: 0.5,
      infra_work: 0.8,
      doc_work: 0.3,
    });

    const id = thread.handOff({
      from_session_id: 'claude-a',
      from_agent: 'claude',
      to_agent: 'any',
      summary: 'Add a new API endpoint and wire it into the MCP tool registry',
    });
    const row = store.storage.getObservation(id);
    const meta = JSON.parse(row?.metadata ?? '{}') as {
      suggested_candidates?: Array<{ agent: string; score: number }>;
    };
    expect(meta.suggested_candidates).toBeDefined();
    // codex should win the API-flavored handoff.
    expect(meta.suggested_candidates?.[0].agent).toBe('codex');
    // The sender (claude) is NOT in candidate list because we exclude
    // the sender from routing — self-routing is meaningless.
    expect(meta.suggested_candidates?.find((c) => c.agent === 'claude-sender')).toBeUndefined();
  });

  it('leaves suggested_candidates undefined for directed handoffs', () => {
    seed('claude-a', 'codex-a');
    const thread = TaskThread.open(store, {
      repo_root: '/r',
      branch: 'x',
      session_id: 'claude-a',
    });
    thread.join('claude-a', 'claude');
    thread.join('codex-a', 'codex');
    const id = thread.handOff({
      from_session_id: 'claude-a',
      from_agent: 'claude',
      to_agent: 'codex',
      summary: 'targeted handoff',
    });
    const row = store.storage.getObservation(id);
    const meta = JSON.parse(row?.metadata ?? '{}') as {
      suggested_candidates?: unknown;
    };
    expect(meta.suggested_candidates).toBeUndefined();
  });
});
