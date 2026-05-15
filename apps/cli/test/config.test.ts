import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsSchema } from '@colony/config';
import { describe, expect, it, vi } from 'vitest';
import { coerceForPath, leafSchema } from '../src/commands/config.js';
import { createProgram } from '../src/index.js';

describe('coerceForPath (schema-directed)', () => {
  it('parses numeric settings as numbers even when the string looks like a version', () => {
    expect(coerceForPath('1', 'workerPort')).toBe(1);
    expect(coerceForPath('37777', 'workerPort')).toBe(37777);
    expect(coerceForPath('0.25', 'search.alpha')).toBe(0.25);
  });

  it('keeps string settings as strings instead of coercing number-looking ones', () => {
    expect(coerceForPath('1.0', 'embedding.model')).toBe('1.0');
    expect(coerceForPath('0.5', 'embedding.model')).toBe('0.5');
    expect(coerceForPath('Xenova/all-MiniLM-L6-v2', 'embedding.model')).toBe(
      'Xenova/all-MiniLM-L6-v2',
    );
  });

  it('parses booleans only for boolean fields', () => {
    expect(coerceForPath('true', 'embedding.autoStart')).toBe(true);
    expect(coerceForPath('true', 'search.rust.enabled')).toBe(true);
    expect(coerceForPath('false', 'privacy.redactSecrets')).toBe(false);
    // A string field named after "true" stays a string
    expect(coerceForPath('true', 'embedding.model')).toBe('true');
  });

  it('parses arrays and records via JSON', () => {
    expect(coerceForPath('["node_modules/**"]', 'privacy.excludePatterns')).toEqual([
      'node_modules/**',
    ]);
    expect(coerceForPath('{"cursor":true}', 'ides')).toEqual({ cursor: true });
  });

  it('leaves enum values as raw strings so zod can reject unknown members', () => {
    expect(coerceForPath('ultra', 'compression.intensity')).toBe('ultra');
    expect(coerceForPath('block-on-conflict', 'bridge.policyMode')).toBe('block-on-conflict');
    expect(coerceForPath('garbage', 'compression.intensity')).toBe('garbage');
  });

  it('hands unknown paths back as raw strings so schema validation produces the error', () => {
    expect(coerceForPath('anything', 'does.not.exist')).toBe('anything');
  });
});

describe('leafSchema', () => {
  it('walks nested object paths', () => {
    expect(leafSchema(SettingsSchema, 'embedding.provider')).toBeDefined();
    expect(leafSchema(SettingsSchema, 'bridge.policyMode')).toBeDefined();
    expect(leafSchema(SettingsSchema, 'search.alpha')).toBeDefined();
    expect(leafSchema(SettingsSchema, 'search.rust.timeoutMs')).toBeDefined();
  });

  it('returns undefined for unknown paths', () => {
    expect(leafSchema(SettingsSchema, 'bogus.path')).toBeUndefined();
  });
});

describe('config ttl command', () => {
  it('prints effective TTL config with per-repo .colony/ttl.yaml overrides', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'colony-cli-ttl-'));
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, '.colony'), { recursive: true });
    writeFileSync(
      join(repo, '.colony', 'ttl.yaml'),
      ['claimStaleMinutes: 77', 'coordinationSweepIntervalMinutes: 0'].join('\n'),
    );
    let output = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    });

    try {
      await createProgram().parseAsync(
        ['node', 'test', 'config', 'ttl', '--cwd', repo, '--json'],
        { from: 'node' },
      );
    } finally {
      write.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }

    const payload = JSON.parse(output) as {
      values: { claimStaleMinutes: number; coordinationSweepIntervalMinutes: number };
      source: { present: boolean; path: string };
      overriddenKeys: string[];
    };
    expect(payload.source.present).toBe(true);
    expect(payload.source.path).toBe(join(repo, '.colony', 'ttl.yaml'));
    expect(payload.values.claimStaleMinutes).toBe(77);
    expect(payload.values.coordinationSweepIntervalMinutes).toBe(0);
    expect(payload.overriddenKeys).toEqual([
      'claimStaleMinutes',
      'coordinationSweepIntervalMinutes',
    ]);
  });
});
