#!/usr/bin/env tsx
/**
 * scenarios:record — run a scenario live and write expected.json from
 * the observed substrate. Author still hand-trims to subset matchers so
 * scenarios don't drift into full-row equality.
 *
 * Usage:
 *   pnpm scenarios:record <slug>
 *
 * This script is intentionally tsx-runnable (no vitest dependency) so
 * authors can iterate without spinning the full test runner.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectLiveSubstrate } from './assert.mjs';
import { parseInputsJsonl, runScenarioInputs } from './run.mjs';
import {
  BASE_TS,
  setupScenarioContext,
  teardownScenarioContext,
} from './setup.mjs';

const harnessDir = dirname(fileURLToPath(import.meta.url));
const scenariosRoot = resolve(harnessDir, '..');

const slug = process.argv[2];
if (!slug) {
  console.error('usage: pnpm scenarios:record <slug>');
  process.exit(2);
}

const dir = join(scenariosRoot, slug);
const inputsPath = join(dir, 'inputs.jsonl');
const expectedPath = join(dir, 'expected.json');

async function main(): Promise<void> {
  const restore = installDateOverride(BASE_TS);
  const ctx = setupScenarioContext({ scenarioDir: dir });
  try {
    const inputs = parseInputsJsonl(inputsPath);
    await runScenarioInputs(ctx, inputs, (ms) => {
      restore.set(ms);
    });
    const live = collectLiveSubstrate(ctx);
    writeFileSync(expectedPath, `${JSON.stringify(live, null, 2)}\n`, 'utf8');
    console.log(`wrote ${expectedPath}`);
    console.log(
      'hand-trim each entry down to the fields you actually want to assert ' +
        '(subset matchers via toMatchObject). leaving the full row in is a defect.',
    );
  } finally {
    teardownScenarioContext(ctx);
    restore.restore();
  }
}

/**
 * Override Date.now and `new Date()` so colony's clock sources read
 * back BASE_TS + offset without the vitest runtime. The override is
 * just enough to keep storage row timestamps and `TaskThread` clocks
 * deterministic for the recorder.
 */
function installDateOverride(initial: number): { set: (ms: number) => void; restore: () => void } {
  let current = initial;
  const realNow = Date.now.bind(Date);
  const RealDate = Date;
  // The override only needs to spoof `Date.now()` and the zero-arg
  // `new Date()` constructor — those are what colony's clock sources
  // call. Building this as a plain function instead of a subclass keeps
  // it out of strict-mode override-modifier checks.
  function FrozenDate(this: Date | void, ...args: unknown[]): Date | string {
    if (!(this instanceof FrozenDate)) {
      return new RealDate(current).toString();
    }
    if (args.length === 0) return new RealDate(current);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new (RealDate as any)(...args);
  }
  FrozenDate.now = (): number => current;
  FrozenDate.parse = RealDate.parse.bind(RealDate);
  FrozenDate.UTC = RealDate.UTC.bind(RealDate);
  // Wire the prototype chain so `instanceof Date` keeps working for
  // anything the runtime constructs after we install the override.
  FrozenDate.prototype = RealDate.prototype;
  // biome-ignore lint/suspicious/noExplicitAny: intentional global swap
  (globalThis as any).Date = FrozenDate;
  return {
    set(ms: number): void {
      current = ms;
    },
    restore(): void {
      // biome-ignore lint/suspicious/noExplicitAny: restoring the original
      (globalThis as any).Date = RealDate;
      Date.now = realNow;
    },
  };
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
