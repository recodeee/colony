import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings } from '@colony/config';
import { MemoryStore, TaskThread } from '@colony/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

let dir: string;
let store: MemoryStore;
let client: Client;

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as T;
}

function seedTwoSessionTask(): { task_id: number; sessionA: string; sessionB: string } {
  store.startSession({ id: 'A', ide: 'claude-code', cwd: '/repo' });
  store.startSession({ id: 'B', ide: 'codex', cwd: '/repo' });
  const thread = TaskThread.open(store, {
    repo_root: '/repo',
    branch: 'feat/task-post-message-hint',
    session_id: 'A',
  });
  thread.join('A', 'claude');
  thread.join('B', 'codex');
  return { task_id: thread.task_id, sessionA: 'A', sessionB: 'B' };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'colony-task-post-message-hint-'));
  store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings: defaultSettings });
  const server = buildServer(store, defaultSettings);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
});

afterEach(async () => {
  await client.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('task_post directed message hints', () => {
  it('suggests task_message for a blocker asking a specific agent to reply', async () => {
    const { task_id, sessionB } = seedTwoSessionTask();

    const result = await call<{
      id: number;
      route_to_task_message?: boolean;
      misrouted_directed_coordination?: boolean;
      replacement_tool?: string;
      suggested_tool?: string;
      suggested_call?: string;
      suggested_args?: {
        task_id: number;
        session_id: string;
        agent: string;
        to_agent: string;
        urgency: string;
        content: string;
      };
    }>('task_post', {
      task_id,
      session_id: sessionB,
      kind: 'blocker',
      content: 'Claude please confirm whether the merge blocker needs a handoff.',
    });

    expect(result.route_to_task_message).toBe(true);
    expect(result.misrouted_directed_coordination).toBe(true);
    expect(result.replacement_tool).toBe('task_message');
    expect(result.suggested_tool).toBe('mcp__colony__task_message');
    expect(result.suggested_args).toEqual({
      task_id,
      session_id: sessionB,
      agent: 'codex',
      to_agent: 'claude',
      urgency: 'needs_reply',
      content: 'Claude please confirm whether the merge blocker needs a handoff.',
    });
    expect(result.suggested_call).toContain('mcp__colony__task_message');
    expect(result.suggested_call).toContain('agent: "codex"');
    expect(result.suggested_call).toContain('to_agent: "claude"');
    expect(result.suggested_call).toContain('urgency: "needs_reply"');
    expect(result.suggested_call).toContain('merge blocker needs a handoff');
    expect(store.storage.taskObservationsByKind(task_id, 'message', 10)).toHaveLength(0);
    expect(store.storage.getObservation(result.id)).toMatchObject({
      kind: 'blocker',
      task_id,
    });
  });

  it('suggests task_message for a blocker with explicit to_agent targeting', async () => {
    const { task_id, sessionA } = seedTwoSessionTask();

    const result = await call<{ suggested_args?: { to_agent: string; agent: string } }>(
      'task_post',
      {
        task_id,
        session_id: sessionA,
        kind: 'blocker',
        content: 'BLOCKED: to_agent=codex needs reply on final verification evidence.',
      },
    );

    expect(result.suggested_args).toMatchObject({
      agent: 'claude',
      to_agent: 'codex',
    });
  });

  it('suggests task_message for a note asking a specific agent to review', async () => {
    const { task_id, sessionA } = seedTwoSessionTask();

    const result = await call<{
      suggested_tool?: string;
      suggested_args?: { to_agent: string; urgency: string };
      hint?: string;
    }>('task_post', {
      task_id,
      session_id: sessionA,
      kind: 'note',
      content: '@codex can you review the final merge evidence?',
    });

    expect(result.suggested_tool).toBe('mcp__colony__task_message');
    expect(result.suggested_args).toMatchObject({
      to_agent: 'codex',
      urgency: 'needs_reply',
    });
    expect(result.hint).toContain('posts that need a reply');
  });

  it('suggests task_message with to_agent any when a post needs a reply without a named agent', async () => {
    const { task_id, sessionA } = seedTwoSessionTask();

    const result = await call<{
      suggested_tool?: string;
      suggested_args?: { to_agent: string; urgency: string };
    }>('task_post', {
      task_id,
      session_id: sessionA,
      kind: 'question',
      content: 'Can you check whether the inbox shows this request?',
    });

    expect(result.suggested_tool).toBe('mcp__colony__task_message');
    expect(result.suggested_args).toMatchObject({
      to_agent: 'any',
      urgency: 'needs_reply',
    });
  });

  it('does not suggest task_message for a general decision note', async () => {
    const { task_id, sessionA } = seedTwoSessionTask();

    const result = await call<{ suggested_tool?: string; suggested_call?: string }>('task_post', {
      task_id,
      session_id: sessionA,
      kind: 'decision',
      content: 'Decision: keep shared blocker evidence in the task thread timeline.',
    });

    expect(result.suggested_tool).toBeUndefined();
    expect(result.suggested_call).toBeUndefined();
  });

  it('keeps normal shared task notes on task_post', async () => {
    const { task_id, sessionA } = seedTwoSessionTask();

    const result = await call<{ suggested_tool?: string; hint?: string }>('task_post', {
      task_id,
      session_id: sessionA,
      kind: 'note',
      content: 'agent-18 recorded shared verification evidence for the task thread.',
    });

    expect(result.suggested_tool).toBeUndefined();
    expect(result.hint).toBe('If you do not know task_id, use task_note_working.');
  });
});
