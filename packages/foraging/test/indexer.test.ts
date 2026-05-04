import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsSchema } from '@colony/config';
import { MemoryStore } from '@colony/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexFoodSource } from '../src/indexer.js';
import { scanExamples } from '../src/scanner.js';
import { scanExamplesFs } from '../src/scanner.js';

let repo: string;
let dbPath: string;
let store: MemoryStore;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'colony-index-'));
  dbPath = join(repo, 'colony.db');
  const settings = SettingsSchema.parse({});
  store = new MemoryStore({ dbPath, settings });
  store.startSession({ id: 'session-forage', ide: 'claude-code', cwd: repo });
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

describe('indexFoodSource', () => {
  it('writes observations for manifest, README, entrypoint, and filetree', () => {
    write('examples/stripe/package.json', '{"name":"stripe"}');
    write('examples/stripe/README.md', '# stripe\nUsage example.');
    write('examples/stripe/src/index.ts', 'export const x = 1');

    const { scanned } = scanExamplesFs({ repo_root: repo });
    const stripe = scanned.find((s) => s.example_name === 'stripe');
    expect(stripe).toBeDefined();
    if (!stripe) throw new Error('fixture missing');

    const count = indexFoodSource(stripe, store, { session_id: 'session-forage' });
    expect(count).toBeGreaterThanOrEqual(4);

    const rows = store.storage.listForagedObservations(repo, 'stripe');
    const kinds = rows.map((r) => {
      const md = r.metadata ? (JSON.parse(r.metadata) as { entry_kind: string }) : null;
      return md?.entry_kind;
    });
    expect(kinds).toContain('manifest');
    expect(kinds).toContain('readme');
    expect(kinds).toContain('entrypoint');
    expect(kinds).toContain('filetree');
  });

  it('persists repo_root and example_name metadata so listForagedObservations can filter', () => {
    write('examples/alpha/package.json', '{"name":"alpha"}');
    write('examples/beta/package.json', '{"name":"beta"}');

    const { scanned } = scanExamplesFs({ repo_root: repo });
    for (const f of scanned) {
      indexFoodSource(f, store, { session_id: 'session-forage' });
    }

    const alpha = store.storage.listForagedObservations(repo, 'alpha');
    const beta = store.storage.listForagedObservations(repo, 'beta');
    expect(alpha.length).toBeGreaterThan(0);
    expect(beta.length).toBeGreaterThan(0);

    const alphaNames = new Set(
      alpha.map((r) => {
        const md = r.metadata ? (JSON.parse(r.metadata) as { example_name: string }) : null;
        return md?.example_name;
      }),
    );
    expect(alphaNames).toEqual(new Set(['alpha']));
  });

  it('scrubs env-assignment secrets that appear in indexed content', () => {
    write('examples/leaky/package.json', '{"name":"leaky"}');
    write(
      'examples/leaky/README.md',
      [
        '# leaky',
        '',
        'Copy this into `.env`:',
        '',
        '```',
        'GITHUB_TOKEN=ghp_LEAKEDvalue',
        'NORMAL_FLAG=ok',
        '```',
      ].join('\n'),
    );

    const { scanned } = scanExamplesFs({ repo_root: repo });
    const leaky = scanned.find((s) => s.example_name === 'leaky');
    if (!leaky) throw new Error('fixture missing');
    indexFoodSource(leaky, store, { session_id: 'session-forage' });

    const rows = store.storage.listForagedObservations(repo, 'leaky');
    for (const r of rows) {
      expect(r.content).not.toContain('ghp_LEAKEDvalue');
    }
    // Benign config survives.
    const readmeRow = rows.find((r) => {
      const md = r.metadata ? (JSON.parse(r.metadata) as { entry_kind: string }) : null;
      return md?.entry_kind === 'readme';
    });
    expect(readmeRow).toBeDefined();
  });

  it('adds concept tags for Ruflo-like learning/token patterns', () => {
    write('examples/ruflo-lite/package.json', '{"name":"ruflo-lite"}');
    write(
      'examples/ruflo-lite/README.md',
      'Outcome learning with token budget and trigger routing improves pattern memory.',
    );
    write('examples/ruflo-lite/src/index.ts', 'export const triggerRouting = true');

    const { scanned } = scanExamplesFs({ repo_root: repo });
    const sample = scanned.find((s) => s.example_name === 'ruflo-lite');
    if (!sample) throw new Error('fixture missing');
    indexFoodSource(sample, store, { session_id: 'session-forage' });

    const rows = store.storage.listForagedObservations(repo, 'ruflo-lite');
    const allTags = new Set(
      rows.flatMap((r) => {
        const md = r.metadata ? (JSON.parse(r.metadata) as { concept_tags?: string[] }) : null;
        return md?.concept_tags ?? [];
      }),
    );
    expect(allTags.has('token-budget')).toBe(true);
    expect(allTags.has('outcome-learning')).toBe(true);
    expect(allTags.has('pattern-memory')).toBe(true);
    expect(allTags.has('trigger-routing')).toBe(true);

    const filetree = rows.find((r) => {
      const md = r.metadata
        ? (JSON.parse(r.metadata) as { entry_kind?: string; concept_tags?: string[] })
        : null;
      return md?.entry_kind === 'filetree';
    });
    const filetreeMeta = filetree?.metadata
      ? (JSON.parse(filetree.metadata) as { concept_tags?: string[] })
      : null;
    expect(filetreeMeta?.concept_tags ?? []).toEqual([]);
  });

  it('persists skipped file observations with skip-reason metadata', () => {
    write('examples/app/package.json', '{"name":"app"}');
    write('examples/app/package-lock.json', '{"lockfileVersion":3}');
    write('examples/app/src/index.ts', 'export {}');
    write('examples/app/docs/huge.md', 'x'.repeat(128));
    write('examples/app/assets/logo.png', 'png bytes');

    scanExamples({
      repo_root: repo,
      store,
      session_id: 'session-forage',
      limits: { max_file_bytes: 32, max_files_per_source: 20 },
    });

    const rows = store.storage.listForagedObservations(repo, 'app');
    const skipped = rows
      .map((r) =>
        r.metadata
          ? (JSON.parse(r.metadata) as {
              entry_kind?: string;
              file_path?: string;
              file_size?: number | null;
              skipped_due_to?: string;
            })
          : null,
      )
      .filter((m): m is NonNullable<typeof m> => m?.entry_kind === 'skipped');

    expect(skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file_path: 'package-lock.json',
          skipped_due_to: 'generated',
        }),
        expect.objectContaining({
          file_path: 'docs/huge.md',
          file_size: 128,
          skipped_due_to: 'too_large',
        }),
        expect.objectContaining({
          file_path: 'assets/logo.png',
          skipped_due_to: 'binary',
        }),
      ]),
    );
  });
});

