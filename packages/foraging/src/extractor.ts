import {
  type Stats,
  closeSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { FORAGING_SKIP_NAMES } from './skip-names.js';
import type {
  ExampleManifestKind,
  ForagedFileEntry,
  ForagingSkipReason,
  ScanLimits,
  SkippedForagedFile,
} from './types.js';

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
  file_tree: ForagedFileEntry[];
  /** Files/dirs deliberately left out of indexing, with deterministic reasons. */
  skipped_files: SkippedForagedFile[];
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

const SCREENSHOT_OR_IMAGE_DIR_NAMES = new Set([
  '__screenshots__',
  'image',
  'images',
  'img',
  'screenshot',
  'screenshots',
]);

const BINARY_FILE_EXTENSIONS = new Set([
  '.7z',
  '.avif',
  '.bin',
  '.bmp',
  '.db',
  '.gif',
  '.gz',
  '.ico',
  '.jpeg',
  '.jpg',
  '.mov',
  '.mp3',
  '.mp4',
  '.otf',
  '.pdf',
  '.png',
  '.psd',
  '.sqlite',
  '.svg',
  '.tar',
  '.tgz',
  '.tif',
  '.tiff',
  '.ttf',
  '.wav',
  '.wasm',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
  '.zip',
]);

const GENERATED_FILE_NAMES = new Set(['.eslintcache', 'coverage-final.json', 'yarn-error.log']);

const REDUNDANT_LOCKFILES: ReadonlyArray<{
  name: string;
  manifests: readonly string[];
}> = [
  { name: 'bun.lock', manifests: ['package.json'] },
  { name: 'bun.lockb', manifests: ['package.json'] },
  { name: 'Cargo.lock', manifests: ['Cargo.toml'] },
  { name: 'go.sum', manifests: ['go.mod'] },
  { name: 'npm-shrinkwrap.json', manifests: ['package.json'] },
  { name: 'package-lock.json', manifests: ['package.json'] },
  { name: 'Pipfile.lock', manifests: ['Pipfile', 'pyproject.toml', 'requirements.txt'] },
  { name: 'pnpm-lock.yaml', manifests: ['package.json'] },
  { name: 'poetry.lock', manifests: ['pyproject.toml'] },
  { name: 'uv.lock', manifests: ['pyproject.toml'] },
  { name: 'yarn.lock', manifests: ['package.json'] },
];

/**
 * Scan a single food source directory and return its shape. The walk
 * respects `limits` so pathological examples (node_modules copy, giant
 * test fixtures) don't stall a SessionStart hook.
 */
export function extract(abs_path: string, limits: ScanLimits): ExtractedShape {
  const { file_tree, skipped_files } = walk(abs_path, limits);
  const relPaths = new Set(file_tree.map((f) => f.path));

  const manifestHit = MANIFEST_BY_FILE.find((m) => relPaths.has(m.name));
  const manifest_kind: ExampleManifestKind = manifestHit?.kind ?? 'unknown';
  const manifest_path = manifestHit?.name ?? null;

  const readme_path = README_NAMES.find((n) => relPaths.has(n)) ?? null;

  const entrypoints = ENTRYPOINT_CANDIDATES.filter((c) => relPaths.has(c));

  return { manifest_kind, manifest_path, readme_path, entrypoints, file_tree, skipped_files };
}

/**
 * Small hand-rolled BFS because we want to (a) enforce depth, (b) stop
 * at `max_files_per_source`, and (c) skip dependency caches at tier 1
 * without pulling in a globbing library. Ordering inside a directory is
 * alphabetical (`readdirSync` is platform-dependent otherwise).
 */
function walk(
  root: string,
  limits: ScanLimits,
): { file_tree: ForagedFileEntry[]; skipped_files: SkippedForagedFile[] } {
  const out: ForagedFileEntry[] = [];
  const skipped: SkippedForagedFile[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  const rootFiles = readRootFileNames(root);

  while (queue.length > 0) {
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
      const abs = join(dir, name);
      let st: Stats;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      const rel = relative(root, abs);
      if (st.isDirectory()) {
        if (isBudgetExhausted(out, skipped, limits)) {
          skipped.push(skippedEntry(`${rel}/`, 'budget', st.size, 'directory'));
          return { file_tree: out, skipped_files: skipped };
        }
        const skipped_due_to = directorySkipReason(name);
        if (skipped_due_to) {
          skipped.push(skippedEntry(`${rel}/`, skipped_due_to, st.size, 'directory'));
          continue;
        }
        if (depth + 1 < limits.max_depth) {
          queue.push({ dir: abs, depth: depth + 1 });
        }
      } else if (st.isFile()) {
        if (isBudgetExhausted(out, skipped, limits)) {
          skipped.push(skippedEntry(rel, 'budget', st.size, 'file'));
          return { file_tree: out, skipped_files: skipped };
        }
        const skipped_due_to = fileSkipReason(abs, rel, st, limits, rootFiles);
        if (skipped_due_to) {
          skipped.push(skippedEntry(rel, skipped_due_to, st.size, 'file'));
          continue;
        }
        out.push({ path: rel, size: st.size });
      }
    }
  }
  return { file_tree: out, skipped_files: skipped };
}

/**
 * Read an indexed file when it fits within `max_file_bytes`. Returning
 * null instead of throwing keeps the scanner tolerant of files that
 * disappear mid-walk and prevents silent partial indexing of massive files.
 */
export function readCapped(abs: string, max_file_bytes: number): string | null {
  try {
    const buf = readFileSync(abs);
    if (buf.byteLength > max_file_bytes) {
      return null;
    }
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

function readRootFileNames(root: string): ReadonlySet<string> {
  try {
    return new Set(
      readdirSync(root)
        .sort()
        .filter((name) => {
          try {
            return statSync(join(root, name)).isFile();
          } catch {
            return false;
          }
        }),
    );
  } catch {
    return new Set();
  }
}

function directorySkipReason(name: string): ForagingSkipReason | null {
  if (name === '.git') return 'nested_git';
  if (SCREENSHOT_OR_IMAGE_DIR_NAMES.has(name.toLowerCase())) return 'binary';
  if (FORAGING_SKIP_NAMES.has(name)) return 'generated';
  return null;
}

function fileSkipReason(
  abs: string,
  rel: string,
  st: Stats,
  limits: ScanLimits,
  rootFiles: ReadonlySet<string>,
): ForagingSkipReason | null {
  const name = basename(rel);
  const lowerName = name.toLowerCase();
  const lowerRel = rel.toLowerCase();
  const ext = extname(lowerName);

  if (isRedundantLockfile(name, rootFiles)) return 'generated';
  if (isGeneratedFileName(name, lowerName, lowerRel)) return 'generated';
  if (BINARY_FILE_EXTENSIONS.has(ext)) return 'binary';
  if (st.size > limits.max_file_bytes) return 'too_large';
  if (hasNullByte(abs)) return 'binary';
  return null;
}

function isRedundantLockfile(name: string, rootFiles: ReadonlySet<string>): boolean {
  const hit = REDUNDANT_LOCKFILES.find((lockfile) => lockfile.name === name);
  return hit ? hit.manifests.some((manifest) => rootFiles.has(manifest)) : false;
}

function isGeneratedFileName(name: string, lowerName: string, lowerRel: string): boolean {
  if (GENERATED_FILE_NAMES.has(name) || GENERATED_FILE_NAMES.has(lowerName)) return true;
  if (lowerName.endsWith('.map')) return true;
  if (lowerName.endsWith('.tsbuildinfo')) return true;
  if (lowerName.endsWith('.snap')) return true;
  if (lowerName.includes('.generated.') || lowerName.includes('.gen.')) return true;
  if (/\.min\.(cjs|css|js|mjs)$/.test(lowerName)) return true;
  if (/\.(bundle|chunk)\.(cjs|css|js|mjs)$/.test(lowerName)) return true;
  return lowerRel.includes('/__generated__/') || lowerRel.includes('/generated/');
}

function hasNullByte(abs: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(abs, 'r');
    const sample = Buffer.alloc(512);
    const bytesRead = readSync(fd, sample, 0, sample.byteLength, 0);
    return sample.subarray(0, bytesRead).includes(0);
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function skippedEntry(
  path: string,
  skipped_due_to: ForagingSkipReason,
  size: number | null,
  entry_type: SkippedForagedFile['entry_type'],
): SkippedForagedFile {
  return { path, skipped_due_to, size, entry_type };
}

function isBudgetExhausted(
  out: readonly ForagedFileEntry[],
  skipped: readonly SkippedForagedFile[],
  limits: ScanLimits,
): boolean {
  return out.length + skipped.length >= limits.max_files_per_source;
}
