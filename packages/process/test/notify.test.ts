import { describe, expect, it } from 'vitest';
import { buildNotifyArgv, notify } from '../src/index.js';

describe('notify', () => {
  it('is a no-op when provider is none', () => {
    const log: string[] = [];
    notify(
      { level: 'error', title: 'x', body: 'y' },
      { provider: 'none', log: (l) => log.push(l) },
    );
    expect(log).toEqual([]);
  });

  it('builds argv on supported platforms and null elsewhere', () => {
    const argv = buildNotifyArgv({ level: 'info', title: 't', body: 'b' });
    if (process.platform === 'darwin') expect(argv?.[0]).toBe('osascript');
    else if (process.platform === 'linux') expect(argv?.[0]).toBe('notify-send');
    else expect(argv).toBeNull();
  });

  it('strips embedded quotes, backslashes, and control chars from title/body', () => {
    const argv = buildNotifyArgv({
      level: 'error',
      title: 'col"ony',
      body: 'a\\b\nc',
    });
    if (!argv) return; // unsupported platform
    const joined = argv.join(' ');
    expect(joined.includes('"')).toBe(false);
    expect(joined.includes('\\')).toBe(false);
    expect(joined.includes('\n')).toBe(false);
  });

  it('maps levels to notify-send urgency on linux', () => {
    if (process.platform !== 'linux') return;
    const error = buildNotifyArgv({ level: 'error', title: 't', body: 'b' });
    const warn = buildNotifyArgv({ level: 'warn', title: 't', body: 'b' });
    const info = buildNotifyArgv({ level: 'info', title: 't', body: 'b' });
    expect(error?.[2]).toBe('critical');
    expect(warn?.[2]).toBe('normal');
    expect(info?.[2]).toBe('low');
  });
});
