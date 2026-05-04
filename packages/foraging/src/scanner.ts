import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryStore } from '@colony/core';
import { type ExtractedShape, extract, readCapped } from './extractor.js';
import { indexFoodSource } from './indexer.js';
import { DEFAULT_SCAN_LIMITS, type FoodSource, type ScanLimits, type ScanResult } from './types.js';

export interface ScanFsOptions {
  repo_root: string;
  limits?: Partial<ScanLimits>;
}

export interface ScanFsResult {
  scanned: FoodSource[];
}

/**
 * Discover food sources on disk without touching storage. Storage-aware
 * `scanExamples` (next PR) wraps this and decides which of the returned
 * sources to actually index based on `storage.getExample` hashes.
 *
 * Decoupling is deliberate: (a) the fs walk is pure and easy to test in
 * isolation, (b) the storage-aware wrapper can stay a thin orchestrator
 * with no fs logic of its own.
 */
export function scanExamplesFs(opts: ScanFsOptions): ScanFsResult {
  const limits = mergeLimits(opts.limits);
  const examplesDir = join(opts.repo_root, 'examples');

  let names: string[];
  try {
    names = readdirSync(examplesDir);
  } catch {
    return { scanned: [] };
  }
  names.sort();

  const scanned: FoodSource[] = [];
  for (const example_name of names) {
    const abs_path = join(examplesDir, example_name);
    let isDir = false;
    try {
      isDir = statSync(abs_path).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    const shape = extract(abs_path, limits);
    const content_hash = computeContentHash(abs_path, shape, limits);
    scanned.push({
      repo_root: opts.repo_root,
      example_name,
      abs_path,
      manifest_kind: shape.manifest_kind,
      manifest_path: shape.manifest_path,
      readme_path: shape.readme_path,
      entrypoints: shape.entrypoints,
      file_tree: shape.file_tree,
      skipped_files: shape.skipped_files,
      content_hash,
    });
  }
  return { scanned };
}

/**
 * Stable hash of (manifest bytes, sorted {path,size} pairs). Chosen
 * over "hash every file" because the hash runs on every SessionStart
 * and must finish in milliseconds. Size + path shifts are a sufficient
 * change signal: an edit to any tracked file moves the size, a rename
 * moves the path, a new file moves the set. A pure content-preserving
 * edit (touch, whitespace-only, etc.) will miss — acceptable since the
 * cached observations already encode the meaningful content.
 */
function computeContentHash(abs_path: string, shape: ExtractedShape, limits: ScanLimits): string {
  const hash = createHash('sha256');
  if (shape.manifest_path) {
    const manifest = readCapped(join(abs_path, shape.manifest_path), limits.max_file_bytes);
    if (manifest !== null) {
      hash.update(`manifest:${shape.manifest_path}\n`);
      hash.update(manifest);
      hash.update('\n');
    }
  }
  hash.update('filetree:\n');
  for (const f of shape.file_tree.slice().sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`${f.path}\t${f.size}\n`);
  }
  hash.update('skipped:\n');
  for (const f of shape.skipped_files.slice().sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`${f.path}\t${f.skipped_due_to}\t${f.size ?? ''}\t${f.entry_type}\n`);
  }
  return hash.digest('hex');
}

function mergeLimits(partial?: Partial<ScanLimits>): ScanLimits {
  return {
    max_depth: partial?.max_depth ?? DEFAULT_SCAN_LIMITS.max_depth,
    max_file_bytes: partial?.max_file_bytes ?? DEFAULT_SCAN_LIMITS.max_file_bytes,
    max_files_per_source: partial?.max_files_per_source ?? DEFAULT_SCAN_LIMITS.max_files_per_source,
  };
}

export interface ScanOptions {
  repo_root: string;
  store: MemoryStore;
  session_id: string;
  limits?: Partial<ScanLimits>;
  extra_secret_env_names?: readonly string[];
}

/**
 * Storage-aware scan. For each discovered food source: check the
 * cached `content_hash` on `storage.examples`. If unchanged, skip.
 * Otherwise clear stale observations, re-index, and upsert the
 * examples row with the new hash + observation count.
 *
 * Idempotent by construction: running twice on an unchanged tree
 * yields the same result the second time (all skipped). A partial
 * failure mid-index means the examples row is not upserted, so the
 * next run treats the source as changed and retries cleanly.
 */
export function scanExamples(opts: ScanOptions): ScanResult {
  const { scanned } = scanExamplesFs({
    repo_root: opts.repo_root,
    ...(opts.limits !== undefined ? { limits: opts.limits } : {}),
  });
  let skipped_unchanged = 0;
  let indexed_observations = 0;

  for (const food of scanned) {
    const existing = opts.store.storage.getExample(food.repo_root, food.example_name);
    if (existing && existing.content_hash === food.content_hash) {
      skipped_unchanged += 1;
      continue;
    }

    opts.store.storage.deleteForagedObservations(food.repo_root, food.example_name);

    const options: Parameters<typeof indexFoodSource>[2] = {
      session_id: opts.session_id,
      ...(opts.limits?.max_file_bytes !== undefined
        ? { max_file_bytes: opts.limits.max_file_bytes }
        : {}),
      ...(opts.extra_secret_env_names !== undefined
        ? { extra_secret_env_names: opts.extra_secret_env_names }
        : {}),
    };
    const count = indexFoodSource(food, opts.store, options);
    indexed_observations += count;

    opts.store.storage.upsertExample({
      repo_root: food.repo_root,
      example_name: food.example_name,
      content_hash: food.content_hash,
      manifest_kind: food.manifest_kind,
      observation_count: count,
    });
  }

  return { scanned, skipped_unchanged, indexed_observations };
}
