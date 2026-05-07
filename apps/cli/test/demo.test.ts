import { existsSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDemo } from '../src/commands/demo.js';

describe('colony demo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('walks through claim, collision, release, retry in narrated mode', () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    });

    const result = runDemo({});

    expect(output).toContain('colony demo');
    expect(output).toContain('Frame 1.');
    expect(output).toContain('Frame 2.');
    expect(output).toContain('Frame 3.');
    expect(output).toContain('Recap.');
    expect(output).toContain('claude-code');
    expect(output).toContain('codex');
    expect(output).toContain('src/api.ts');
    expect(output).toContain('Without colony:');
    expect(output).toContain('colony install');

    expect(result.frames.map((f) => f.step)).toEqual([
      'task_created',
      'sessions_started',
      'claude_code_claim',
      'codex_claim',
      'codex_retry_after_release',
    ]);
    const claudeFrame = result.frames.find((f) => f.step === 'claude_code_claim');
    const codexFrame = result.frames.find((f) => f.step === 'codex_claim');
    const retryFrame = result.frames.find((f) => f.step === 'codex_retry_after_release');
    expect(claudeFrame?.status).toBe('claimed');
    expect(codexFrame?.status).toBe('blocked_active_owner');
    expect(retryFrame?.status).toBe('claimed');
    expect(result.cleaned_up).toBe(true);
    expect(existsSync(result.data_dir)).toBe(false);
  });

  it('emits no narration in --json mode and reports the same frames', () => {
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    });

    const result = runDemo({ json: true });

    expect(output).toBe('');
    expect(result.frames).toHaveLength(5);
    expect(result.cleaned_up).toBe(true);
  });

  it('keeps the temp data dir when --keep-data is passed', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const result = runDemo({ json: true, keepData: true });
    expect(result.cleaned_up).toBe(false);
    expect(existsSync(result.data_dir)).toBe(true);
    rmSync(result.data_dir, { recursive: true, force: true });
  });
});
