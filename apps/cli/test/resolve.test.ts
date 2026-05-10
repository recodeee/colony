import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCliPath, resolveLocalCheckoutCliPath } from '../src/util/resolve.js';

let root: string | null = null;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

function makeTempRoot(): string {
  root = mkdtempSync(join(tmpdir(), 'colony-resolve-'));
  return root;
}

function makeCheckout({ withDist = true }: { withDist?: boolean } = {}): {
  repo: string;
  dist: string;
} {
  const repo = makeTempRoot();
  const cliDir = join(repo, 'apps', 'cli');
  mkdirSync(join(cliDir, 'dist'), { recursive: true });
  writeFileSync(join(repo, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  writeFileSync(join(cliDir, 'package.json'), '{"name":"colonyq"}\n');
  const dist = join(cliDir, 'dist', 'index.js');
  if (withDist) writeFileSync(dist, '#!/usr/bin/env node\n');
  return { repo, dist };
}

describe('resolveCliPath', () => {
  it('prefers the nearest Colony source checkout dist entry over a global argv path', () => {
    const { repo, dist } = makeCheckout();
    const nested = join(repo, 'docs', 'notes');
    mkdirSync(nested, { recursive: true });

    expect(resolveCliPath({ argv1: '/usr/local/bin/colony', cwd: nested })).toBe(dist);
  });

  it('falls back to the launched CLI path when checkout dist has not been built yet', () => {
    const { repo } = makeCheckout({ withDist: false });

    expect(resolveCliPath({ argv1: '/usr/local/bin/colony', cwd: repo })).toBe(
      '/usr/local/bin/colony',
    );
  });

  it('resolves symlinked checkout dist entries before writing IDE config paths', () => {
    const { repo, dist } = makeCheckout();
    const target = join(repo, 'linked-index.js');
    writeFileSync(target, '#!/usr/bin/env node\n');
    rmSync(dist);
    symlinkSync(target, dist);

    expect(resolveLocalCheckoutCliPath(repo)).toBe(target);
  });
});
