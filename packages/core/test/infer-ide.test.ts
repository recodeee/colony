import { describe, expect, it } from 'vitest';
import { inferIdeFromSessionId, inferSessionIdentity } from '../src/infer-ide.js';

describe('inferIdeFromSessionId', () => {
  it('matches @-delimited prefixes (original form)', () => {
    expect(inferIdeFromSessionId('codex@019dbcdf')).toBe('codex');
    expect(inferIdeFromSessionId('claude@7a67fdea')).toBe('claude-code');
  });

  it('matches hyphen-delimited task-named session ids', () => {
    // Regression: codex writes session ids like this when a task thread
    // is the session key. Previously split('@') kept the whole string and
    // the prefix never matched, so every row landed as 'unknown'.
    expect(inferIdeFromSessionId('codex-colony-usage-limit-takeover-verify-2026-04-24-20-48')).toBe(
      'codex',
    );
    expect(inferIdeFromSessionId('claude-code-refactor-sidebar')).toBe('claude-code');
  });

  it('normalises claude and claude-code to claude-code', () => {
    expect(inferIdeFromSessionId('claude:abc')).toBe('claude-code');
    expect(inferIdeFromSessionId('claudecode/foo')).toBe('claude-code');
  });

  it('peels the agent/<name>/... Guardex branch form', () => {
    // Regression: some agents persist their Guardex branch name as the
    // session id. The leading segment is literally `agent`, so without
    // this special-case the row was classified as unknown.
    expect(
      inferIdeFromSessionId(
        'agent/codex/make-openspec-lighter-with-colony-spec-m-2026-04-24-21-32',
      ),
    ).toBe('codex');
    expect(inferIdeFromSessionId('agent/claude/fix-unknown-ide-owner-infer-2026-04-24-21-21')).toBe(
      'claude-code',
    );
  });

  it('returns undefined for unknown prefixes and empty input', () => {
    expect(inferIdeFromSessionId('some-random-id')).toBeUndefined();
    expect(inferIdeFromSessionId('')).toBeUndefined();
    // `agent/<unknown>/...` still falls through so we do not invent an owner.
    expect(inferIdeFromSessionId('agent/telemetry/abc')).toBeUndefined();
  });
});

describe('inferSessionIdentity', () => {
  it('uses MCP caller agent evidence before weak mcp-* session ids', () => {
    expect(
      inferSessionIdentity({
        sessionId: 'mcp-1654237',
        agent: 'codex',
        sourceHint: 'mcp-tool-caller',
      }),
    ).toEqual({
      inferred_agent: 'codex',
      ide: 'codex',
      confidence: 0.95,
      source: 'mcp-tool-caller:agent',
    });
  });

  it('derives codex from active-session branch metadata when session id is opaque', () => {
    expect(
      inferSessionIdentity({
        sessionId: 'mcp-1654237',
        ide: 'unknown',
        agent: 'agent',
        branch: 'agent/codex/task-binding',
        sourceHint: 'active-session',
      }),
    ).toMatchObject({
      inferred_agent: 'codex',
      ide: 'codex',
      confidence: 0.7,
      source: 'active-session:branch',
    });
  });

  it('labels sessions without evidence as unbound', () => {
    expect(inferSessionIdentity({ sessionId: 'mcp-1654237' })).toEqual({
      inferred_agent: 'unbound',
      ide: 'unknown',
      confidence: 0,
      source: 'unbound',
    });
  });
});
