import { describe, expect, it } from 'vitest';
import { detectMcpClientIdentity } from '../src/tools/heartbeat.js';

describe('MCP heartbeat identity', () => {
  it('uses tool caller agent and session_id before falling back to mcp-*', () => {
    expect(
      detectMcpClientIdentity(
        {},
        { session_id: 'codex-20260429-identity-inference', agent: 'codex' },
      ),
    ).toEqual({
      sessionId: 'codex-20260429-identity-inference',
      ide: 'codex',
      inferred_agent: 'codex',
      confidence: 0.95,
      source: 'mcp-tool-caller:agent',
    });
  });

  it('uses Codex process metadata when the client exports it', () => {
    expect(detectMcpClientIdentity({ CODEX_SESSION_ID: 'codex-live-session' })).toEqual({
      sessionId: 'codex-live-session',
      ide: 'codex',
      inferred_agent: 'codex',
      confidence: 1,
      source: 'process-env:CODEX_SESSION_ID',
    });
  });

  it('leaves evidence-free mcp sessions unbound', () => {
    const identity = detectMcpClientIdentity({}, {});
    expect(identity).toMatchObject({
      ide: 'unknown',
      inferred_agent: 'unbound',
      confidence: 0,
      source: 'unbound',
    });
    expect(identity.sessionId).toMatch(/^mcp-\d+$/);
  });
});