describe('scanExamples (storage-aware)', () => {
  it('indexes on first run and skips on second run when unchanged', () => {
    write('examples/one/package.json', '{"name":"one"}');
    write('examples/one/src/index.ts', 'export {}');

    const first = scanExamples({
      repo_root: repo,
      store,
      session_id: 'session-forage',
    });
    expect(first.skipped_unchanged).toBe(0);
    expect(first.indexed_observations).toBeGreaterThan(0);
    expect(store.storage.listExamples(repo)).toHaveLength(1);

    const second = scanExamples({
      repo_root: repo,
      store,
      session_id: 'session-forage',
    });
    expect(second.skipped_unchanged).toBe(1);
    expect(second.indexed_observations).toBe(0);
    // No new observations beyond the first pass.
    expect(store.storage.listForagedObservations(repo, 'one')).toHaveLength(
      first.indexed_observations,
    );
  });

  it('re-indexes and clears stale observations when content changes', () => {
    write('examples/one/package.json', '{"name":"one"}');
    write('examples/one/src/index.ts', 'export {}');

    scanExamples({ repo_root: repo, store, session_id: 'session-forage' });
    const before = store.storage.listForagedObservations(repo, 'one').length;

    // Mutate a file so the content_hash shifts.
    write('examples/one/src/index.ts', 'export const y = 2 /* bigger */');

    const result = scanExamples({
      repo_root: repo,
      store,
      session_id: 'session-forage',
    });
    expect(result.skipped_unchanged).toBe(0);
    expect(result.indexed_observations).toBeGreaterThan(0);

    const after = store.storage.listForagedObservations(repo, 'one');
    // Exactly one generation of observations, not two — the stale set
    // must have been cleared before re-indexing.
    expect(after.length).toBe(before);
  });

  it('caches observation_count on the examples row', () => {
    write('examples/one/package.json', '{"name":"one"}');

    const result = scanExamples({
      repo_root: repo,
      store,
      session_id: 'session-forage',
    });
    const row = store.storage.getExample(repo, 'one');
    expect(row?.observation_count).toBe(result.indexed_observations);
    expect(row?.content_hash).toBe(result.scanned[0]?.content_hash);
  });
});
