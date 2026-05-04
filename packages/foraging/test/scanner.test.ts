import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanExamplesFs } from '../src/scanner.js';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'colony-forage-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function write(rel: string, contents: string): void {
  const abs = join(repo, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, contents);
}

describe('scanExamplesFs', () => {
  it('returns an empty list when <repo>/examples does not exist', () => {
    const result = scanExamplesFs({ repo_root: repo });
    expect(result.scanned).toEqual([]);
  });

  it('discovers each subdirectory as a food source', () => {
    write('examples/stripe/package.json', '{"name":"stripe"}');
    write('examples/stripe/src/index.ts', 'export {}');
    write('examples/rust-cli/Cargo.toml', '[package]\nname = "rust-cli"');
    write('examples/rust-cli/src/main.rs', 'fn main() {}');

    const { scanned } = scanExamplesFs({ repo_root: repo });
    expect(scanned.map((s) => s.example_name)).toEqual(['rust-cli', 'stripe']);

    const stripe = scanned.find((s) => s.example_name === 'stripe');
    expect(stripe?.manifest_kind).toBe('npm');
    expect(stripe?.manifest_path).toBe('package.json');
    expect(stripe?.entrypoints).toContain('src/index.ts');

    const rust = scanned.find((s) => s.example_name === 'rust-cli');
    expect(rust?.manifest_kind).toBe('cargo');
    expect(rust?.entrypoints).toContain('src/main.rs');
  });

  it('classifies pypi / go / unknown manifest kinds', () => {
    write('examples/py/pyproject.toml', '[project]\nname = "py"');
    write('examples/goapp/go.mod', 'module goapp');
    write('examples/bare/hello.txt', 'hi');

    const { scanned } = scanExamplesFs({ repo_root: repo });
    expect(scanned.find((s) => s.example_name === 'py')?.manifest_kind).toBe('pypi');
    expect(scanned.find((s) => s.example_name === 'goapp')?.manifest_kind).toBe('go');
    expect(scanned.find((s) => s.example_name === 'bare')?.manifest_kind).toBe('unknown');
  });

  it('content_hash is stable across repeat scans of identical trees', () => {
    write('examples/one/package.json', '{"name":"one"}');
    write('examples/one/src/index.ts', 'export const x = 1');

    const first = scanExamplesFs({ repo_root: repo }).scanned[0];
    const second = scanExamplesFs({ repo_root: repo }).scanned[0];
    expect(first?.content_hash).toBeDefined();
    expect(first?.content_hash).toBe(second?.content_hash);
  });

  it('content_hash changes when a tracked file size changes', () => {
    write('examples/one/package.json', '{"name":"one"}');
    write('examples/one/src/index.ts', 'export const x = 1');

    const before = scanExamplesFs({ repo_root: repo }).scanned[0]?.content_hash;

    write('examples/one/src/index.ts', 'export const x = 1 /* edited */');

    const after = scanExamplesFs({ repo_root: repo }).scanned[0]?.content_hash;
    expect(after).not.toBe(before);
  });

  it('picks up README and notes it on the food source', () => {
    write('examples/readme-only/README.md', '# hi');
    write('examples/readme-only/package.json', '{"name":"r"}');

    const source = scanExamplesFs({ repo_root: repo }).scanned[0];
    expect(source?.readme_path).toBe('README.md');
  });

  it('honors max_files_per_source by stopping traversal early', () => {
    for (let i = 0; i < 10; i++) {
      write(`examples/many/src/f${i}.ts`, `// ${i}`);
    }
    write('examples/many/package.json', '{"name":"many"}');

    const { scanned } = scanExamplesFs({
      repo_root: repo,
      limits: { max_files_per_source: 3 },
    });
    // The hash must still be computed; content_hash presence is the proof
    // the walk terminated cleanly rather than scanning all 11 files.
    expect(scanned[0]?.content_hash).toBeDefined();
    expect(scanned[0]?.file_tree.length).toBeLessThanOrEqual(3);
    expect(scanned[0]?.skipped_files.some((s) => s.skipped_due_to === 'budget')).toBe(true);
  });

  it('ignores node_modules and other skip-listed directories', () => {
    write('examples/app/package.json', '{"name":"app"}');
    write('examples/app/node_modules/dep/index.js', '// should be ignored');
    write('examples/app/src/index.ts', 'export {}');

    const source = scanExamplesFs({ repo_root: repo }).scanned[0];
    // Must not see node_modules via entrypoint list; src/index.ts must.
    expect(source?.entrypoints).toContain('src/index.ts');
    expect(source?.entrypoints.some((e) => e.includes('node_modules'))).toBe(false);
  });

  it('filters large nested dumps with deterministic skip reasons', () => {
    write('examples/app/package.json', '{"name":"app"}');
    write('examples/app/package-lock.json', '{"lockfileVersion":3}');
    write('examples/app/src/index.ts', 'export {}');
    write('examples/app/docs/giant.md', 'a'.repeat(256));
    write('examples/app/node_modules/dep/index.js', '// ignored dependency dump');
    write('examples/app/.git/config', '[core]');
    write('examples/app/screenshots/home.png', 'png bytes');
    write('examples/app/assets/logo.png', 'png bytes');
    write('examples/app/public/app.min.js', 'var a=1;');

    const source = scanExamplesFs({
      repo_root: repo,
      limits: { max_file_bytes: 80, max_files_per_source: 20 },
    }).scanned[0];

    expect(source?.entrypoints).toContain('src/index.ts');
    expect(source?.file_tree.map((f) => f.path)).not.toEqual(
      expect.arrayContaining([
        'package-lock.json',
        'docs/giant.md',
        'assets/logo.png',
        'public/app.min.js',
      ]),
    );

    const skipped = new Map(
      (source?.skipped_files ?? []).map((s) => [s.path, s.skipped_due_to] as const),
    );
    expect(skipped.get('.git/')).toBe('nested_git');
    expect(skipped.get('node_modules/')).toBe('generated');
    expect(skipped.get('screenshots/')).toBe('binary');
    expect(skipped.get('package-lock.json')).toBe('generated');
    expect(skipped.get('docs/giant.md')).toBe('too_large');
    expect(skipped.get('assets/logo.png')).toBe('binary');
    expect(skipped.get('public/app.min.js')).toBe('generated');
  });

  it('keeps lockfiles when no matching manifest makes them redundant', () => {
    write('examples/lock-only/package-lock.json', '{"lockfileVersion":3}');

    const source = scanExamplesFs({ repo_root: repo }).scanned[0];

    expect(source?.file_tree.map((f) => f.path)).toContain('package-lock.json');
    expect(source?.skipped_files.some((s) => s.path === 'package-lock.json')).toBe(false);
  });
});
