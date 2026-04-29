import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, listPlans } from '@colony/core';
import { colonyAdoptionFixesPlanInput, publishOrderedPlan } from '@colony/queen';
import kleur from 'kleur';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildColonyHealthPayload, formatColonyHealthOutput } from '../src/commands/health.js';

const NOW = 1_800_000_000_000;
const SINCE = NOW - 24 * 3_600_000;
const NO_CODEX_ROOT = '/var/empty/colony-queen-health-test-no-codex';

const MINIMAL_SPEC = `# SPEC

## §G  goal
Test fixture spec for queen health tests.

## §C  constraints
- markdown only.

## §I  interfaces
- none

## §V  invariants
id|rule|cites
-|-|-
V1|placeholder|-

## §T  tasks
id|status|task|cites
-|-|-|-
T1|todo|placeholder|V1

## §B  bugs
id|bug|cites
-|-|-
`;

let dataDir: string;
let repoRoot: string;
let store: MemoryStore;

beforeEach(() => {
  kleur.enabled = false;
  dataDir = mkdtempSync(join(tmpdir(), 'colony-queen-health-data-'));
  repoRoot = mkdtempSync(join(tmpdir(), 'colony-queen-health-repo-'));
  writeFileSync(join(repoRoot, 'SPEC.md'), MINIMAL_SPEC, 'utf8');
  store = new MemoryStore({ dbPath: join(dataDir, 'data.db'), settings: defaultSettings });
  store.startSession({ id: 'queen-session', ide: 'queen', cwd: repoRoot });
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
  kleur.enabled = true;
});

describe('queen wave health', () => {
  it('reports active adoption-fix plans, ready Wave 1 work, and blocked future waves', () => {
    publishOrderedPlan({
      store,
      plan: colonyAdoptionFixesPlanInput,
      repo_root: repoRoot,
      session_id: 'queen-session',
      agent: 'queen',
      auto_archive: false,
    });

    const payload = buildColonyHealthPayload(store.storage as never, {
      since: SINCE,
      window_hours: 24,
      now: NOW,
      codex_sessions_root: NO_CODEX_ROOT,
    });

    expect(payload.queen_wave_health).toMatchObject({
      active_plans: 1,
      current_wave: 'Wave 1',
      ready_subtasks: 3,
      blocked_subtasks: 4,
    });
    expect(payload.queen_wave_health.plans[0]).toMatchObject({
      plan_slug: 'colony-adoption-fixes',
      current_wave: 'Wave 1',
      ready_subtasks: 3,
      blocked_subtasks: 4,
    });

    const [plan] = listPlans(store, { repo_root: repoRoot });
    expect(plan?.next_available.map((subtask) => subtask.subtask_index)).toEqual([0, 1, 2]);
    expect(new Set(plan?.next_available.map((subtask) => subtask.wave_index))).toEqual(
      new Set([0]),
    );
    expect(
      plan?.subtasks
        .filter((subtask) => subtask.blocked_by_count > 0)
        .map((subtask) => subtask.subtask_index),
    ).toEqual([3, 4, 5, 6]);

    const text = formatColonyHealthOutput(payload);
    expect(text).toContain('Queen wave plans');
    expect(text).toContain('active plans:                       1');
    expect(text).toContain('ready subtasks:                     3');
    expect(text).toContain('blocked subtasks:                   4');
  });
});
