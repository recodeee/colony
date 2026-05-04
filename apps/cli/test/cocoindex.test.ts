import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COCOINDEX_APP, writeCocoIndexSessionSource } from '../src/commands/cocoindex.js';

describe('cocoindex command helpers', () => {
  it('writes one source file per session and the CocoIndex app', () => {
    const dir = mkdtempSync(join(tmpdir(), 'colony-cocoindex-cli-'));
    try {
      writeCocoIndexSessionSource(
        dir,
        [
          {
            id: 'codex@abc',
            ide: 'codex',
            agent: 'codex',
            cwd: '/repo',
            started_at: 1,
            ended_at: null,
            observation_count: 2,
            summary_count: 1,
            tokens_before: 100,
            tokens_after: 60,
            saved_tokens: 40,
            saved_ratio: 0.4,
            compact_tokens: 12,
            compact_context: 'compact proof',
          },
        ],
        true,
      );

      expect(readdirSync(join(dir, 'sessions'))).toEqual(['codex_abc.json']);
      expect(readFileSync(join(dir, 'sessions', 'codex_abc.json'), 'utf8')).toContain(
        '"compact_context": "compact proof"',
      );
      expect(readFileSync(join(dir, 'colony_cocoindex_sessions.py'), 'utf8')).toContain(
        'ColonyAgentSessionTokenIndex',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the generated app wired to CocoIndex incremental file processing', () => {
    expect(COCOINDEX_APP).toContain('import cocoindex as coco');
    expect(COCOINDEX_APP).toContain('@coco.fn(memo=True)');
    expect(COCOINDEX_APP).toContain('localfs.walk_dir');
    expect(COCOINDEX_APP).toContain('coco.mount_each');
  });
});
