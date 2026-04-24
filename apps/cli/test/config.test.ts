import { SettingsSchema } from '@colony/config';
import { describe, expect, it } from 'vitest';
import { coerceForPath, leafSchema } from '../src/commands/config.js';

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
    expect(coerceForPath('garbage', 'compression.intensity')).toBe('garbage');
  });

  it('hands unknown paths back as raw strings so schema validation produces the error', () => {
    expect(coerceForPath('anything', 'does.not.exist')).toBe('anything');
  });
});

describe('leafSchema', () => {
  it('walks nested object paths', () => {
    expect(leafSchema(SettingsSchema, 'embedding.provider')).toBeDefined();
    expect(leafSchema(SettingsSchema, 'search.alpha')).toBeDefined();
  });

  it('returns undefined for unknown paths', () => {
    expect(leafSchema(SettingsSchema, 'bogus.path')).toBeUndefined();
  });
});
