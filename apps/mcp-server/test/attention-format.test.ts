import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, TaskThread } from '@colony/core';
import { Client } from '@modelcontextprotocol/sdk/client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

/**
 * `attention_inbox` defaulted to a fully hydrated payload — every list
 * field carrying full message/handoff bodies. Even on a quiet inbox that
 * is multiple kB; on a busy task it dwarfs the actual signal. The
 * `format` flag now defaults to a compact (`summary` + `observation_ids`)
 * shape and an explicit `format: "full"` returns the previous behaviour.
 */

let dir: string;
let store: MemoryStore;
let client: Client;
let repoRoot: string;

function fakeGitCheckout(path: string, branch: string): void {
  mkdirSync(join(path, '.git'), { recursive: true });
  writeFileSync(join(path, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
}

function seedNoisyInbox(): void {
  store.startSession({ id: 'sender', ide: 'claude-code', cwd: repoRoot });
  store.startSession({ id: 'me', ide: 'codex', cwd: repoRoot });
  const thread = TaskThread.open(store, {
    repo_root: repoRoot,
    branch: 'feat/attention-format',
    session_id: 'sender',
  });
  thread.join('sender', 'claude');
  thread.join('me', 'codex');
  thread.handOff({
    from_session_id: 'sender',
    from_agent: 'claude',
    to_agent: 'codex',
    summary: 'transfer the auth migration',
    next_steps: ['wire POST /api/auth/exchange'],
    blockers: [],
    transferred_files: ['apps/api/src/auth.ts'],
  });
  thread.postMessage({
    from_session_id: 'sender',
    from_agent: 'claude',
    to_agent: 'codex',
    content: 'pls confirm before merging',
    urgency: 'blocking',
  });
}

async function callAttentionInbox(
  args: Record<string, unknown>,
): Promise<{ text: string; payload: Record<string, unknown> }> {
  const res = await client.callTool({
    name: 'attention_inbox',
    arguments: args,
  });
  const text =
    (res.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? '{}';
  return { text, payload: JSON.parse(text) as Record<string, unknown> };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'colony-attention-format-'));
  repoRoot = join(dir, 'repo');
  mkdirSync(repoRoot, { recursive: true });
  fakeGitCheckout(repoRoot, 'feat/attention-format');
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  const server = buildServer(store, defaultSettings);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('attention_inbox format flag', () => {
  it('defaults to compact: summary + observation_ids, no full bodies', async () => {
    seedNoisyInbox();
    const { text, payload } = await callAttentionInbox({
      session_id: 'me',
      agent: 'codex',
      repo_root: repoRoot,
    });

    expect(payload.format).toBe('compact');
    expect(payload).toHaveProperty('summary');
    expect(payload).toHaveProperty('observation_ids');
    expect(Array.isArray(payload.observation_ids)).toBe(true);
    expect(payload).toHaveProperty('hint');
    expect((payload.hint as string)).toContain('get_observations');

    // Compact payload must drop the bulky body arrays — they live behind
    // get_observations(ids) instead.
    expect(payload).not.toHaveProperty('pending_handoffs');
    expect(payload).not.toHaveProperty('unread_messages');
    expect(payload).not.toHaveProperty('coalesced_messages');
    expect(payload).not.toHaveProperty('stalled_lanes');

    // Bodies must not leak into the JSON text — that's the whole point.
    expect(text).not.toContain('transfer the auth migration');
    expect(text).not.toContain('pls confirm before merging');

    // Counts still tell the agent what it needs to know.
    const summary = payload.summary as Record<string, number>;
    expect(summary.pending_handoff_count).toBe(1);
    expect(summary.unread_message_count).toBeGreaterThanOrEqual(1);
  });

  it('returns the historical full payload when format="full"', async () => {
    seedNoisyInbox();
    const { text, payload } = await callAttentionInbox({
      session_id: 'me',
      agent: 'codex',
      repo_root: repoRoot,
      format: 'full',
    });

    // Full payload reinstates body arrays and inline content.
    expect(payload).toHaveProperty('pending_handoffs');
    expect(payload).toHaveProperty('unread_messages');
    expect(text).toContain('transfer the auth migration');
    expect(text).toContain('pls confirm before merging');
    // Full payload has no `format` discriminator field — it's the
    // canonical AttentionInbox shape.
    expect(payload.format).toBeUndefined();
  });

  it('keeps verbose/audit semantics independent of the format flag', async () => {
    seedNoisyInbox();
    const compactWithAudit = await callAttentionInbox({
      session_id: 'me',
      agent: 'codex',
      repo_root: repoRoot,
      audit: true,
    });
    expect(compactWithAudit.payload.format).toBe('compact');
    // Audit doesn't fail or coerce the format — they're orthogonal.
    expect(compactWithAudit.payload).toHaveProperty('summary');

    const fullWithVerbose = await callAttentionInbox({
      session_id: 'me',
      agent: 'codex',
      repo_root: repoRoot,
      format: 'full',
      verbose: true,
    });
    expect(fullWithVerbose.payload).toHaveProperty('pending_handoffs');
  });

  it('caps observation_ids and reports truncation', async () => {
    seedNoisyInbox();
    const { payload } = await callAttentionInbox({
      session_id: 'me',
      agent: 'codex',
      repo_root: repoRoot,
      observation_id_limit: 1,
    });
    expect((payload.observation_ids as number[]).length).toBeLessThanOrEqual(1);
    // Two seeded items (handoff + blocking message) — at limit=1 the
    // second one must show up in the truncated flag, not silently
    // disappear from the count.
    expect(payload.observation_ids_truncated).toBe(true);
  });
});
