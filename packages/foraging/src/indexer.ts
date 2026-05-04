import { dirname, join } from 'node:path';
import type { MemoryStore } from '@colony/core';
import { type ForagingConceptTag, detectForagingConceptTags } from './concepts.js';
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
    const concept_tags = conceptTagsForPattern(food, p);
    const safe = redact(p.content, opts.extra_secret_env_names ?? []);
    if (!safe.trim()) continue;
    const content = prefixConceptTags(safe, concept_tags);
    const metadata: Record<string, unknown> = {
      repo_root: food.repo_root,
      example_name: food.example_name,
      manifest_kind: food.manifest_kind,
      file_path: p.file_path,
      entry_kind: p.entry_kind,
      concept_tags,
    };
    if (food.source_path) metadata.source_path = food.source_path;
    if (p.skipped_due_to !== undefined) metadata.skipped_due_to = p.skipped_due_to;
    if (p.size !== undefined) metadata.file_size = p.size;
    const id = store.addObservation({
      session_id: opts.session_id,
      kind: 'foraged-pattern',
      content,
      metadata,
    });
    if (id > 0) written += 1;
  }
  return written;
}

function conceptTagsForPattern(food: FoodSource, pattern: ForagedPattern): ForagingConceptTag[] {
  if (pattern.entry_kind === 'filetree' || pattern.entry_kind === 'skipped') return [];
  return mergeConceptTags(food.concept_tags ?? [], detectConceptTags(food, pattern));
}

function detectConceptTags(food: FoodSource, pattern: ForagedPattern): ForagingConceptTag[] {
  const hay = `${food.example_name}\n${pattern.file_path}\n${pattern.content}`.toLowerCase();
  return detectForagingConceptTags(hay);
}

function prefixConceptTags(content: string, tags: readonly ForagingConceptTag[]): string {
  if (tags.length === 0) return content;
  return `${tags.map((tag) => `concept=${tag}`).join(' ')}\n${content}`;
}

function mergeConceptTags(...groups: readonly ForagingConceptTag[][]): ForagingConceptTag[] {
  return Array.from(new Set(groups.flat())).sort();
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
  if (food.filetree_paths) {
    return Array.from(new Set(food.filetree_paths)).sort().join('\n');
  }

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
