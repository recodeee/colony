import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { defaultSettings } from './defaults.js';
import { type Settings, SettingsSchema } from './schema.js';

const DEFAULT_DIR = '.colony';

export function resolveDataDir(raw: string): string {
  if (raw.startsWith('~')) return join(homedir(), raw.slice(1).replace(/^\/+/, ''));
  return resolve(raw);
}

function defaultDataDir(): string {
  return process.env.COLONY_HOME ?? process.env.CAVEMEM_HOME ?? join(homedir(), DEFAULT_DIR);
}

export function settingsPath(dataDir?: string): string {
  const dir = resolveDataDir(dataDir ?? defaultDataDir());
  return join(dir, 'settings.json');
}

export function loadSettings(path?: string): Settings {
  const target = path ?? settingsPath();
  if (!existsSync(target)) {
    const envDataDir = process.env.COLONY_HOME ?? process.env.CAVEMEM_HOME;
    return envDataDir ? { ...defaultSettings, dataDir: envDataDir } : defaultSettings;
  }
  try {
    const raw = JSON.parse(readFileSync(target, 'utf8'));
    return SettingsSchema.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid settings at ${target}: ${msg}`);
  }
}

export function saveSettings(settings: Settings, path?: string): void {
  const target = path ?? settingsPath(settings.dataDir);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}
