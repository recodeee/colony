import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReviewerAgent } from '../src/agents/reviewer.js';
import { createCheckpoint } from '../src/core/checkpoint.js';
import { createInitialState } from '../src/core/state.js';
import type { BuildArtifactContent, OrchestratorOptions } from '../src/core/types.js';
import { HivemindOrchestrator } from '../src/index.js';

const tempDirs: string[] = [];
const silentLogger = { info: () => {} };

afterEach(() => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe('HivemindOrchestrator', () => {
  it('completes a happy-path task and writes persisted state', () => {
    const dataDir = createTempDir();
    const orchestrator = new HivemindOrchestrator({
      dataDir,
      logger: silentLogger,
    });

    const state = orchestrator.run(
      'Build a local TypeScript CLI with JSON state, checkpoints, a README, and verifier approval.',
    );

    expect(state.status).toBe('completed');
    expect(state.finalResult?.verified).toBe(true);
    expect(state.checkpoints.length).toBeGreaterThan(0);

    const persistedState = JSON.parse(
      readFileSync(join(dataDir, state.runId, 'state.json'), 'utf8'),
    ) as {
      status: string;
      checkpoints: unknown[];
      finalResult: { verified: boolean } | null;
    };

    expect(persistedState.status).toBe('completed');
    expect(persistedState.checkpoints.length).toBe(state.checkpoints.length);
    expect(persistedState.finalResult?.verified).toBe(true);
  });

  it('reviewer blocks builds without tests or checkpoint policy', () => {
    const options = baseOptions(createTempDir());
    const state = createInitialState('Ship a bounded MVP', options);
    const thinBuild: BuildArtifactContent = {
      fileTree: ['src/core/types.ts'],
      implementationSteps: ['Define types.'],
      testPlan: [],
      checkpointPolicy: [],
      notes: [],
    };

    state.artifacts.push({
      id: 'build-01',
      type: 'build',
      label: 'thin-build',
      content: thinBuild,
      createdAt: new Date().toISOString(),
    });

    const reviewer = new ReviewerAgent();
    const result = reviewer.run({ task: 'Ship a bounded MVP', phase: 'review', attempt: 1 }, state);

    expect(result.status).toBe('blocked');
    expect(result.replaceBlockers).toContain('Test plan missing.');
    expect(result.replaceBlockers).toContain('Checkpoint policy missing.');
  });

  it('creates compact checkpoints with goal, done, blocker, and next batch', () => {
    const options = baseOptions(createTempDir());
    const state = createInitialState('Tighten context handoffs', options);
    state.completedSteps.push('Researcher captured constraints.');
    state.blockers.push('Awaiting verifier approval.');
    state.subtasks.push(
      {
        id: 'review',
        title: 'Review output for risks and missing edges',
        owner: 'reviewer',
        status: 'blocked',
        notes: [],
        retryCount: 0,
      },
      {
        id: 'verify',
        title: 'Verify result before success',
        owner: 'verifier',
        status: 'pending',
        notes: [],
        retryCount: 0,
      },
    );
    state.turn = 4;

    const checkpoint = createCheckpoint(state);

    expect(checkpoint.compactSummary).toContain('Goal: Tighten context handoffs');
    expect(checkpoint.compactSummary).toContain('Done: Researcher captured constraints.');
    expect(checkpoint.compactSummary).toContain('Current blocker: Awaiting verifier approval.');
    expect(checkpoint.compactSummary).toContain(
      'Next batch: Review output for risks and missing edges',
    );
  });
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hivemind-demo-'));
  tempDirs.push(dir);
  return dir;
}

function baseOptions(dataDir: string): OrchestratorOptions {
  return {
    dataDir,
    maxTurns: 10,
    maxRetries: 1,
    checkpointInterval: 2,
    logger: silentLogger,
  };
}
