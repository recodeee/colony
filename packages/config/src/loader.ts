import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
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

export function repoSettingsPath(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) return null;
  const target = join(repoRoot, '.colony', 'settings.json');
  return existsSync(target) ? target : null;
}

export function loadSettingsForCwd(cwd: string | undefined, path?: string): Settings {
  const base = loadSettings(path);
  const repoPath = repoSettingsPath(cwd);
  if (!repoPath) return base;
  try {
    const raw = JSON.parse(readFileSync(repoPath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('repo settings must contain a JSON object');
    }
    return SettingsSchema.parse(deepMerge(base, raw as Record<string, unknown>));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid repo settings at ${repoPath}: ${msg}`);
  }
}

export function saveSettings(settings: Settings, path?: string): void {
  const target = path ?? settingsPath(settings.dataDir);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function findRepoRoot(start: string): string | null {
  let current = resolve(start);
  const root = parse(current).root;
  while (true) {
    if (existsSync(join(current, '.git'))) return current;
    if (current === root) return null;
    current = dirname(current);
  }
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    next[key] = key in next ? deepMerge(next[key], value) : value;
  }
  return next;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
