import { dirname, join } from 'node:path';
import type { MemoryStore } from '@colony/core';
import { readCapped } from './extractor.js';
import { redact } from './redact.js';
import {
  DEFAULT_SCAN_LIMITS,
  type FoodSource,
  type ForagedPattern,
  type SkippedForagedFile,
} from './types.js';

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
        ...(p.skipped_due_to !== undefined ? { skipped_due_to: p.skipped_due_to } : {}),
        ...(p.size !== undefined ? { file_size: p.size } : {}),
        concept_tags,
      },
    });
    if (id > 0) written += 1;
  }
  return written;
}

function detectConceptTags(food: FoodSource, pattern: ForagedPattern): string[] {
  if (pattern.entry_kind === 'filetree' || pattern.entry_kind === 'skipped') return [];
  const hay = `${food.example_name}\n${pattern.file_path}\n${pattern.content}`.toLowerCase();
  const tags: string[] = [];
  if (hasAny(hay, ['outcome', 'debrief', 'completion', 'verification']))
    tags.push('outcome-learning');
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
 * entrypoints after (canonical call sites), skipped records next
 * (budget/filter evidence), filetree last (tail context).
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

  for (const skipped of food.skipped_files) {
    out.push(skippedPattern(food, skipped));
  }

  const tree = renderFiletree(food);
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
 * Render a small, sorted outline of the scanner-approved file tree.
 * The indexer never re-walks the source; scanner filters/budgets are
 * the single source of truth for what may be surfaced.
 */
function renderFiletree(food: FoodSource): string {
  const lines: string[] = [];
  const seenDirs = new Set<string>();

  for (const file of food.file_tree.slice().sort((a, b) => a.path.localeCompare(b.path))) {
    addParentDirs(file.path, lines, seenDirs);
    lines.push(file.path);
  }

  for (const skipped of food.skipped_files.slice().sort((a, b) => a.path.localeCompare(b.path))) {
    addParentDirs(skipped.path.replace(/\/$/, ''), lines, seenDirs);
    lines.push(`${skipped.path} [skipped_due_to=${skipped.skipped_due_to}]`);
  }

  return lines.join('\n');
}

function addParentDirs(path: string, lines: string[], seenDirs: Set<string>): void {
  let dir = dirname(path);
  const parents: string[] = [];
  while (dir && dir !== '.') {
    parents.push(dir);
    dir = dirname(dir);
  }
  for (const parent of parents.reverse()) {
    if (!seenDirs.has(parent)) {
      seenDirs.add(parent);
      lines.push(`${parent}/`);
    }
  }
}

function skippedPattern(food: FoodSource, skipped: SkippedForagedFile): ForagedPattern {
  return {
    example_name: food.example_name,
    file_path: skipped.path,
    entry_kind: 'skipped',
    skipped_due_to: skipped.skipped_due_to,
    size: skipped.size,
    content: [
      `path=${skipped.path}`,
      `skipped_due_to=${skipped.skipped_due_to}`,
      `entry_type=${skipped.entry_type}`,
      `size=${skipped.size ?? 'unknown'}`,
    ].join('\n'),
  };
}
