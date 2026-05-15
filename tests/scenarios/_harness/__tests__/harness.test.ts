import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ScenarioMismatchError,
  assertExpectedMatch,
  collectLiveSubstrate,
  loadExpected,
} from '../assert.mjs';
import { ScenarioConfigError, parseInputsJsonl, runScenarioInputs } from '../run.mjs';
import {
  BASE_TS,
  type ScenarioContext,
  setupScenarioContext,
  teardownScenarioContext,
} from '../setup.mjs';

/**
 * Self-tests that prove the runner fails closed in the two ways most
 * likely to silently let a scenario pass against the wrong fixture:
 *   1) expected.json is missing entirely
 *   2) expected.json disagrees with the live substrate
 *
 * Both must surface a structured error with the slug, the offending
 * key path, and both sides of the diff.
 */
describe('scenarios harness self-tests', () => {
  let scratch: string;
  let ctx: ScenarioContext | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TS);
    scratch = mkdtempSync(join(tmpdir(), 'colony-harness-selftest-'));
  });

  afterEach(() => {
    teardownScenarioContext(ctx);
    ctx = undefined;
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      // best effort
    }
    vi.useRealTimers();
  });

  it('fails closed when expected.json is missing', async () => {
    const fixtureDir = join(scratch, 'no-expected');
    mkdirSync(fixtureDir, { recursive: true });
    // Inputs file exists but expected.json does not — the runner must
    // refuse to mark the scenario green just because the live run
    // happened to succeed.
    writeFileSync(
      join(fixtureDir, 'inputs.jsonl'),
      `${JSON.stringify({
        kind: 'lifecycle',
        at_ms: 10,
        payload: {
          event_id: 'evt_selftest_session',
          event_name: 'session_start',
          session_id: 'codex@selftest',
          agent: 'codex',
          branch: 'agent/scenario/default',
        },
      })}\n`,
      'utf8',
    );
    ctx = setupScenarioContext({ scenarioDir: fixtureDir });
    const inputs = parseInputsJsonl(join(fixtureDir, 'inputs.jsonl'));
    await runScenarioInputs(ctx, inputs, (ms) => {
      vi.setSystemTime(ms);
    });
    expect(() => loadExpected(fixtureDir)).toThrow(ScenarioConfigError);
    expect(() => loadExpected(fixtureDir)).toThrow(/missing expected\.json/);
  });

  it('reports a clear diff when expected.json disagrees with substrate', async () => {
    const fixtureDir = join(scratch, 'wrong-expected');
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(
      join(fixtureDir, 'inputs.jsonl'),
      `${JSON.stringify({
        kind: 'lifecycle',
        at_ms: 10,
        payload: {
          event_id: 'evt_selftest_bind_session',
          event_name: 'session_start',
          session_id: 'codex@selftest',
          agent: 'codex',
          branch: 'agent/scenario/default',
        },
      })}\n${JSON.stringify({
        kind: 'lifecycle',
        at_ms: 20,
        payload: {
          event_id: 'evt_selftest_bind',
          event_name: 'task_bind',
          session_id: 'codex@selftest',
          agent: 'codex',
          branch: 'agent/scenario/default',
        },
      })}\n${JSON.stringify({
        kind: 'lifecycle',
        at_ms: 40,
        payload: {
          event_id: 'evt_selftest_pre',
          event_name: 'pre_tool_use',
          session_id: 'codex@selftest',
          agent: 'codex',
          branch: 'agent/scenario/default',
          tool_name: 'Edit',
          tool_input: {
            operation: 'replace',
            paths: [{ path: '<REPO_ROOT>/src/target.ts', role: 'target', kind: 'file' }],
          },
        },
      })}\n`,
      'utf8',
    );
    // Deliberately wrong file_path so the runner must report the mismatch.
    writeFileSync(
      join(fixtureDir, 'expected.json'),
      `${JSON.stringify({
        claims: [
          {
            file_path: 'src/wrong-target.ts',
          },
        ],
      })}\n`,
      'utf8',
    );
    ctx = setupScenarioContext({ scenarioDir: fixtureDir });
    const inputs = parseInputsJsonl(join(fixtureDir, 'inputs.jsonl'));
    await runScenarioInputs(ctx, inputs, (ms) => {
      vi.setSystemTime(ms);
    });
    const live = collectLiveSubstrate(ctx);
    const expected = loadExpected(fixtureDir);

    let captured: ScenarioMismatchError | undefined;
    try {
      assertExpectedMatch('wrong-expected', expected, live);
    } catch (err) {
      if (err instanceof ScenarioMismatchError) captured = err;
      else throw err;
    }
    expect(captured, 'expected a ScenarioMismatchError').toBeDefined();
    if (!captured) throw new Error('unreachable');
    expect(captured.slug).toBe('wrong-expected');
    expect(captured.keyPath).toBe('claims[0].file_path');
    expect(captured.actual).toBe('src/target.ts');
    expect(captured.expected).toBe('src/wrong-target.ts');
    expect(captured.message).toContain('wrong-expected');
    expect(captured.message).toContain('claims[0].file_path');
    expect(captured.message).toContain('src/wrong-target.ts');
    expect(captured.message).toContain('src/target.ts');
  });
});
