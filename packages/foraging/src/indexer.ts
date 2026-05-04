import { type Stats, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { MemoryStore } from '@colony/core';
import { readCapped } from './extractor.js';
import { redact } from './redact.js';
import { FORAGING_SKIP_NAMES } from './skip-names.js';
import { DEFAULT_SCAN_LIMITS, type FoodSource, type ForagedPattern } from './types.js';

export interface IndexFoodSourceOptions {
  /** Session id that owns the foraged observations (scanner spawns one). */
  session_id: string;
  max_file_bytes?: number;
  extra_secret_env_names?: readonly string[];
}

/**
 * Convert a discovered food source into 1–N `foraged-pattern`
 * observations and persist them via `MemoryStore`. Returns the number
 * of observations actually written.
 *
 * The function assumes the caller has already cleared stale observations
 * for this (repo_root, example_name) — see `deleteForagedObservations`
 * on `Storage`. Not clearing here lets the caller distinguish "same
 * source, re-indexing" from "new source, first scan" in test assertions.
 */
export function indexFoodSource(
  food: FoodSource,
  store: MemoryStore,
  opts: IndexFoodSourceOptions,
): number {
  const maxBytes = opts.max_file_bytes ?? DEFAULT_SCAN_LIMITS.max_file_bytes;
  const patterns = buildPatterns(food, maxBytes);

  let written = 0;
  for (const p of patterns) {
    const concept_tags = detectConceptTags(food, p);
    const safe = redact(p.content, opts.extra_secret_env_names ?? []);
    if (!safe.trim()) continue;
    const id = store.addObservation({
      session_id: opts.session_id,
      kind: 'foraged-pattern',
      content: safe,
      metadata: {
        repo_root: food.repo_root,
        example_name: food.example_name,
        manifest_kind: food.manifest_kind,
        file_path: p.file_path,
        entry_kind: p.entry_kind,
        concept_tags,
      },
    });
    if (id > 0) written += 1;
  }
  return written;
}

function detectConceptTags(food: FoodSource, pattern: ForagedPattern): string[] {
  if (pattern.entry_kind === 'filetree') return [];
  const hay = `${food.example_name}\n${pattern.file_path}\n${pattern.content}`.toLowerCase();
  const tags: string[] = [];
  if (hasAny(hay, ['outcome', 'debrief', 'completion', 'verification'])) tags.push('outcome-learning');
  if (hasAny(hay, ['token', 'budget', 'compact', 'hydrate', 'collapse'])) tags.push('token-budget');
  if (hasAny(hay, ['pattern', 'memory', 'observation', 'history'])) tags.push('pattern-memory');
  if (hasAny(hay, ['trigger', 'route', 'routing', 'classify'])) tags.push('trigger-routing');
  return tags;
}

function hasAny(hay: string, needles: readonly string[]): boolean {
  return needles.some((n) => hay.includes(n));
}

/**
 * Emit patterns in a stable order so the indexed observations sit in a
 * predictable sequence: manifest first (highest signal for
 * integration), README next (human prose with usage examples),
 * entrypoints after (canonical call sites), filetree last (tail
 * context).
 */
function buildPatterns(food: FoodSource, maxBytes: number): ForagedPattern[] {
  const out: ForagedPattern[] = [];

  if (food.manifest_path) {
    const text = readCapped(join(food.abs_path, food.manifest_path), maxBytes);
    if (text !== null) {
      out.push({
        example_name: food.example_name,
        file_path: food.manifest_path,
        entry_kind: 'manifest',
        content: text,
      });
    }
  }

  if (food.readme_path) {
    const text = readCapped(join(food.abs_path, food.readme_path), maxBytes);
    if (text !== null) {
      out.push({
        example_name: food.example_name,
        file_path: food.readme_path,
        entry_kind: 'readme',
        content: text,
      });
    }
  }

  for (const ep of food.entrypoints) {
    const text = readCapped(join(food.abs_path, ep), maxBytes);
    if (text === null) continue;
    out.push({
      example_name: food.example_name,
      file_path: ep,
      entry_kind: 'entrypoint',
      content: text,
    });
  }

  const tree = renderFiletree(food.abs_path);
  if (tree) {
    out.push({
      example_name: food.example_name,
      file_path: '__filetree__',
      entry_kind: 'filetree',
      content: tree,
    });
  }

  return out;
}

/**
 * Render a small, sorted two-line-per-dir outline of the example.
 * Deliberately flat — deep directory trees get truncated by the caller
 * (`max_files_per_source` on the scanner). The output is human-readable
 * so when an agent calls `get_observations(ids[])` on a filetree
 * observation they see something they can reason about.
 */
function renderFiletree(abs_path: string): string {
  const lines: string[] = [];
  const seenDirs = new Set<string>();

  function visit(dir: string, depth: number): void {
    if (depth > 3 || lines.length > 200) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (FORAGING_SKIP_NAMES.has(name)) continue;
      const abs = join(dir, name);
      let st: Stats;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      const rel = relative(abs_path, abs);
      if (st.isDirectory()) {
        if (!seenDirs.has(rel)) {
          seenDirs.add(rel);
          lines.push(`${rel}/`);
          visit(abs, depth + 1);
        }
      } else if (st.isFile()) {
        lines.push(rel);
      }
    }
  }

  visit(abs_path, 0);
  return lines.join('\n');
}
