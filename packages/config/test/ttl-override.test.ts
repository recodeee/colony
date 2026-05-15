import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultSettings } from '../src/defaults.js';
import { effectiveTtlConfig, loadTtlOverride, parseTtlOverride } from '../src/ttl-override.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-ttl-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ttl override loader', () => {
  it('parses supported YAML aliases into canonical TTL keys', () => {
    expect(
      parseTtlOverride(`
        file-heat-half-life-minutes: 10
        claim_stale_minutes: 90
        coordinationSweepIntervalMinutes: 0
      `),
    ).toEqual({
      fileHeatHalfLifeMinutes: 10,
      claimStaleMinutes: 90,
      coordinationSweepIntervalMinutes: 0,
    });
  });

  it('rejects unknown keys and invalid minute values', () => {
    expect(() =>
      parseTtlOverride(`
        claimStaleMinutes: 0
        mystery: 12
      `),
    ).toThrow(/claimStaleMinutes must be an integer >= 1/);
  });

  it('loads .colony/ttl.yaml from the repo root and merges it over settings', () => {
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, '.colony'), { recursive: true });
    writeFileSync(
      join(repo, '.colony', 'ttl.yaml'),
      ['claimStaleMinutes: 45', 'coordination-sweep-interval-minutes: 5'].join('\n'),
    );

    const source = loadTtlOverride(join(repo, 'nested'));
    expect(source).toMatchObject({
      repoRoot: repo,
      path: join(repo, '.colony', 'ttl.yaml'),
      present: true,
      values: {
        claimStaleMinutes: 45,
        coordinationSweepIntervalMinutes: 5,
      },
    });

    const effective = effectiveTtlConfig(defaultSettings, join(repo, 'nested'));
    expect(effective.values).toEqual({
      fileHeatHalfLifeMinutes: defaultSettings.fileHeatHalfLifeMinutes,
      claimStaleMinutes: 45,
      coordinationSweepIntervalMinutes: 5,
    });
    expect(effective.overriddenKeys).toEqual([
      'claimStaleMinutes',
      'coordinationSweepIntervalMinutes',
    ]);
  });
});
