import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAlive, readPidFile, removePidFile, writePidFile } from '../src/index.js';

let dir: string;
let pf: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-process-'));
  pf = join(dir, 'worker.pid');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('pidfile', () => {
  it('round-trips pid via write → read', () => {
    writePidFile(pf, 4242);
    expect(readFileSync(pf, 'utf8')).toBe('4242');
    expect(readPidFile(pf)).toBe(4242);
  });

  it('defaults to process.pid when pid argument omitted', () => {
    writePidFile(pf);
    expect(readPidFile(pf)).toBe(process.pid);
  });

  it('returns null for missing, empty, or non-numeric pidfiles', () => {
    expect(readPidFile(pf)).toBeNull();
    writePidFile(pf, process.pid);
    removePidFile(pf);
    expect(readPidFile(pf)).toBeNull();
  });

  it('removePidFile is idempotent', () => {
    expect(() => removePidFile(pf)).not.toThrow();
    writePidFile(pf, 1);
    removePidFile(pf);
    expect(() => removePidFile(pf)).not.toThrow();
  });
});

describe('isAlive', () => {
  it('returns true for the current process', () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  it('rejects invalid pids', () => {
    expect(isAlive(0)).toBe(false);
    expect(isAlive(-1)).toBe(false);
    expect(isAlive(Number.NaN)).toBe(false);
  });

  it('returns false for a plausible-but-dead pid', () => {
    // 0x7fffffff is above the default pid_max on macOS + Linux
    expect(isAlive(0x7fffffff)).toBe(false);
  });
});
