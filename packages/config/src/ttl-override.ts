import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import type { Settings } from './schema.js';

export const TTL_OVERRIDE_RELATIVE_PATH = join('.colony', 'ttl.yaml');

const TTL_KEYS = [
  'fileHeatHalfLifeMinutes',
  'claimStaleMinutes',
  'coordinationSweepIntervalMinutes',
] as const;

export type TtlOverrideKey = (typeof TTL_KEYS)[number];
export type TtlOverrideValues = Partial<Record<TtlOverrideKey, number>>;

export interface TtlOverrideSource {
  repoRoot: string | null;
  path: string | null;
  present: boolean;
  values: TtlOverrideValues;
}

export interface EffectiveTtlConfig {
  values: Record<TtlOverrideKey, number>;
  source: TtlOverrideSource;
  overriddenKeys: TtlOverrideKey[];
}

const KEY_ALIASES: Record<string, TtlOverrideKey> = {
  fileHeatHalfLifeMinutes: 'fileHeatHalfLifeMinutes',
  file_heat_half_life_minutes: 'fileHeatHalfLifeMinutes',
  'file-heat-half-life-minutes': 'fileHeatHalfLifeMinutes',
  claimStaleMinutes: 'claimStaleMinutes',
  claim_stale_minutes: 'claimStaleMinutes',
  'claim-stale-minutes': 'claimStaleMinutes',
  coordinationSweepIntervalMinutes: 'coordinationSweepIntervalMinutes',
  coordination_sweep_interval_minutes: 'coordinationSweepIntervalMinutes',
  'coordination-sweep-interval-minutes': 'coordinationSweepIntervalMinutes',
};

const MIN_BY_KEY: Record<TtlOverrideKey, number> = {
  fileHeatHalfLifeMinutes: 1,
  claimStaleMinutes: 1,
  coordinationSweepIntervalMinutes: 0,
};

export function ttlOverridePathForCwd(
  cwd = process.cwd(),
): { repoRoot: string; path: string } | null {
  const repoRoot = findRepoRoot(cwd);
  if (repoRoot === null) return null;
  return { repoRoot, path: join(repoRoot, TTL_OVERRIDE_RELATIVE_PATH) };
}

export function loadTtlOverride(cwd = process.cwd()): TtlOverrideSource {
  const resolved = ttlOverridePathForCwd(cwd);
  if (resolved === null) {
    return { repoRoot: null, path: null, present: false, values: {} };
  }
  if (!existsSync(resolved.path)) {
    return { repoRoot: resolved.repoRoot, path: resolved.path, present: false, values: {} };
  }
  return {
    repoRoot: resolved.repoRoot,
    path: resolved.path,
    present: true,
    values: parseTtlOverride(readFileSync(resolved.path, 'utf8'), resolved.path),
  };
}

export function effectiveTtlConfig(settings: Settings, cwd = process.cwd()): EffectiveTtlConfig {
  const source = loadTtlOverride(cwd);
  const values: Record<TtlOverrideKey, number> = {
    fileHeatHalfLifeMinutes: settings.fileHeatHalfLifeMinutes,
    claimStaleMinutes: settings.claimStaleMinutes,
    coordinationSweepIntervalMinutes: settings.coordinationSweepIntervalMinutes,
    ...source.values,
  };
  return {
    values,
    source,
    overriddenKeys: TTL_KEYS.filter((key) => source.values[key] !== undefined),
  };
}

export function parseTtlOverride(raw: string, path = TTL_OVERRIDE_RELATIVE_PATH): TtlOverrideValues {
  const values: TtlOverrideValues = {};
  const errors: string[] = [];

  raw.split(/\r?\n/).forEach((line, index) => {
    const trimmed = stripComment(line).trim();
    if (trimmed === '') return;
    const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (!match) {
      errors.push(`line ${index + 1}: expected "key: minutes"`);
      return;
    }
    const rawKey = match[1] ?? '';
    const key = KEY_ALIASES[rawKey];
    if (key === undefined) {
      errors.push(`line ${index + 1}: unknown TTL key "${rawKey}"`);
      return;
    }
    const parsed = Number(match[2]);
    if (!Number.isInteger(parsed) || parsed < MIN_BY_KEY[key]) {
      errors.push(`line ${index + 1}: ${rawKey} must be an integer >= ${MIN_BY_KEY[key]}`);
      return;
    }
    values[key] = parsed;
  });

  if (errors.length > 0) {
    throw new Error(`Invalid TTL override at ${path}: ${errors.join('; ')}`);
  }
  return values;
}

function stripComment(line: string): string {
  const index = line.indexOf('#');
  return index === -1 ? line : line.slice(0, index);
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
