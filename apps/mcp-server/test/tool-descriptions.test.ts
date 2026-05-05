import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readToolDescription(relativePath: string, toolName: string): string {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const match = source.match(new RegExp(`server\\.tool\\(\\s*'${toolName}',\\s*\\n\\s*'([^']+)'`));
  const description = match?.[1];
  if (description === undefined) throw new Error(`description not found for ${toolName}`);
  return description;
}

function registeredToolNames(): string[] {
  const toolsDir = new URL('../src/tools/', import.meta.url);
  const names = new Set<string>();
  for (const file of readdirSync(toolsDir)) {
    if (!file.endsWith('.ts')) continue;
    const source = readFileSync(new URL(file, toolsDir), 'utf8');
    for (const match of source.matchAll(/server\.tool\(\s*['"]([^'"]+)/g)) {
      const name = match[1];
      if (name !== undefined) names.add(name);
    }
  }
  return [...names].sort();
}

describe('ToolSearch descriptions', () => {
  it('routes post-hivemind attention checks to attention_inbox', () => {
    const description = readToolDescription('../src/tools/attention.ts', 'attention_inbox');
    const leading = description.slice(0, 180).toLowerCase();

    expect(description).toMatch(/^See what needs your attention/);
    expect(leading).toContain('after hivemind_context');
    expect(leading).toContain('handoffs');
    expect(leading).toContain('unread messages');
    expect(leading).toContain('blockers');
    expect(leading).toContain('stalled lanes');
    expect(leading).toContain('recent claims');
  });

  it('routes work selection to task_ready_for_agent', () => {
    const description = readToolDescription('../src/tools/ready-queue.ts', 'task_ready_for_agent');
    const normalized = description.toLowerCase();

    expect(description).toMatch(
      /^Find the next task to claim for this agent\. Use this when deciding what to work on\./,
    );
    expect(normalized.slice(0, 80)).toContain('next task');
    expect(normalized.slice(0, 80)).toContain('claim');
    expect(normalized).toContain('work');
  });

  it('keeps task_list as browsing, not work selection', () => {
    const description = readToolDescription('../src/tools/task.ts', 'task_list');

    expect(description).toMatch(/^Browse task threads;/);
    expect(description).toContain('use task_ready_for_agent when choosing work to claim');
    expect(description).not.toMatch(/^Find task threads/);
  });

  it('makes task_note_working discoverable as current working state', () => {
    const description = readToolDescription('../src/tools/task.ts', 'task_note_working');
    const leading = description.slice(0, 170).toLowerCase();

    expect(description).toMatch(/^Save current working state to the active Colony task/);
    expect(leading).toContain('write working note');
    expect(leading).toContain('save current state');
    expect(leading).toContain('remember progress');
    expect(leading).toContain('log what i am doing');
    expect(leading).toContain('notepad replacement');
    expect(description).toContain('repo_root/branch');
  });

  it('documents every registered Colony MCP tool in docs/mcp.md', () => {
    const docs = readFileSync(new URL('../../../docs/mcp.md', import.meta.url), 'utf8');
    const documentedTools = new Set([...docs.matchAll(/^## `([^`]+)`/gm)].map((match) => match[1]));
    const missing = registeredToolNames().filter((name) => !documentedTools.has(name));

    expect(missing).toEqual([]);
  });
});
