import { describe, expect, it } from 'vitest';
import {
  buildWorkingHandoffNote,
  isLiveWorkingHandoffMetadata,
  supersedeWorkingHandoffMetadata,
} from '../src/working-note.js';

describe('working handoff notes', () => {
  it('formats all required handoff fields in the compact order', () => {
    const note = buildWorkingHandoffNote({
      branch: 'agent/codex/demo',
      task: 'ship compact handoff notes',
      blocker: 'none',
      next: 'run focused tests',
      evidence: 'apps/mcp-server/test/task-threads.test.ts',
    });

    expect(note).toMatchObject({
      ok: true,
      note_text:
        'branch=agent/codex/demo | task=ship compact handoff notes | blocker=none | next=run focused tests | evidence=apps/mcp-server/test/task-threads.test.ts',
      fields: {
        branch: 'agent/codex/demo',
        task: 'ship compact handoff notes',
        blocker: 'none',
        next: 'run focused tests',
        evidence: 'apps/mcp-server/test/task-threads.test.ts',
      },
      errors: [],
      warnings: [],
      next_recommended_action:
        'continue work and update the working note after meaningful progress',
    });
  });

  it('rejects missing next before posting', () => {
    const note = buildWorkingHandoffNote({
      branch: 'agent/codex/demo',
      task: 'ship compact handoff notes',
      evidence: 'test output',
    });

    expect(note.ok).toBe(false);
    expect(note.errors).toContain('missing required field: next');
    expect(note.note_text).toBe('');
  });

  it('warns and compacts long proof dumps', () => {
    const note = buildWorkingHandoffNote({
      branch: 'agent/codex/demo',
      task: 'ship compact handoff notes',
      next: 'summarize status',
      evidence: `${'line 1\n'.repeat(40)}SECRET_TAIL_SHOULD_NOT_APPEAR`,
    });

    expect(note.ok).toBe(true);
    expect(note.warnings).toEqual([
      'evidence looks like a long proof/log dump; stored compact pointer only',
    ]);
    expect(note.note_text).toContain('evidence=line 1 line 1');
    expect(note.note_text).not.toContain('SECRET_TAIL_SHOULD_NOT_APPEAR');
    expect(note.fields.evidence?.length).toBeLessThanOrEqual(180);
  });

  it('marks previous auto handoff note metadata as superseded', () => {
    const current = JSON.stringify({
      kind: 'note',
      working_note: true,
      auto_handoff_note: true,
      live: true,
    });

    expect(isLiveWorkingHandoffMetadata(current)).toBe(true);
    const superseded = supersedeWorkingHandoffMetadata(current, 42, 1234);

    expect(superseded).toMatchObject({
      kind: 'note',
      working_note: true,
      auto_handoff_note: true,
      live: false,
      superseded_by_observation_id: 42,
      superseded_at: 1234,
    });
    expect(isLiveWorkingHandoffMetadata(JSON.stringify(superseded))).toBe(false);
  });
});
