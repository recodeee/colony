import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsSchema } from '@colony/config';
import { MemoryStore } from '@colony/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildIntegrationPlan } from '../src/integration-plan.js';
import { scanExamples } from '../src/scanner.js';

let repo: string;
let store: MemoryStore;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'colony-plan-'));
  const settings = SettingsSchema.parse({});
  store = new MemoryStore({ dbPath: join(repo, 'colony.db'), settings });
  store.startSession({ id: 's', ide: 'test', cwd: repo });
});

afterEach(() => {
  store.close();
  rmSync(repo, { recursive: true, force: true });
});

function write(rel: string, contents: string): void {
  const abs = join(repo, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, contents);
}

describe('buildIntegrationPlan', () => {
  it('reports an uncertainty note when the example was never scanned', () => {
    const plan = buildIntegrationPlan(store.storage, {
      repo_root: repo,
      example_name: 'missing',
    });
    expect(plan.example_name).toBe('missing');
    expect(plan.uncertainty_notes[0]).toMatch(/never|run.*scan|indexed row/i);
  });

  it('computes an npm dependency delta against a target package.json', () => {
    // Target repo already has `zod` — the example also wants zod (no-op)
    // and adds `stripe` (true delta). `lodash` only in target → goes to
    // `remove`, informational.
    write(
      'package.json',
      JSON.stringify({
        name: 'target',
        dependencies: { zod: '^3.23.0', lodash: '^4.17.0' },
      }),
    );
    write(
      'examples/stripe-webhook/package.json',
      JSON.stringify({
        name: 'stripe-webhook',
        dependencies: { zod: '^3.23.0', stripe: '^14.0.0' },
        scripts: { build: 'tsc', test: 'vitest' },
      }),
    );
    write('examples/stripe-webhook/src/index.ts', 'export const x = 1');

    scanExamples({ repo_root: repo, store, session_id: 's' });

    const plan = buildIntegrationPlan(store.storage, {
      repo_root: repo,
      example_name: 'stripe-webhook',
    });
    expect(plan.dependency_delta.add).toMatchObject({ stripe: '^14.0.0' });
    expect(plan.dependency_delta.add.zod).toBeUndefined();
    expect(plan.dependency_delta.remove).toContain('lodash');
    expect(plan.config_steps).toEqual(expect.arrayContaining(['npm run build', 'npm run test']));
    expect(plan.uncertainty_notes).toHaveLength(0);
  });

  it('emits uncertainty when the example manifest is a non-npm kind', () => {
    write('package.json', JSON.stringify({ name: 'target' }));
    write('examples/rust-cli/Cargo.toml', '[package]\nname = "rust-cli"');
    write('examples/rust-cli/src/main.rs', 'fn main() {}');

    scanExamples({ repo_root: repo, store, session_id: 's' });

    const plan = buildIntegrationPlan(store.storage, {
      repo_root: repo,
      example_name: 'rust-cli',
    });
    expect(plan.dependency_delta.add).toEqual({});
    expect(plan.uncertainty_notes.some((n) => /cargo/.test(n))).toBe(true);
  });

  it('files_to_copy reflects the indexed entrypoints', () => {
    write('package.json', JSON.stringify({ name: 'target' }));
    write('examples/app/package.json', JSON.stringify({ name: 'app' }));
    write('examples/app/src/index.ts', 'export {}');

    scanExamples({ repo_root: repo, store, session_id: 's' });

    const plan = buildIntegrationPlan(store.storage, {
      repo_root: repo,
      example_name: 'app',
    });
    expect(plan.files_to_copy.some((f) => f.from === 'examples/app/src/index.ts')).toBe(true);
    expect(plan.files_to_copy[0]?.to_suggestion).toBe('src/index.ts');
  });

  it('handles a missing target manifest gracefully', () => {
    // No target package.json on disk.
    write('examples/app/package.json', JSON.stringify({ dependencies: { stripe: '^14.0.0' } }));

    scanExamples({ repo_root: repo, store, session_id: 's' });

    const plan = buildIntegrationPlan(store.storage, {
      repo_root: repo,
      example_name: 'app',
    });
    expect(plan.dependency_delta.add).toMatchObject({ stripe: '^14.0.0' });
    expect(plan.uncertainty_notes.some((n) => /Target manifest not found/.test(n))).toBe(true);
  });
});
