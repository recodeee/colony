import { TaskThreadError } from '@colony/core';
import { describe, expect, it } from 'vitest';
import { mcpError } from '../src/tools/shared.js';

function decode(result: ReturnType<typeof mcpError>): { code: string; error: string } {
  const text = result.content[0]?.text ?? '{}';
  return JSON.parse(text) as { code: string; error: string };
}

describe('mcpError fallback', () => {
  it('codes generic Error throws as INTERNAL_ERROR, not OBSERVATION_NOT_ON_TASK', () => {
    const payload = decode(
      mcpError(new Error('reflexion observation_summary must be <= 240 chars')),
    );
    expect(payload.code).toBe('INTERNAL_ERROR');
    expect(payload.error).toBe('reflexion observation_summary must be <= 240 chars');
  });

  it('codes sqlite "database is locked" as INTERNAL_ERROR', () => {
    const payload = decode(mcpError(new Error('database is locked')));
    expect(payload.code).toBe('INTERNAL_ERROR');
  });

  it('preserves the structured code on TaskThreadError', () => {
    const payload = decode(mcpError(new TaskThreadError('TASK_NOT_FOUND', 'task 6 not found')));
    expect(payload.code).toBe('TASK_NOT_FOUND');
    expect(payload.error).toBe('task 6 not found');
  });
});
