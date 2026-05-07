import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  RUFLO_BRIDGE_EVENT_FAMILIES,
  RUFLO_BRIDGE_EVENT_NAMES,
  type RufloBridgeEvent,
} from '@colony/core';
import type { Command } from 'commander';
import kleur from 'kleur';

const DEFAULT_RUFLO_SIDECAR_DIR = 'ruflo-sidecar';
const RUFLO_CONFIG_FILE = 'colony-ruflo-sidecar.json';
const RUFLO_EVENT_LOG_FILE = 'events.ndjson';
const RUFLO_SAMPLE_EVENT_FILE = 'sample-event.json';
const RUFLO_README_FILE = 'README.md';

type ScaffoldStatus = 'created' | 'skipped' | 'overwritten';

export interface RufloSidecarInitOptions {
  cwd?: string;
  dir?: string;
  force?: boolean;
}

export interface RufloSidecarFileResult {
  path: string;
  status: ScaffoldStatus;
}

export interface RufloSidecarInitResult {
  dir: string;
  config_path: string;
  event_log_path: string;
  files: RufloSidecarFileResult[];
  next: string[];
}

export interface RufloSidecarStatusOptions {
  cwd?: string;
  dir?: string;
}

export interface RufloSidecarStatusResult {
  dir: string;
  ready: boolean;
  config_path: string;
  config_exists: boolean;
  event_log_path: string;
  event_log_exists: boolean;
  next: string[];
}

export interface RufloSidecarSchema {
  schema: 'colony.ruflo_bridge_event.v1';
  mode: 'optional-sidecar';
  event_contract: 'RufloBridgeEvent';
  event_families: string[];
  event_names: string[];
  required_fields: string[];
  optional_fields: string[];
}

interface CliOptions {
  dir?: string;
  force?: boolean;
  json?: boolean;
}

export function initRufloSidecar(options: RufloSidecarInitOptions = {}): RufloSidecarInitResult {
  const dir = resolveSidecarDir(options);
  mkdirSync(dir, { recursive: true });

  const configPath = join(dir, RUFLO_CONFIG_FILE);
  const eventLogPath = join(dir, RUFLO_EVENT_LOG_FILE);
  const samplePath = join(dir, RUFLO_SAMPLE_EVENT_FILE);
  const readmePath = join(dir, RUFLO_README_FILE);
  const files = [
    writeScaffoldFile(
      configPath,
      `${JSON.stringify(rufloSidecarConfig(), null, 2)}\n`,
      options.force,
    ),
    writeScaffoldFile(
      samplePath,
      `${JSON.stringify(sampleRufloEvent(), null, 2)}\n`,
      options.force,
    ),
    writeScaffoldFile(eventLogPath, '', options.force),
    writeScaffoldFile(readmePath, rufloSidecarReadme(), options.force),
  ];

  return {
    dir,
    config_path: configPath,
    event_log_path: eventLogPath,
    files,
    next: [
      `Run Ruflo in ${dir}`,
      `Emit compact events as NDJSON to ${eventLogPath}`,
      `Check setup with colony sidecar ruflo status --dir ${dir}`,
    ],
  };
}

export function readRufloSidecarStatus(
  options: RufloSidecarStatusOptions = {},
): RufloSidecarStatusResult {
  const dir = resolveSidecarDir(options);
  const configPath = join(dir, RUFLO_CONFIG_FILE);
  const configExists = existsSync(configPath);
  const eventLogName = configExists ? readEventLogName(configPath) : RUFLO_EVENT_LOG_FILE;
  const eventLogPath = join(dir, eventLogName);
  const eventLogExists = existsSync(eventLogPath);
  const ready = configExists && eventLogExists;

  return {
    dir,
    ready,
    config_path: configPath,
    config_exists: configExists,
    event_log_path: eventLogPath,
    event_log_exists: eventLogExists,
    next: ready
      ? [`Append Ruflo events to ${eventLogPath}`]
      : [`Create the scaffold with colony sidecar ruflo init --dir ${dir}`],
  };
}

export function rufloSidecarSchema(): RufloSidecarSchema {
  return {
    schema: 'colony.ruflo_bridge_event.v1',
    mode: 'optional-sidecar',
    event_contract: 'RufloBridgeEvent',
    event_families: [...RUFLO_BRIDGE_EVENT_FAMILIES],
    event_names: [...RUFLO_BRIDGE_EVENT_NAMES],
    required_fields: ['name'],
    optional_fields: [
      'family',
      'run_id',
      'agent_id',
      'task_id',
      'repo_root',
      'success',
      'duration_ms',
      'summary',
      'payload',
      'body',
    ],
  };
}

