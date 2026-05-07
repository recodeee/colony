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

// Walk the zod schema so `colony config set` coerces values with the shape of
// the target field instead of a regex heuristic. Compare against `_def.typeName`
// strings instead of `instanceof z.ZodFoo`: the CLI bundles its own zod copy
// via tsup, so schemas returned from `@colony/config` can originate in a
// different realpath and fail nominal `instanceof` checks even though the
// runtime shape is identical.
type ZodTypeName =
  | 'ZodDefault'
  | 'ZodOptional'
  | 'ZodNullable'
  | 'ZodObject'
  | 'ZodRecord'
  | 'ZodBoolean'
  | 'ZodNumber'
  | 'ZodString'
  | 'ZodArray'
  | 'ZodEnum';

type ZodNode = {
  _def: { type?: string; typeName?: string; shape?: unknown } & Record<string, unknown>;
  shape?: Record<string, ZodNode>;
};

function typeName(schema: unknown): ZodTypeName | undefined {
  const def = (schema as ZodNode | undefined)?._def;
  const n = def?.typeName ?? def?.type;
  if (typeof n !== 'string') return undefined;
  if (n.startsWith('Zod')) return n as ZodTypeName;
  switch (n) {
    case 'default':
      return 'ZodDefault';
    case 'optional':
      return 'ZodOptional';
    case 'nullable':
      return 'ZodNullable';
    case 'object':
      return 'ZodObject';
    case 'record':
      return 'ZodRecord';
    case 'boolean':
      return 'ZodBoolean';
    case 'number':
      return 'ZodNumber';
    case 'string':
      return 'ZodString';
    case 'array':
      return 'ZodArray';
    case 'enum':
      return 'ZodEnum';
    default:
      return undefined;
  }
}

function unwrap(schema: ZodNode): ZodNode {
  let cur = schema;
  let n = typeName(cur);
  while (n === 'ZodDefault' || n === 'ZodOptional' || n === 'ZodNullable') {
    cur = cur._def.innerType as ZodNode;
    n = typeName(cur);
  }
  return cur;
}

export function leafSchema(root: unknown, path: string): unknown {
  let cur = unwrap(root as ZodNode);
  for (const part of path.split('.')) {
    const t = typeName(cur);
    if (t === 'ZodObject') {
      const shape = objectShape(cur);
      if (!shape) return undefined;
      const child = shape[part];
      if (!child) return undefined;
      cur = unwrap(child);
      continue;
    }
    if (t === 'ZodRecord') {
      cur = unwrap(cur._def.valueType as ZodNode);
      continue;
    }
    return undefined;
  }
  return cur;
}

function objectShape(schema: ZodNode): Record<string, ZodNode> | undefined {
  const direct = schema.shape;
  if (direct && typeof direct === 'object') return direct as Record<string, ZodNode>;
  const defShape = schema._def.shape;
  if (typeof defShape === 'function') return defShape() as Record<string, ZodNode>;
  if (defShape && typeof defShape === 'object') return defShape as Record<string, ZodNode>;
  return undefined;
}

export function coerceForPath(raw: string, path: string): unknown {
  const leaf = leafSchema(SettingsSchema, path);
  if (!leaf) {
    // Unknown path — hand the raw string to validation so the zod error is the
    // source of truth instead of a separate "unknown key" message that would hide
    // the schema shape from the user.
    return raw;
  }
  const t = typeName(leaf);
  if (t === 'ZodBoolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return raw;
  }
  if (t === 'ZodNumber') {
    if (raw.trim() === '') return raw;
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (t === 'ZodArray' || t === 'ZodObject' || t === 'ZodRecord') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (t === 'ZodEnum' || t === 'ZodString') {
    return raw;
  }
  if (raw === 'null') return null;
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
      const coerced = coerceForPath(value, key);
      setDotted(next, key, coerced);
      const parsed = SettingsSchema.safeParse(next);
      if (!parsed.success) {
        process.stderr.write(`${kleur.red('invalid:')} ${parsed.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      saveSettings(parsed.data);
      process.stdout.write(`${kleur.green('✓')} ${key} = ${JSON.stringify(coerced)}\n`);
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
