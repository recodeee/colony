import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { type Embedder, MemoryStore, TaskThread } from '@colony/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildReadyClaimNudgePreface,
  type SuggestionPrefaceDeps,
  sessionStart,
} from '../src/handlers/session-start.js';

const THRESHOLDS = {
  SIMILARITY_FLOOR: 0.5,
  PREFACE_INCLUSION_THRESHOLD: 0.7,
  PREFACE_FILE_CONFIDENCE_THRESHOLD: 0.6,
  MIN_SIMILAR_TASKS_FOR_SUGGESTION: 3,
};

let dir: string;
let repo: string;
let store: MemoryStore;

class FakeEmbedder implements Embedder {
  readonly model = 'fake-model';
  readonly dim = 2;
  lastText = '';

  embed(text: string): Promise<Float32Array> {
    this.lastText = text;
    return Promise.resolve(new Float32Array([1, 0]));
  }
}

function fakeGitCheckout(path: string, branch: string): void {
  mkdirSync(join(path, '.git'), { recursive: true });
  writeFileSync(join(path, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
}

function similarTasks(count: number, topSimilarity: number) {
  return Array.from({ length: count }, (_, i) => ({
    task_id: 100 + i,
    similarity:
      i === 0 ? topSimilarity : Math.max(THRESHOLDS.SIMILARITY_FLOOR, topSimilarity - 0.01),
    branch: `past/task-${i}`,
    repo_root: repo,
    status: 'completed',
    observation_count: 8,
  }));
}

function payloadFor(similar_tasks: ReturnType<typeof similarTasks>) {
  return {
    similar_tasks,
    first_files_likely_claimed: [
      { file_path: 'packages/hooks/src/handlers/session-start.ts', confidence: 0.74 },
      { file_path: 'packages/hooks/test/session-start.test.ts', confidence: 0.68 },
      { file_path: 'packages/core/src/suggestion-payload.ts', confidence: 0.61 },
      { file_path: 'packages/core/src/task-embeddings.ts', confidence: 0.59 },
    ],
    patterns_to_watch: [{ description: 'handoff expired when thresholds were too loose' }],
    resolution_hints: {
      median_elapsed_minutes: 42,
      median_handoff_count: 2,
      median_subtask_count: null,
      completed_sample_size: 3,
    },
    insufficient_data_reason: null,
  };
}

function sectionStartingWith(preface: string, prefix: string): string {
  const start = preface.indexOf(prefix);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = preface.slice(start);
  const end = rest.indexOf('\n\n');
  return end === -1 ? rest : rest.slice(0, end);
}

function tokenishCount(value: string): number {
  return Math.ceil(value.length / 4);
}

function longBody(label: string, index: number): string {
  return `${label} ${index} compact preview ${'context '.repeat(
    30,
  )}FULL_BODY_SENTINEL_${label.toUpperCase()}_${index}`;
}

function depsFor(similar_tasks: ReturnType<typeof similarTasks>, embedder = new FakeEmbedder()) {
  const findSimilarTasks = vi.fn((_store, _embedder, _query, options) => {
    expect(options).toMatchObject({
      repo_root: repo,
      min_similarity: THRESHOLDS.SIMILARITY_FLOOR,
    });
    expect(options.exclude_task_ids).toHaveLength(1);
    return similar_tasks;
  });
  const buildSuggestionPayload = vi.fn((_store, incoming) => payloadFor(incoming));
  const deps: SuggestionPrefaceDeps = {
    resolveEmbedder: async () => embedder,
    loadCore: async () => ({
      SUGGESTION_THRESHOLDS: THRESHOLDS,
      findSimilarTasks,
      buildSuggestionPayload,
    }),
  };
  return { deps, embedder, findSimilarTasks, buildSuggestionPayload };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-session-start-suggestions-'));
  repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  fakeGitCheckout(repo, 'agent/codex/sessionstart-suggest');
  store = new MemoryStore({
    dbPath: join(dir, 'data.db'),
    settings: {
      ...defaultSettings,
      foraging: { ...defaultSettings.foraging, enabled: false },
    },
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SessionStart predictive suggestion preface', () => {
  it.each(['codex', 'claude-code'])(
    'injects the quota-safe Colony operating contract for %s generated instructions',
    async (ide) => {
      const preface = await sessionStart(store, { session_id: `S-${ide}`, ide, cwd: repo });

      expect(preface).toContain('## Quota-safe Colony operating contract');
      expect(preface).toContain('RTK command policy:');
      expect(preface).toContain('Always prefix shell commands with `rtk`');
      expect(preface).toContain('rtk git status');
      expect(preface).toContain('rtk proxy <command>');
      expect(preface).toContain('If `rtk` is unavailable');
      expect(preface).toContain('Call hivemind_context.');
      expect(preface).toContain('Call attention_inbox.');
      expect(preface).toContain('Call task_ready_for_agent.');
      expect(preface).toContain('Accept a pending handoff with task_accept_handoff');
      expect(preface).toContain('Claim the subtask with task_plan_claim_subtask');
      expect(preface).toContain('Claim each touched file with task_claim_file before edits.');
      expect(preface).toContain('Write task_note_working');
      expect(preface).toContain('Update task_note_working after meaningful progress.');
      expect(preface).toContain('Run focused verification for the touched behavior.');
      expect(preface).toContain('Shutdown / finish contract');
      expect(preface).toContain('Before stopping, run git status and identify dirty files.');
      expect(preface).toContain('commit finished work, hand off unfinished work, or clean');
      expect(preface).toContain('Write task_note_working with branch, task, dirty files');
      expect(preface).toContain('Release or weaken claims before abandoning work');
      expect(preface).toContain(
        'Emit a quota_exhausted handoff with task_hand_off or task_relay, or release owned claims.',
      );
      expect(preface).toContain(
        'claimed files, dirty files from git status, branch, last verification, and next step',
      );
      expect(preface).toContain('Mark claims handoff-pending or release them before exit');
      expect(preface).toContain('When unsure, run coordination sweep guidance first');
      expect(preface).toContain('Coordination truth lives in Colony.');
      expect(preface).toContain('Use OMX for runtime memory summaries.');
      expect(preface).toContain('Use available MCP servers for repo, GitHub, CI, and docs context');
    },
  );

  it('includes a suggestion section when similarity, sample, and file-confidence thresholds pass', async () => {
    const similar = similarTasks(4, 0.82);
    const { deps, embedder } = depsFor(similar);

    const preface = await sessionStart(store, { session_id: 'S', ide: 'codex', cwd: repo }, deps);

    expect(preface).toContain('Suggested approach (based on 4 similar past tasks):');
    expect(preface).toContain(
      'Files agents typically claimed first: packages/hooks/src/handlers/session-start.ts (0.74)',
    );
    expect(preface).toContain('packages/hooks/test/session-start.test.ts (0.68)');
    expect(preface).toContain('packages/core/src/suggestion-payload.ts (0.61)');
    expect(preface).not.toContain('packages/core/src/task-embeddings.ts');
    expect(preface).toContain('Median similar task completed in 42m with 2 handoffs');
    expect(preface).toContain('Watch for: handoff expired when thresholds were too loose');
    expect(preface).toContain('Run task_suggest_approach for the full pattern report.');
    expect(embedder.lastText).toBe('agent/codex/sessionstart-suggest');
  });

  it('logs suggestion-debrief instead of preface when top similarity is below preface threshold', async () => {
    const similar = similarTasks(4, 0.65);
    const { deps } = depsFor(similar);

    const preface = await sessionStart(store, { session_id: 'S', ide: 'codex', cwd: repo }, deps);

    expect(preface).not.toContain('Suggested approach');
    const task = store.storage.findTaskByBranch(repo, 'agent/codex/sessionstart-suggest');
    expect(task).toBeDefined();
    const debriefs = store.storage.taskObservationsByKind(task?.id ?? -1, 'suggestion-debrief');
    expect(debriefs).toHaveLength(1);
    const metadata = JSON.parse(debriefs[0]?.metadata ?? '{}') as Record<string, unknown>;
    expect(metadata.top_similarity).toBe(0.65);
    expect(metadata.preface_inclusion_threshold).toBe(0.7);
    const payload = metadata.payload as {
      similar_tasks: Array<{ similarity: number }>;
      insufficient_data_reason: string | null;
    };
    expect(payload.insufficient_data_reason).toBeNull();
    expect(payload.similar_tasks[0]?.similarity).toBe(0.65);
  });

  it('does not include a preface section or log debrief when top similarity is below floor', async () => {
    const similar = similarTasks(4, 0.49);
    const { deps } = depsFor(similar);

    const preface = await sessionStart(store, { session_id: 'S', ide: 'codex', cwd: repo }, deps);

    expect(preface).not.toContain('Suggested approach');
    const task = store.storage.findTaskByBranch(repo, 'agent/codex/sessionstart-suggest');
    expect(store.storage.taskObservationsByKind(task?.id ?? -1, 'suggestion-debrief')).toHaveLength(
      0,
    );
  });

  it('keeps SessionStart normal when the corpus is empty', async () => {
    const embedder = new FakeEmbedder();
    const findSimilarTasks = vi.fn(() => []);
    const buildSuggestionPayload = vi.fn();
    const deps: SuggestionPrefaceDeps = {
      resolveEmbedder: async () => embedder,
      loadCore: async () => ({
        SUGGESTION_THRESHOLDS: THRESHOLDS,
        findSimilarTasks,
        buildSuggestionPayload,
      }),
    };

    const preface = await sessionStart(store, { session_id: 'S', ide: 'codex', cwd: repo }, deps);

    expect(preface).not.toContain('Suggested approach');
    expect(buildSuggestionPayload).not.toHaveBeenCalled();
    expect(store.storage.findTaskByBranch(repo, 'agent/codex/sessionstart-suggest')).toBeDefined();
  });

  it('keeps SessionStart normal when the embedder is unavailable', async () => {
    const findSimilarTasks = vi.fn();
    const deps: SuggestionPrefaceDeps = {
      resolveEmbedder: async () => null,
      loadCore: async () => ({
        SUGGESTION_THRESHOLDS: THRESHOLDS,
        findSimilarTasks,
        buildSuggestionPayload: vi.fn(),
      }),
    };

    const preface = await sessionStart(store, { session_id: 'S', ide: 'codex', cwd: repo }, deps);

    expect(preface).not.toContain('Suggested approach');
    expect(findSimilarTasks).not.toHaveBeenCalled();
    const task = store.storage.findTaskByBranch(repo, 'agent/codex/sessionstart-suggest');
    expect(store.storage.taskObservationsByKind(task?.id ?? -1, 'suggestion-debrief')).toHaveLength(
      0,
    );
  });

  it('keeps the startup attention section compact until learned hints are available', async () => {
    store.startSession({ id: 'A', ide: 'claude-code', cwd: repo });
    const thread = TaskThread.open(store, {
      repo_root: repo,
      branch: 'agent/codex/sessionstart-suggest',
      session_id: 'A',
    });
    thread.join('A', 'claude');

    const handoffId = thread.handOff({
      from_session_id: 'A',
      from_agent: 'claude',
      to_agent: 'codex',
      summary: 'handoff summary stays compact',
      next_steps: [longBody('handoff_next_step', 1)],
      blockers: [longBody('handoff_blocker', 1)],
      transferred_files: ['packages/hooks/src/handlers/session-start.ts'],
    });
    thread.requestWake({
      from_session_id: 'A',
      from_agent: 'claude',
      to_agent: 'codex',
      reason: 'wake reason should collapse behind the attention budget',
      next_step: longBody('wake_next_step', 1),
    });
    for (let i = 0; i < 14; i += 1) {
      thread.postMessage({
        from_session_id: 'A',
        from_agent: 'claude',
        to_agent: 'codex',
        content: longBody('message_body', i),
        urgency: i < 10 ? 'needs_reply' : 'fyi',
      });
    }

    const preface = await sessionStart(store, { session_id: 'B', ide: 'codex', cwd: repo });
    const attention = sectionStartingWith(preface, 'Attention (');

    expect(attention.split('\n')).toHaveLength(5);
    expect(tokenishCount(attention)).toBeLessThanOrEqual(180);
    expect(attention).toContain(`handoff #${handoffId}`);
    expect(attention).toContain('Plus ');
    expect(attention).toContain('collapsed. Run attention_inbox to see all.');

    expect(preface).not.toContain('FULL_BODY_SENTINEL_MESSAGE_BODY_0');
    expect(preface).not.toContain('FULL_BODY_SENTINEL_MESSAGE_BODY_13');
    expect(preface).not.toContain('FULL_BODY_SENTINEL_HANDOFF_NEXT_STEP_1');
    expect(preface).not.toContain('FULL_BODY_SENTINEL_HANDOFF_BLOCKER_1');
    expect(preface).not.toContain('FULL_BODY_SENTINEL_WAKE_NEXT_STEP_1');
    expect(preface).not.toContain('PENDING HANDOFF');
    expect(preface).not.toContain('PENDING WAKE');
  });
});

describe('SessionStart ready-claim nudge', () => {
  function seedAvailableSubtask(slug: string): void {
    fakeGitCheckout(repo, 'main');
    store.startSession({ id: 'publisher', ide: 'codex', cwd: repo });
    const parent = TaskThread.open(store, {
      repo_root: repo,
      branch: `spec/${slug}`,
      session_id: 'publisher',
      title: `parent ${slug}`,
    });
    parent.join('publisher', 'codex');
    const sub = TaskThread.open(store, {
      repo_root: repo,
      branch: `spec/${slug}/sub-0`,
      session_id: 'publisher',
      title: `sub-0 ${slug}`,
    });
    sub.join('publisher', 'codex');
    store.addObservation({
      session_id: 'publisher',
      task_id: sub.task_id,
      kind: 'plan-subtask',
      content: 'Available subtask\n\nDescription',
      metadata: {
        title: 'Available subtask',
        description: 'Description',
        subtask_index: 0,
        status: 'available',
        file_scope: ['apps/api/foo.ts'],
        parent_plan_slug: slug,
        parent_spec_task_id: parent.task_id,
      },
    });
  }

  it('returns empty when no plans exist in the repo', () => {
    fakeGitCheckout(repo, 'main');
    expect(buildReadyClaimNudgePreface(store, { cwd: repo })).toBe('');
  });

  it('surfaces a ready-Queen-sub-tasks line when work is unclaimed', () => {
    seedAvailableSubtask('nudge-target');
    const preface = buildReadyClaimNudgePreface(store, { cwd: repo });
    expect(preface).toContain('## Ready Queen sub-tasks');
    expect(preface).toContain('1 ready sub-task');
    expect(preface).toContain('task_plan_claim_subtask');
  });

  it('does not nudge when no cwd is provided', () => {
    seedAvailableSubtask('nudge-target');
    expect(buildReadyClaimNudgePreface(store, {})).toBe('');
  });
});
