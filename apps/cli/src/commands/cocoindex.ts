import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSettings } from '@colony/config';
import {
  type CocoIndexSessionRecord,
  buildCocoIndexSessionRecords,
  safeCocoIndexSessionFileName,
} from '@colony/core';
import type { Command } from 'commander';
import { withStorage } from '../util/store.js';

interface CocoIndexSessionsOptions {
  out: string;
  agent?: string[];
  limit: string;
  timelineLimit: string;
  maxContextChars: string;
  app: boolean;
}

export function registerCocoIndexCommand(program: Command): void {
  const group = program
    .command('cocoindex')
    .description('Export compact agent session sources for CocoIndex');

  group
    .command('sessions')
    .description('Write Codex/Claude compact session files and an optional CocoIndex app')
    .requiredOption('--out <dir>', 'output directory for CocoIndex source files')
    .option('--agent <name...>', 'agent filter; repeat values such as codex claude')
    .option('--limit <n>', 'max recent sessions to scan', '100')
    .option('--timeline-limit <n>', 'max recent observations per session', '80')
    .option('--max-context-chars <n>', 'max compact_context characters per session', '1200')
    .option('--no-app', 'skip writing colony_cocoindex_sessions.py')
    .action(async (opts: CocoIndexSessionsOptions) => {
      const settings = loadSettings();
      await withStorage(
        settings,
        (storage) => {
          const sourceOptions = {
            limit: Number.parseInt(opts.limit, 10),
            timelineLimit: Number.parseInt(opts.timelineLimit, 10),
            maxContextChars: Number.parseInt(opts.maxContextChars, 10),
            ...(opts.agent !== undefined ? { agents: opts.agent } : {}),
          };
          const records = buildCocoIndexSessionRecords(storage, {
            ...sourceOptions,
          });
          writeCocoIndexSessionSource(opts.out, records, opts.app);
          process.stdout.write(
            `wrote ${records.length} CocoIndex session source files to ${join(opts.out, 'sessions')}\n`,
          );
        },
        { readonly: true },
      );
    });
}

export function writeCocoIndexSessionSource(
  outDir: string,
  records: CocoIndexSessionRecord[],
  writeApp: boolean,
): void {
  const sessionsDir = join(outDir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  for (const record of records) {
    writeFileSync(
      join(sessionsDir, safeCocoIndexSessionFileName(record.id)),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  }
  if (writeApp) {
    writeFileSync(join(outDir, 'colony_cocoindex_sessions.py'), COCOINDEX_APP);
  }
}

export const COCOINDEX_APP = String.raw`import json
import pathlib

import cocoindex as coco
from cocoindex.connectors import localfs
from cocoindex.resources.file import PatternFilePathMatcher


@coco.fn(memo=True)
def render_session_card(file: localfs.File, outdir: pathlib.Path) -> None:
    data = json.loads(file.file_path.resolve().read_text())
    card = "\n".join(
        [
            f"# {data['agent']} session {data['id']}",
            "",
            f"- ide: {data['ide']}",
            f"- observations: {data['observation_count']}",
            f"- token_savings: {data['saved_tokens']} / {data['tokens_before']} ({data['saved_ratio']})",
            f"- compact_tokens: {data['compact_tokens']}",
            "",
            data["compact_context"],
        ]
    )
    localfs.declare_file(outdir / (file.file_path.path.stem + ".md"), card, create_parent_dirs=True)


@coco.fn
async def app_main(sourcedir: pathlib.Path, outdir: pathlib.Path) -> None:
    files = localfs.walk_dir(
        sourcedir / "sessions",
        recursive=False,
        path_matcher=PatternFilePathMatcher(included_patterns=["*.json"]),
    )
    await coco.mount_each(render_session_card, files.items(), outdir / "compact")


app = coco.App(
    "ColonyAgentSessionTokenIndex",
    app_main,
    sourcedir=pathlib.Path("."),
    outdir=pathlib.Path("."),
)
`;
