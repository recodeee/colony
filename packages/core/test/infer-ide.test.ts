import { describe, expect, it } from 'vitest';
import { inferIdeFromSessionId } from '../src/infer-ide.js';

describe('inferIdeFromSessionId', () => {
  it('matches @-delimited prefixes (original form)', () => {
    expect(inferIdeFromSessionId('codex@019dbcdf')).toBe('codex');
    expect(inferIdeFromSessionId('claude@7a67fdea')).toBe('claude-code');
  });

  it('matches hyphen-delimited task-named session ids', () => {
    // Regression: codex writes session ids like this when a task thread
    // is the session key. Previously split('@') kept the whole string and
    // the prefix never matched, so every row landed as 'unknown'.
    expect(
      inferIdeFromSessionId('codex-colony-usage-limit-takeover-verify-2026-04-24-20-48'),
    ).toBe('codex');
    expect(inferIdeFromSessionId('claude-code-refactor-sidebar')).toBe('claude-code');
  });

  it('normalises claude and claude-code to claude-code', () => {
    expect(inferIdeFromSessionId('claude:abc')).toBe('claude-code');
    expect(inferIdeFromSessionId('claudecode/foo')).toBe('claude-code');
  });

  it('returns undefined for unknown prefixes and empty input', () => {
    expect(inferIdeFromSessionId('some-random-id')).toBeUndefined();
    expect(inferIdeFromSessionId('')).toBeUndefined();
  });
});
