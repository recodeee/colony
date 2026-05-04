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

  it('surfaces npm package considerations against a target package.json', () => {
    // Target repo already has `zod` — the example also wants zod (no-op)
    // while `stripe` appears only in the source example and becomes a
    // review-only consideration.
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
    expect(plan.dependency_considerations).toEqual([
      expect.objectContaining({ package_name: 'stripe', version: '^14.0.0' }),
    ]);
    expect(plan.dependency_considerations.some((d) => d.package_name === 'zod')).toBe(false);
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
    expect(plan.dependency_considerations).toEqual([]);
    expect(plan.uncertainty_notes.some((n) => /cargo/.test(n))).toBe(true);
  });

  it('concepts_to_port reflects indexed patterns without file-transfer wording', () => {
    write('package.json', JSON.stringify({ name: 'target' }));
    write('examples/app/package.json', JSON.stringify({ name: 'app' }));
    write('examples/app/src/index.ts', 'export const memoryPattern = true');

    scanExamples({ repo_root: repo, store, session_id: 's' });

    const plan = buildIntegrationPlan(store.storage, {
      repo_root: repo,
      example_name: 'app',
    });
    expect(plan.concepts_to_port.some((f) => f.source === 'examples/app/src/index.ts')).toBe(true);
    expect(plan.concepts_to_port[0]?.target_hint).toBe('package.json');
    expect(JSON.stringify(plan)).toContain('Port concept');
    expect(JSON.stringify(plan)).not.toContain('copy file');
    expect(JSON.stringify(plan)).not.toContain('add dependency');
  });

  it('handles a missing target manifest gracefully', () => {
    // No target package.json on disk.
    write('examples/app/package.json', JSON.stringify({ dependencies: { stripe: '^14.0.0' } }));

    scanExamples({ repo_root: repo, store, session_id: 's' });

    const plan = buildIntegrationPlan(store.storage, {
      repo_root: repo,
      example_name: 'app',
    });
    expect(plan.dependency_considerations).toEqual([
      expect.objectContaining({ package_name: 'stripe', version: '^14.0.0' }),
    ]);
    expect(plan.uncertainty_notes.some((n) => /Target manifest not found/.test(n))).toBe(true);
  });

  it('plans Ruflo sub-source paths from examples/ruflo without inventing a copied tree', () => {
    write('package.json', JSON.stringify({ name: 'target' }));
    write(
      'examples/ruflo/v3/package.json',
      JSON.stringify({
        name: 'ruflo-v3',
        dependencies: { zod: '^3.23.0' },
        scripts: { build: 'tsc' },
      }),
    );
    write('examples/ruflo/v3/README.md', '# Ruflo v3');
    write('examples/ruflo/v3/mcp/server-entry.ts', 'export const mcpBridge = true');
    write('examples/ruflo/plugins/README.md', '# plugins');

    scanExamples({ repo_root: repo, store, session_id: 's' });

    const plan = buildIntegrationPlan(store.storage, {
      repo_root: repo,
      example_name: 'ruflo-v3-mcp',
    });
    expect(plan.dependency_considerations).toEqual([
      expect.objectContaining({ package_name: 'zod', version: '^3.23.0' }),
    ]);
    expect(
      plan.concepts_to_port.some((c) => c.source === 'examples/ruflo/v3/mcp/server-entry.ts'),
    ).toBe(true);
    expect(plan.config_steps).toContain('npm run build');
  });

  it('plans curated Ruflo sub-sources from the compact root manifest', () => {
    write('package.json', JSON.stringify({ name: 'target' }));
    write(
      'examples/ruflo/package.json',
      JSON.stringify({
        name: 'ruflo',
        dependencies: { zod: '^3.23.0' },
        scripts: { build: 'tsc' },
      }),
    );
    write('examples/ruflo/README.md', '# Ruflo concept index');
    write('examples/ruflo/plugins/README.md', '# plugins');

    scanExamples({ repo_root: repo, store, session_id: 's' });

    const plan = buildIntegrationPlan(store.storage, {
      repo_root: repo,
      example_name: 'ruflo-hooks',
    });
    expect(plan.dependency_considerations).toEqual([
      expect.objectContaining({ package_name: 'zod', version: '^3.23.0' }),
    ]);
    expect(plan.concepts_to_port.some((c) => c.source === 'examples/ruflo/README.md')).toBe(true);
    expect(plan.config_steps).toContain('npm run build');
    expect(JSON.stringify(plan)).not.toContain('copy file');
  });
});
