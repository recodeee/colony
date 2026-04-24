import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  type SettingDoc,
  SettingsSchema,
  defaultSettings,
  loadSettings,
  saveSettings,
  settingsDocs,
  settingsPath,
} from '@colony/config';
import type { Command } from 'commander';
import kleur from 'kleur';

function getDotted(obj: unknown, path: string): unknown {
  let cur = obj as Record<string, unknown>;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part] as Record<string, unknown>;
  }
  return cur;
}

function setDotted(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!k) continue;
    const next = cur[k];
    if (next == null || typeof next !== 'object') {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (last) cur[last] = value;
}

function coerce(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d*\.\d+$/.test(raw)) return Number(raw);
  // Try JSON for arrays/objects; fall back to raw string.
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      return JSON.parse(raw);
    } catch {
      // fall through
    }
  }
  return raw;
}

function fmtValue(v: unknown): string {
  if (v === undefined) return 'unset';
  try {
    return JSON.stringify(v) ?? 'unset';
  } catch {
    return String(v);
  }
}

function printDocs(docs: SettingDoc[]): void {
  const settings = loadSettings();
  for (const d of docs) {
    const current = getDotted(settings, d.path);
    const def = d.default;
    const isDefault = JSON.stringify(current) === JSON.stringify(def);
    const val = fmtValue(current);
    const marker = isDefault ? kleur.dim('(default)') : kleur.yellow('(set)');
    process.stdout.write(`${kleur.cyan(d.path.padEnd(34))} ${val.padEnd(40)} ${marker}\n`);
    if (d.description) process.stdout.write(`  ${kleur.dim(d.description)}\n`);
    process.stdout.write(`  ${kleur.dim(`type: ${d.type}, default: ${fmtValue(def)}`)}\n\n`);
  }
}

export function registerConfigCommand(program: Command): void {
  const cfg = program.command('config').description('View or edit colony settings');

  cfg
    .command('show')
    .description('Show all settings with defaults + documentation')
    .action(() => {
      process.stdout.write(`${kleur.bold('settings file:')} ${settingsPath()}\n\n`);
      printDocs(settingsDocs());
    });

  cfg
    .command('path')
    .description('Print the settings file path')
    .action(() => {
      process.stdout.write(`${settingsPath()}\n`);
    });

  cfg
    .command('get <key>')
    .description('Get one setting by dotted path (e.g. embedding.provider)')
    .action((key: string) => {
      const v = getDotted(loadSettings(), key);
      if (v === undefined) {
        process.stderr.write(`${kleur.red('unknown key:')} ${key}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`${JSON.stringify(v)}\n`);
    });

  cfg
    .command('set <key> <value>')
    .description('Set one setting. Validates against the zod schema before saving.')
    .action((key: string, value: string) => {
      const settings = loadSettings();
      const next = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>;
      setDotted(next, key, coerce(value));
      const parsed = SettingsSchema.safeParse(next);
      if (!parsed.success) {
        process.stderr.write(`${kleur.red('invalid:')} ${parsed.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      saveSettings(parsed.data);
      process.stdout.write(`${kleur.green('✓')} ${key} = ${JSON.stringify(coerce(value))}\n`);
    });

  cfg
    .command('reset')
    .description('Reset all settings to defaults (writes the default file)')
    .action(() => {
      saveSettings(defaultSettings);
      process.stdout.write(`${kleur.green('✓')} reset ${settingsPath()}\n`);
    });

  cfg
    .command('open')
    .description('Open the settings file in $EDITOR')
    .action(() => {
      const p = settingsPath();
      if (!existsSync(p)) saveSettings(loadSettings());
      const editor = process.env.EDITOR ?? process.env.VISUAL ?? 'vi';
      const child = spawn(editor, [p], { stdio: 'inherit' });
      child.on('exit', (code) => process.exit(code ?? 0));
    });
}
