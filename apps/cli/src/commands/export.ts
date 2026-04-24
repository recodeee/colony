import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSettings, resolveDataDir } from '@colony/config';
import { Storage } from '@colony/storage';
import type { Command } from 'commander';
import { z } from 'zod';

const SessionRecord = z.object({
  type: z.literal('session'),
  id: z.string(),
  ide: z.string(),
  cwd: z.string().nullable().optional(),
  started_at: z.number(),
  metadata: z.string().nullable().optional(),
});

const ObservationRecord = z.object({
  type: z.literal('observation'),
  session_id: z.string(),
  kind: z.string(),
  content: z.string(),
  compressed: z
    .union([z.boolean(), z.literal(0), z.literal(1)])
    .transform((v) => v === true || v === 1),
  intensity: z.string().nullable().optional(),
  ts: z.number().optional(),
});

export const ImportRecord = z.discriminatedUnion('type', [SessionRecord, ObservationRecord]);

export function registerExportCommand(program: Command): void {
  program
    .command('export <out>')
    .description('Export memory to JSONL')
    .action(async (out: string) => {
      const settings = loadSettings();
      const s = new Storage(join(resolveDataDir(settings.dataDir), 'data.db'), {
        readonly: true,
      });
      const lines: string[] = [];
      for (const sess of s.listSessions(10000)) {
        lines.push(JSON.stringify({ type: 'session', ...sess }));
        for (const o of s.timeline(sess.id, undefined, 10000)) {
          lines.push(JSON.stringify({ type: 'observation', ...o }));
        }
      }
      writeFileSync(out, lines.join('\n'));
      s.close();
      process.stdout.write(`wrote ${out} (${lines.length} records)\n`);
    });

  program
    .command('import <in>')
    .description('Import memory from JSONL')
    .action(async (file: string) => {
      const settings = loadSettings();
      const s = new Storage(join(resolveDataDir(settings.dataDir), 'data.db'));
      const lines = readFileSync(file, 'utf8').split(/\n+/);
      let n = 0;
      try {
        for (let i = 0; i < lines.length; i++) {
          const raw = lines[i];
          if (!raw) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch (err) {
            throw new Error(
              `${file}:${i + 1}: invalid JSON — ${(err as Error).message}`,
            );
          }
          const result = ImportRecord.safeParse(parsed);
          if (!result.success) {
            const msg = result.error.issues
              .map((iss) => `${iss.path.join('.') || '<root>'}: ${iss.message}`)
              .join('; ');
            throw new Error(`${file}:${i + 1}: ${msg}`);
          }
          const rec = result.data;
          if (rec.type === 'session') {
            s.createSession({
              id: rec.id,
              ide: rec.ide,
              cwd: rec.cwd ?? null,
              started_at: rec.started_at,
              metadata: rec.metadata ?? null,
            });
          } else {
            s.insertObservation({
              session_id: rec.session_id,
              kind: rec.kind,
              content: rec.content,
              compressed: rec.compressed,
              intensity: rec.intensity ?? null,
              ...(rec.ts !== undefined ? { ts: rec.ts } : {}),
            });
          }
          n++;
        }
      } finally {
        s.close();
      }
      process.stdout.write(`imported ${n} records\n`);
    });
}
