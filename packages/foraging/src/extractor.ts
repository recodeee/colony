import { type Stats, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ExampleManifestKind, ScanLimits } from './types.js';
import { FORAGING_SKIP_NAMES } from './skip-names.js';

/**
 * The subset of an `examples/<name>/` that the extractor can classify
 * without reading every file byte. Paths are relative to `abs_path`.
 */
export interface ExtractedShape {
  manifest_kind: ExampleManifestKind;
  manifest_path: string | null;
  readme_path: string | null;
  entrypoints: string[];
  /** Flat list of files visited — useful for `content_hash` computation. */
  file_tree: Array<{ path: string; size: number }>;
}

const MANIFEST_BY_FILE: ReadonlyArray<{ name: string; kind: ExampleManifestKind }> = [
  { name: 'package.json', kind: 'npm' },
  { name: 'pyproject.toml', kind: 'pypi' },
  { name: 'setup.py', kind: 'pypi' },
  { name: 'requirements.txt', kind: 'pypi' },
  { name: 'Cargo.toml', kind: 'cargo' },
  { name: 'go.mod', kind: 'go' },
];

const README_NAMES: readonly string[] = [
  'README.md',
  'README.mdx',
  'README.rst',
  'README.txt',
  'README',
];

const ENTRYPOINT_CANDIDATES: readonly string[] = [
  'src/index.ts',
  'src/index.tsx',
  'src/index.js',
  'src/index.mjs',
  'src/main.ts',
  'src/main.js',
  'src/main.rs',
  'src/main.go',
  'src/main.py',
  'index.ts',
  'index.js',
  'main.py',
  'main.go',
  'main.rs',
];

/**
 * Scan a single food source directory and return its shape. The walk
 * respects `limits` so pathological examples (node_modules copy, giant
 * test fixtures) don't stall a SessionStart hook.
 */
export function extract(abs_path: string, limits: ScanLimits): ExtractedShape {
  const file_tree = walk(abs_path, limits);
  const relPaths = new Set(file_tree.map((f) => f.path));

  const manifestHit = MANIFEST_BY_FILE.find((m) => relPaths.has(m.name));
  const manifest_kind: ExampleManifestKind = manifestHit?.kind ?? 'unknown';
  const manifest_path = manifestHit?.name ?? null;

  const readme_path = README_NAMES.find((n) => relPaths.has(n)) ?? null;

  const entrypoints = ENTRYPOINT_CANDIDATES.filter((c) => relPaths.has(c));

  return { manifest_kind, manifest_path, readme_path, entrypoints, file_tree };
}

/**
 * Small hand-rolled BFS because we want to (a) enforce depth, (b) stop
 * at `max_files_per_source`, and (c) skip dependency caches at tier 1
 * without pulling in a globbing library. Ordering inside a directory is
 * alphabetical (`readdirSync` is platform-dependent otherwise).
 */
function walk(root: string, limits: ScanLimits): Array<{ path: string; size: number }> {
  const out: Array<{ path: string; size: number }> = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0 && out.length < limits.max_files_per_source) {
    const next = queue.shift();
    if (!next) break;
    const { dir, depth } = next;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    entries.sort();

    for (const name of entries) {
      if (out.length >= limits.max_files_per_source) break;
      if (FORAGING_SKIP_NAMES.has(name)) continue;
      const abs = join(dir, name);
      let st: Stats;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      const rel = relative(root, abs);
      if (st.isDirectory()) {
        if (depth + 1 < limits.max_depth) {
          queue.push({ dir: abs, depth: depth + 1 });
        }
      } else if (st.isFile()) {
        out.push({ path: rel, size: st.size });
      }
    }
  }
  return out;
}

/**
 * Read a manifest file and return its raw text capped at `max_file_bytes`.
 * Returning null instead of throwing keeps the scanner tolerant of files
 * that disappear mid-walk.
 */
export function readCapped(abs: string, max_file_bytes: number): string | null {
  try {
    const buf = readFileSync(abs);
    if (buf.byteLength > max_file_bytes) {
      return buf.subarray(0, max_file_bytes).toString('utf8');
    }
    return buf.toString('utf8');
  } catch {
    return null;
  }
}
