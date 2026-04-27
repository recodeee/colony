import { describe, expect, it } from 'vitest';
import { startCaffeinate } from '../src/caffeinate.js';

describe('caffeinate', () => {
  it('returns a no-op handle on non-darwin platforms', () => {
    if (process.platform === 'darwin') return; // covered by the spawn path
    const log: string[] = [];
    const handle = startCaffeinate((line) => log.push(line));
    expect(typeof handle.stop).toBe('function');
    expect(log).toEqual([]);
    // Idempotent stop — must not throw if called twice.
    handle.stop();
    handle.stop();
  });
});
