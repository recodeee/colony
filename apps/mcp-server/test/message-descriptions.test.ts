import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const messageToolSource = readFileSync(resolve(here, '../src/tools/message.ts'), 'utf8');
const attentionToolSource = readFileSync(resolve(here, '../src/tools/attention.ts'), 'utf8');
const mcpDocsSource = readFileSync(resolve(here, '../../../docs/mcp.md'), 'utf8');

describe('message tool descriptions', () => {
  it('keeps directed-message discovery phrases visible', () => {
    expect(messageToolSource).toContain('Send a message to another agent.');
    expect(messageToolSource).toContain('Read unread messages.');
    expect(messageToolSource).toContain('Mark message read.');
    expect(messageToolSource).toContain('Claim broadcast.');
    expect(messageToolSource).toContain('Retract sent message.');
  });

  it('points agents to the right inbox and hydration lifecycle', () => {
    expect(messageToolSource).toContain('instead of generic task_post notes');
    expect(messageToolSource).toContain('fetch full bodies via get_observations');
    expect(attentionToolSource).toContain('main surface where task_message items show up');
    expect(mcpDocsSource).toContain(
      'Directed-message workflow: `task_message` -> `attention_inbox` / `task_messages` -> `get_observations` -> `task_message_mark_read` -> reply.',
    );
    expect(mcpDocsSource).toContain('This is the main surface where `task_message` items show up');
  });
});
