import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Locking the wrapper's behavior at the shell level matters because rule #10
// in CLAUDE.md ("hooks never wait on, never lose writes to, a daemon that may
// be down") is enforced by the wrapper, not by the worker. If the wrapper
// stops falling back to in-process Node when the daemon is unreachable,
// writes get silently dropped on the floor.

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = resolve(HERE, '..', 'bin', 'colony.sh');

function freeUnusedPort(): string {
  // Port 1 is reserved/privileged on Linux. Connecting to it from a
  // non-root user reliably refuses without being a wildcard. Good enough
  // for "daemon definitely not listening".
  return '1';
}

interface ShimRun {
  status: number;
  stdout: string;
  stderr: string;
  log: string;
}

function runShim(
  args: string[],
  opts: { stdin?: string; env?: NodeJS.ProcessEnv; nodeStub: string; logFile: string },
): ShimRun {
  const result = spawnSync('sh', [SHIM, ...args], {
    input: opts.stdin ?? '',
    env: {
      ...process.env,
      PATH: `${dirname(opts.nodeStub)}:${process.env.PATH ?? ''}`,
      ...(opts.env ?? {}),
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    log: existsOrEmpty(opts.logFile),
  };
}

function existsOrEmpty(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

describe('bin/colony.sh', () => {
  let dir: string;
  let stubNode: string;
  let stubLog: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'colony-shim-'));
    stubNode = join(dir, 'node');
    stubLog = join(dir, 'stub.log');
    // Stub `node`: record argv (one per line, $@ expanded with newlines)
    // and stdin so the test can assert on both. Exit 0 so `set -e` in the
    // wrapper does not propagate a stub-driven failure.
    writeFileSync(
      stubNode,
      [
        '#!/bin/sh',
        `LOG="${stubLog}"`,
        'echo "ARGV_BEGIN" >>"$LOG"',
        'for a in "$@"; do echo "$a" >>"$LOG"; done',
        'echo "ARGV_END" >>"$LOG"',
        'echo "STDIN_BEGIN" >>"$LOG"',
        'cat >>"$LOG"',
        'echo "" >>"$LOG"',
        'echo "STDIN_END" >>"$LOG"',
        'exit 0',
      ].join('\n'),
    );
    chmodSync(stubNode, 0o755);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exists and is executable when packaged', () => {
    const stat = statSync(SHIM);
    // Owner exec bit. npm pack preserves the executable bit when packaging,
    // so this is what e2e-publish.sh ends up installing as $PREFIX/bin/colony.
    expect(stat.mode & 0o100).toBeTruthy();
  });

  it('falls back to Node when the daemon is unreachable, with stdin and args intact (rule-10 contract)', () => {
    const envelope = '{"event_id":"e_test_1","event_name":"pre_tool_use"}';
    const result = runShim(
      ['bridge', 'lifecycle', '--json', '--ide', 'claude-code', '--cwd', '/tmp/has spaces'],
      {
        stdin: envelope,
        env: { COLONY_WORKER_PORT: freeUnusedPort() },
        nodeStub: stubNode,
        logFile: stubLog,
      },
    );

    expect(result.status).toBe(0);
    expect(result.log).toContain('ARGV_BEGIN');
    expect(result.log).toContain('bridge');
    expect(result.log).toContain('lifecycle');
    expect(result.log).toContain('--json');
    expect(result.log).toContain('--ide');
    expect(result.log).toContain('claude-code');
    expect(result.log).toContain('--cwd');
    // Quoting must be preserved across the value with the space.
    expect(result.log).toContain('/tmp/has spaces');
    expect(result.log).toContain(`STDIN_BEGIN\n${envelope}`);
  });

  it('disables the fast-path entirely when COLONY_BRIDGE_FAST=0', () => {
    const result = runShim(['bridge', 'lifecycle', '--json'], {
      stdin: '{}',
      env: { COLONY_BRIDGE_FAST: '0' },
      nodeStub: stubNode,
      logFile: stubLog,
    });

    expect(result.status).toBe(0);
    expect(result.log).toContain('bridge');
    expect(result.log).toContain('lifecycle');
  });

  it('passes through non-bridge-lifecycle commands unchanged', () => {
    const result = runShim(['--version'], {
      nodeStub: stubNode,
      logFile: stubLog,
    });

    expect(result.status).toBe(0);
    expect(result.log).toContain('--version');
  });

  it('passes through `bridge lifecycle` without --json (humans want pretty output)', () => {
    const result = runShim(['bridge', 'lifecycle'], {
      stdin: '{}',
      env: { COLONY_WORKER_PORT: freeUnusedPort() },
      nodeStub: stubNode,
      logFile: stubLog,
    });

    expect(result.status).toBe(0);
    expect(result.log).toContain('bridge');
    expect(result.log).toContain('lifecycle');
    expect(result.log).not.toContain('--json');
  });

  it('falls back to Node when COLONY_BRIDGE_NATIVE=0 forces the curl path with daemon down', () => {
    // Disabling the native binary should land us on the curl path; with
    // a definitely-unreachable port that path also falls through to Node.
    // Stdin must arrive at the stub intact (rule-10 contract via curl branch).
    const envelope = '{"event_id":"e_native_off_1","event_name":"pre_tool_use"}';
    const result = runShim(
      ['bridge', 'lifecycle', '--json', '--ide', 'codex', '--cwd', '/tmp'],
      {
        stdin: envelope,
        env: { COLONY_WORKER_PORT: freeUnusedPort(), COLONY_BRIDGE_NATIVE: '0' },
        nodeStub: stubNode,
        logFile: stubLog,
      },
    );

    expect(result.status).toBe(0);
    expect(result.log).toContain('bridge');
    expect(result.log).toContain('lifecycle');
    expect(result.log).toContain('--json');
    expect(result.log).toContain(`STDIN_BEGIN\n${envelope}`);
  });
});
