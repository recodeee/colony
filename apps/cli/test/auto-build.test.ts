import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectSourceRoots,
  maybeReexecAfterAutoBuild,
  shouldAutoBuild,
} from '../src/auto-build.js';

function fixture() {
  const root = join(
    tmpdir(),
    `colony-cli-auto-build-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const packageRoot = join(root, 'apps/cli');
  mkdirSync(join(packageRoot, 'src'), { recursive: true });
  mkdirSync(join(packageRoot, 'dist'), { recursive: true });
  mkdirSync(join(root, 'packages/core/src'), { recursive: true });
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
  writeFileSync(join(packageRoot, 'src/index.ts'), 'console.log("src");\n');
  writeFileSync(join(packageRoot, 'dist/index.js'), 'console.log("dist");\n');
  writeFileSync(join(root, 'packages/core/src/index.ts'), 'export const x = 1;\n');
  return { root, packageRoot, distEntry: join(packageRoot, 'dist/index.js') };
}

describe('CLI auto-build', () => {
  it('detects stale local source against dist output', () => {
    const { packageRoot, root, distEntry } = fixture();
    const old = new Date(1_000);
    const fresh = new Date(10_000);
    utimesSync(distEntry, old, old);
    utimesSync(join(packageRoot, 'src/index.ts'), fresh, fresh);

    expect(
      shouldAutoBuild({
        distEntry,
        sourceRoots: collectSourceRoots(packageRoot, root),
      }),
    ).toBe(true);
  });

  it('skips the build when dist is newer than local source', () => {
    const { packageRoot, root, distEntry } = fixture();
    const fresh = new Date(20_000);
    const old = new Date(10_000);
    utimesSync(distEntry, fresh, fresh);
    utimesSync(join(packageRoot, 'src/index.ts'), old, old);
    utimesSync(join(root, 'packages/core/src/index.ts'), old, old);

    expect(
      shouldAutoBuild({
        distEntry,
        sourceRoots: collectSourceRoots(packageRoot, root),
      }),
    ).toBe(false);
  });

  it('builds stale source and reruns the current CLI once', () => {
    const { packageRoot, root, distEntry } = fixture();
    const old = new Date(1_000);
    const fresh = new Date(10_000);
    utimesSync(distEntry, old, old);
    utimesSync(join(root, 'packages/core/src/index.ts'), fresh, fresh);

    const calls: Array<{ command: string; args: string[]; cwd: string | undefined }> = [];
    const exits: number[] = [];
    expect(() =>
      maybeReexecAfterAutoBuild({
        packageRoot,
        repoRoot: root,
        distEntry,
        argv: ['node', '/repo/apps/cli/dist/index.js', 'health'],
        env: {},
        stderr: { write: () => true },
        spawn(command, args, options) {
          calls.push({ command, args, cwd: options.cwd as string | undefined });
          return { status: 0 } as never;
        },
        exit(code) {
          exits.push(code);
          throw new Error('exit');
        },
      }),
    ).toThrow('exit');

    expect(calls).toEqual([
      {
        command: 'pnpm',
        args: ['--filter', '@imdeadpool/colony-cli', 'build'],
        cwd: root,
      },
      {
        command: process.execPath,
        args: ['/repo/apps/cli/dist/index.js', 'health'],
        cwd: undefined,
      },
    ]);
    expect(exits).toEqual([0]);
  });

  it('does not run when disabled', () => {
    const { packageRoot, root, distEntry } = fixture();
    expect(
      maybeReexecAfterAutoBuild({
        packageRoot,
        repoRoot: root,
        distEntry,
        env: { COLONY_SKIP_AUTO_BUILD: '1' },
        stderr: { write: () => true },
        spawn() {
          throw new Error('unexpected build');
        },
      }),
    ).toEqual({ ran: false, reason: 'disabled' });
  });
});
