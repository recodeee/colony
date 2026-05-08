import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Regression for PR #372: `.version('-v, -V, --version')` registered only
// `-v` because commander's flag spec accepts at most two flags. Plain
// `colony --version` was rejected as an unknown option, breaking
// scripts/e2e-publish.sh check #6 and any caller using the canonical
// long flag.

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, '..', 'dist', 'index.js');

function runCli(flag: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('node', [DIST, flag], {
    encoding: 'utf8',
    env: { ...process.env, COLONY_SKIP_AUTO_BUILD: '1' },
    timeout: 10_000,
  });
  return {
    status: result.status ?? -1,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

describe('colony version flags', () => {
  for (const flag of ['-v', '-V', '--version']) {
    it(`prints the version for ${flag}`, () => {
      const { status, stdout, stderr } = runCli(flag);
      expect(status, `stderr: ${stderr}`).toBe(0);
      expect(stdout).toMatch(/^\d+\.\d+\.\d+/);
    });
  }
});
