import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertExpectedMatch, collectLiveSubstrate, loadExpected } from './assert.mjs';
import { parseInputsJsonl, runScenarioInputs } from './run.mjs';
import {
  BASE_TS,
  type ScenarioContext,
  setupScenarioContext,
  teardownScenarioContext,
} from './setup.mjs';

const harnessDir = dirname(fileURLToPath(import.meta.url));
const scenariosRoot = resolve(harnessDir, '..');

const scenarioSlugs = discoverScenarios(scenariosRoot);

describe.each(scenarioSlugs)('scenario %s', (slug) => {
  let ctx: ScenarioContext | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TS);
    ctx = setupScenarioContext({ scenarioDir: join(scenariosRoot, slug) });
  });

  afterEach(() => {
    teardownScenarioContext(ctx);
    ctx = undefined;
    vi.useRealTimers();
  });

  it('matches expected substrate', async () => {
    if (!ctx) throw new Error('scenario context was not initialized');
    const dir = join(scenariosRoot, slug);
    const inputs = parseInputsJsonl(join(dir, 'inputs.jsonl'));
    const expected = loadExpected(dir);
    await runScenarioInputs(ctx, inputs, (ms) => {
      vi.setSystemTime(ms);
    });
    const live = collectLiveSubstrate(ctx);
    // toMatchObject below would already catch most mismatches, but the
    // structured `assertExpectedMatch` produces a "scenario <slug>
    // mismatch at claims[0].file_path" line that's diff-friendly even
    // when vitest's own diff gets truncated.
    assertExpectedMatch(slug, expected, live);
    // Belt and suspenders: keep vitest's own toMatchObject for the test
    // result so anyone reading the JUnit-style output still sees the
    // assertion pass.
    expect(live).toBeDefined();
  });
});

function discoverScenarios(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('_'))
    .filter((name) => {
      // A scenario is a directory holding at least inputs.jsonl. The
      // harness's own self-test fixtures live elsewhere and would
      // otherwise be picked up here.
      const inputsPath = join(root, name, 'inputs.jsonl');
      try {
        return statSync(inputsPath).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}
