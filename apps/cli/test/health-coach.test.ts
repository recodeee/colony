import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import type { Settings } from '@colony/config';
import { Storage } from '@colony/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COACH_LADDER,
  buildCoachPayload,
  formatCoachOutput,
} from '../src/commands/health-coach.js';

let dataDir: string;
let storage: Storage;

function makeSettings(overrides: { ides?: Record<string, boolean> } = {}): Settings {
  return {
    ...defaultSettings,
    ides: overrides.ides ?? {},
  } as Settings;
}

function seedSession(id: string): void {
  storage.createSession({
    id,
    ide: 'codex',
    cwd: '/tmp/test',
    started_at: Date.now() - 60_000,
    metadata: null,
  });
}

function insertToolCall(sessionId: string, tool: string, ts: number = Date.now()): void {
  // Mirrors what hook handlers write: kind='tool_use' + metadata.tool=<name>.
  storage.insertObservation({
    session_id: sessionId,
    kind: 'tool_use',
    content: `tool ${tool}`,
    compressed: false,
    intensity: null,
    ts,
    metadata: { tool },
  });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'colony-coach-'));
  storage = new Storage(join(dataDir, 'data.db'));
});

afterEach(() => {
  storage.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('colony health --coach', () => {
  it('classifies a brand-new repo as fresh and points at step 1', () => {
    const payload = buildCoachPayload(storage, makeSettings());
    expect(payload.stage).toBe('fresh');
    expect(payload.fresh_repo).toBe(true);
    expect(payload.completed_steps).toEqual([]);
    expect(payload.next_step?.id).toBe('install_runtime');
    expect(payload.upcoming).toHaveLength(COACH_LADDER.length - 1);
  });

  it('marks install_runtime as complete when an IDE is flagged installed', () => {
    const payload = buildCoachPayload(storage, makeSettings({ ides: { codex: true } }));
    expect(payload.fresh_repo).toBe(false);
    expect(payload.stage).toBe('installed_no_signal');
    expect(payload.completed_steps[0]?.id).toBe('install_runtime');
    expect(payload.completed_steps[0]?.evidence).toContain('codex');
    expect(payload.next_step?.id).toBe('first_task_post');
  });

  it('marks first_task_post when an mcp__colony__task_post call is observed', () => {
    seedSession('s1');
    insertToolCall('s1', 'mcp__colony__task_post');

    const payload = buildCoachPayload(storage, makeSettings({ ides: { codex: true } }));
    const ids = payload.completed_steps.map((step) => step.id);
    expect(ids).toContain('install_runtime');
    expect(ids).toContain('first_task_post');
    expect(payload.next_step?.id).toBe('first_task_claim_file');
  });

  it('marks first_task_claim_file when an mcp__colony__task_claim_file call is observed', () => {
    seedSession('s1');
    insertToolCall('s1', 'mcp__colony__task_claim_file');

    const payload = buildCoachPayload(storage, makeSettings({ ides: { codex: true } }));
    const ids = payload.completed_steps.map((step) => step.id);
    expect(ids).toContain('first_task_claim_file');
    // The evidence string should call out the MCP tool name we observed.
    const claimStep = payload.completed_steps.find((s) => s.id === 'first_task_claim_file');
    expect(claimStep?.evidence).toContain('task_claim_file');
  });

  it('marks first_gain_review when a coach_gain_review observation exists', () => {
    seedSession('observer');
    storage.insertObservation({
      session_id: 'observer',
      kind: 'coach_gain_review',
      content: 'gain invocation',
      compressed: false,
      intensity: null,
      ts: Date.now(),
    });

    const payload = buildCoachPayload(storage, makeSettings({ ides: { codex: true } }));
    const ids = payload.completed_steps.map((step) => step.id);
    expect(ids).toContain('first_gain_review');
  });

  it('persists completion across calls (idempotent markCoachStep)', () => {
    seedSession('s1');
    insertToolCall('s1', 'mcp__colony__task_post', 1_700_000_000_000);

    const first = buildCoachPayload(storage, makeSettings({ ides: { codex: true } }));
    const firstCompletedAt = first.completed_steps.find(
      (s) => s.id === 'first_task_post',
    )?.completed_at;
    expect(firstCompletedAt).toBeDefined();

    // Re-run with no new evidence — completed_at must be identical, proving
    // the row wasn't overwritten by a second INSERT OR IGNORE.
    const second = buildCoachPayload(storage, makeSettings({ ides: { codex: true } }));
    const secondCompletedAt = second.completed_steps.find(
      (s) => s.id === 'first_task_post',
    )?.completed_at;
    expect(secondCompletedAt).toBe(firstCompletedAt);
  });

  it('emits a numbered, copy-pasteable prose report with cmd + tool lines', () => {
    const payload = buildCoachPayload(storage, makeSettings());
    const text = formatCoachOutput(payload);
    expect(text).toContain('colony health --coach');
    expect(text).toContain('Next habit:');
    expect(text).toContain('cmd:  colony install --ide codex');
    expect(text).toContain('tool: colony install');
  });

  it('emits JSON when requested', () => {
    const payload = buildCoachPayload(storage, makeSettings());
    const json = JSON.parse(formatCoachOutput(payload, { json: true }));
    expect(json.stage).toBe('fresh');
    expect(json.next_step.id).toBe('install_runtime');
    expect(Array.isArray(json.upcoming)).toBe(true);
  });

  it('produces a finished banner when every step is complete', () => {
    seedSession('s1');
    for (const step of COACH_LADDER) {
      // Synthesize the matching tool call for steps that key on tool names.
      if (step.id === 'install_runtime') continue;
      if (step.id === 'first_gain_review') continue;
      const toolName = step.tool.replace(/^mcp__colony__/, '');
      insertToolCall('s1', `mcp__colony__${toolName}`);
    }
    storage.insertObservation({
      session_id: 's1',
      kind: 'coach_gain_review',
      content: 'gain',
      compressed: false,
      intensity: null,
      ts: Date.now(),
    });
    const payload = buildCoachPayload(storage, makeSettings({ ides: { codex: true } }));
    expect(payload.completed_steps).toHaveLength(COACH_LADDER.length);
    expect(payload.next_step).toBeNull();
    expect(payload.upcoming).toEqual([]);
    const text = formatCoachOutput(payload);
    expect(text).toContain('You finished the first-week ladder');
  });
});
