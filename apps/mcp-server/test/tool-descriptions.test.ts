import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readToolDescription(relativePath: string, toolName: string): string {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const match = source.match(new RegExp(`server\\.tool\\(\\s*'${toolName}',\\s*\\n\\s*'([^']+)'`));
  const description = match?.[1];
  if (description === undefined) throw new Error(`description not found for ${toolName}`);
  return description;
}

describe('ToolSearch descriptions', () => {
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

    expect(description).toMatch(/^Save current working state to the active Colony task/);
    expect(description).toContain('without a task_id');
    expect(description).toContain('repo_root/branch');
  });
});
