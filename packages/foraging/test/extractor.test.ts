import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extract, readCapped } from '../src/extractor.js';
import { DEFAULT_SCAN_LIMITS } from '../src/types.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-forage-extract-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, contents: string): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, contents);
}

describe('extract', () => {
  it('returns unknown kind with null manifest on an empty directory', () => {
    const shape = extract(dir, DEFAULT_SCAN_LIMITS);
    expect(shape.manifest_kind).toBe('unknown');
    expect(shape.manifest_path).toBeNull();
    expect(shape.readme_path).toBeNull();
    expect(shape.entrypoints).toEqual([]);
    expect(shape.file_tree).toEqual([]);
  });

  it('picks package.json over ambiguous markers and tags it as npm', () => {
    write('package.json', '{"name":"ex"}');
    write('README.md', '# ex');
    write('src/index.ts', 'export {}');

    const shape = extract(dir, DEFAULT_SCAN_LIMITS);
    expect(shape.manifest_kind).toBe('npm');
    expect(shape.manifest_path).toBe('package.json');
    expect(shape.readme_path).toBe('README.md');
    expect(shape.entrypoints).toEqual(['src/index.ts']);
  });

  it('records file_tree entries with sizes', () => {
    write('Cargo.toml', '[package]\nname = "x"');
    write('src/main.rs', 'fn main() {}');

    const shape = extract(dir, DEFAULT_SCAN_LIMITS);
    const cargo = shape.file_tree.find((f) => f.path === 'Cargo.toml');
    expect(cargo?.size).toBeGreaterThan(0);
    expect(shape.file_tree.some((f) => f.path === 'src/main.rs')).toBe(true);
  });

  it('stops walking at max_depth', () => {
    write('a.txt', 'a');
    write('nested/b.txt', 'b');
    write('nested/deep/c.txt', 'c');

    const shape = extract(dir, { ...DEFAULT_SCAN_LIMITS, max_depth: 1 });
    // Only the top-level file is visible at depth 1 (root is depth 0 and we
    // recurse when depth+1 < max_depth, so max_depth=1 means "no children").
    const paths = shape.file_tree.map((f) => f.path);
    expect(paths).toContain('a.txt');
    expect(paths).not.toContain('nested/b.txt');
  });
});

describe('readCapped', () => {
  it('reads a short file fully', () => {
    const abs = join(dir, 'small.txt');
    writeFileSync(abs, 'hello');
    expect(readCapped(abs, 1024)).toBe('hello');
  });

  it('returns null for oversize content instead of silently truncating', () => {
    const abs = join(dir, 'big.txt');
    writeFileSync(abs, 'a'.repeat(1024));
    expect(readCapped(abs, 64)).toBeNull();
  });

  it('returns null on unreadable paths', () => {
    expect(readCapped(join(dir, 'missing.txt'), 1024)).toBeNull();
  });
});
