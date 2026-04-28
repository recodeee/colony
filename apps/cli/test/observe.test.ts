import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, TaskThread } from '@colony/core';
import kleur from 'kleur';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderFrame } from '../src/commands/observe.js';

/**
 * The `colony observe` dashboard is the load-bearing diagnostic for whether
 * proactive claiming is happening — the unclaimed-edits footer is the
 * single most valuable line a session author looks at. If a metadata
 * rename or a safeJson typo silently broke the renderer, you'd find out
 * by looking at the dashboard one day and seeing nonsense, which is the
 * worst way to find out. These tests pin the structural shape so the
 * regression surfaces in CI instead.
 */

let dir: string;
let store: MemoryStore;

// Lock the clock so Date.now() and `new Date().toISOString()` are stable
// across runs. fmtAgo collapses to "0s ago" everywhere, which is fine —
// the assertions are structural, not on relative-time text.
const FROZEN_NOW = new Date('2026-04-28T03:00:00.000Z');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-observe-test-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW);
  // Disable kleur escapes — assertions look at plain text. kleur.enabled
  // is a process-global, so the afterEach restores it.
  kleur.enabled = false;
});

afterEach(() => {
  vi.useRealTimers();
  kleur.enabled = true;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('observe.renderFrame', () => {
  it('shows the empty-state hint when no tasks exist', () => {
    const frame = renderFrame(store.storage);
    expect(frame).toContain('colony observe');
    expect(frame).toContain('No tasks yet');
  });

  it('renders task header, claims, pending handoffs, and the proactive-claim footer', () => {
    // Two participants on one task. Compression-resilient assertions
    // only — file paths, agent names, branch slug, and handoff summary
    // (which lives in metadata, not the compressed content body) are
    // preserved byte-for-byte. We deliberately avoid asserting on
    // post() prose content because that goes through the compress
    // pipeline and changes shape under the lexicon.
    store.startSession({ id: 'A', ide: 'claude-code', cwd: '/repo' });
    store.startSession({ id: 'B', ide: 'codex', cwd: '/repo' });
    const thread = TaskThread.open(store, {
      repo_root: '/repo',
      branch: 'feat/dashboard',
      session_id: 'A',
    });
    thread.join('A', 'claude');
    thread.join('B', 'codex');
    thread.claimFile({ session_id: 'A', file_path: 'src/api.ts' });
    thread.handOff({
      from_session_id: 'A',
      from_agent: 'claude',
      to_agent: 'codex',
      summary: 'API done please wire UI',
      transferred_files: ['src/api.ts'],
    });
    // tool_use without a sibling claim — the load-bearing diagnostic.
    store.addObservation({
      session_id: 'A',
      kind: 'tool_use',
      content: 'Edit input=src/orphan.ts output=ok',
      task_id: thread.task_id,
      metadata: { tool: 'Edit', file_path: 'src/orphan.ts' },
    });

    const frame = renderFrame(store.storage);

    // Header
    expect(frame).toContain('colony observe');
    // Task line — branch and repo_root are stored verbatim.
    expect(frame).toContain('feat/dashboard');
    expect(frame).toContain('/repo');
    // Participants
    expect(frame).toContain('claude');
    expect(frame).toContain('codex');
    // Pending handoff — uses metadata.from_agent, metadata.to_agent,
    // metadata.summary; a rename of any of these would break this line.
    expect(frame).toMatch(/claude\s*→\s*codex/);
    expect(frame).toContain('API done please wire UI');
    // Diagnostic footer — both the literal label and the orphan path.
    expect(frame).toContain('edits without proactive claims');
    expect(frame).toContain('src/orphan.ts');
  });

  it('reports the green zero-state for the proactive-claim footer when every edit was claimed', () => {
    store.startSession({ id: 'A', ide: 'claude-code', cwd: '/repo' });
    const thread = TaskThread.open(store, {
      repo_root: '/repo',
      branch: 'feat/clean',
      session_id: 'A',
    });
    thread.join('A', 'claude');
    thread.claimFile({ session_id: 'A', file_path: 'src/clean.ts' });

    const frame = renderFrame(store.storage);
    expect(frame).toContain('edits without proactive claims (last 5m): none');
  });
});