export function registerSidecarCommand(program: Command): void {
  const sidecar = program.command('sidecar').description('Manage optional runtime sidecars');
  const ruflo = sidecar
    .command('ruflo')
    .description('Prepare an optional Ruflo sidecar beside Colony');

  ruflo
    .command('init')
    .description('Create a local Ruflo sidecar scaffold without vendoring Ruflo into Colony')
    .option('--dir <path>', 'sidecar directory', DEFAULT_RUFLO_SIDECAR_DIR)
    .option('--force', 'overwrite existing scaffold files', false)
    .option('--json', 'print JSON')
    .action((options: CliOptions) => {
      const result = initRufloSidecar(options);
      if (options.json) {
        writeJson(result);
        return;
      }
      process.stdout.write(`${kleur.green('✓')} Ruflo sidecar scaffold ready\n`);
      process.stdout.write(`dir: ${result.dir}\n`);
      for (const file of result.files) {
        const marker =
          file.status === 'created'
            ? kleur.green('created')
            : file.status === 'overwritten'
              ? kleur.yellow('overwritten')
              : kleur.dim('skipped');
        process.stdout.write(`  ${marker} ${file.path}\n`);
      }
      process.stdout.write(`next: ${result.next.join('; ')}\n`);
    });

  ruflo
    .command('status')
    .description('Check whether the optional Ruflo sidecar scaffold is ready')
    .option('--dir <path>', 'sidecar directory', DEFAULT_RUFLO_SIDECAR_DIR)
    .option('--json', 'print JSON')
    .action((options: CliOptions) => {
      const result = readRufloSidecarStatus(options);
      if (options.json) {
        writeJson(result);
        return;
      }
      process.stdout.write(`${kleur.bold('colony sidecar ruflo')}\n`);
      process.stdout.write(
        `status: ${result.ready ? kleur.green('ready') : kleur.yellow('missing')}\n`,
      );
      process.stdout.write(`config: ${formatExists(result.config_exists)} ${result.config_path}\n`);
      process.stdout.write(
        `events: ${formatExists(result.event_log_exists)} ${result.event_log_path}\n`,
      );
      process.stdout.write(`next: ${result.next.join('; ')}\n`);
    });

  ruflo
    .command('schema')
    .description('Print the compact event contract Ruflo should emit for Colony')
    .option('--json', 'print JSON')
    .action((options: Pick<CliOptions, 'json'>) => {
      const schema = rufloSidecarSchema();
      if (options.json) {
        writeJson(schema);
        return;
      }
      process.stdout.write(`${kleur.bold(schema.schema)}\n`);
      process.stdout.write(`mode: ${schema.mode}\n`);
      process.stdout.write(`event_contract: ${schema.event_contract}\n`);
      process.stdout.write(`event_families: ${schema.event_families.join(', ')}\n`);
      process.stdout.write(`event_names: ${schema.event_names.join(', ')}\n`);
    });
}

function resolveSidecarDir(options: RufloSidecarInitOptions | RufloSidecarStatusOptions): string {
  return resolve(options.cwd ?? process.cwd(), options.dir ?? DEFAULT_RUFLO_SIDECAR_DIR);
}

function writeScaffoldFile(path: string, content: string, force = false): RufloSidecarFileResult {
  if (existsSync(path) && !force) return { path, status: 'skipped' };
  const status: ScaffoldStatus = existsSync(path) ? 'overwritten' : 'created';
  writeFileSync(path, content);
  return { path, status };
}

function readEventLogName(configPath: string): string {
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as {
      paths?: { event_log?: unknown };
    };
    const eventLog = parsed.paths?.event_log;
    return typeof eventLog === 'string' && eventLog.length > 0 ? eventLog : RUFLO_EVENT_LOG_FILE;
  } catch {
    return RUFLO_EVENT_LOG_FILE;
  }
}

function rufloSidecarConfig(): Record<string, unknown> {
  return {
    schema: 'colony.ruflo_sidecar.v1',
    sidecar: 'ruflo',
    mode: 'optional',
    colony_bridge: {
      event_contract: 'RufloBridgeEvent',
      event_schema: 'colony.ruflo_bridge_event.v1',
      event_families: [...RUFLO_BRIDGE_EVENT_FAMILIES],
      event_names: [...RUFLO_BRIDGE_EVENT_NAMES],
    },
    paths: {
      event_log: RUFLO_EVENT_LOG_FILE,
      sample_event: RUFLO_SAMPLE_EVENT_FILE,
    },
    rules: [
      'Do not vendor Ruflo into Colony.',
      'Emit compact events only.',
      'Keep Colony as the source of truth for claims, handoffs, task threads, and health.',
      'Treat Ruflo as advisory execution input, not a hosted Colony controller.',
    ],
  };
}

function sampleRufloEvent(): RufloBridgeEvent {
  return {
    name: 'agent/finish',
    run_id: 'ruflo-run-001',
    agent_id: 'ruflo-sidecar',
    task_id: 'optional',
    repo_root: '<repo-root>',
    success: true,
    duration_ms: 1200,
    summary: 'compact Ruflo sidecar event ready for Colony bridge',
  };
}

function rufloSidecarReadme(): string {
  return `# Ruflo sidecar

This directory is an optional Ruflo sidecar for Colony. Ruflo runs here and
emits compact events. Colony remains the local-first source of truth for claims,
handoffs, task threads, health, and memory.

## Event contract

Write one JSON object per line to \`${RUFLO_EVENT_LOG_FILE}\`.

\`\`\`json
${JSON.stringify(sampleRufloEvent(), null, 2)}
\`\`\`

Accepted event names:

\`\`\`text
${RUFLO_BRIDGE_EVENT_NAMES.join('\n')}
\`\`\`

Check the scaffold:

\`\`\`bash
colony sidecar ruflo status --dir .
colony sidecar ruflo schema --json
\`\`\`
`;
}

function formatExists(exists: boolean): string {
  return exists ? kleur.green('ok') : kleur.yellow('missing');
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
