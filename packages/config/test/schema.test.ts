import { describe, expect, it } from 'vitest';
import { SettingsSchema, defaultSettings, loadSettings, settingsPath } from '../src/index.js';

describe('SettingsSchema', () => {
  it('parses empty object into defaults', () => {
    const parsed = SettingsSchema.parse({});
    expect(parsed.workerPort).toBe(37777);
    expect(parsed.compression.intensity).toBe('full');
  });

  it('rejects invalid intensity', () => {
    expect(() => SettingsSchema.parse({ compression: { intensity: 'xxx' } })).toThrow();
  });

  it('defaults match exported defaultSettings', () => {
    expect(defaultSettings.workerPort).toBe(37777);
    expect(defaultSettings.embedding.provider).toBe('local');
  });

  it('uses COLONY_HOME for default settings location and data dir', () => {
    const original = process.env.COLONY_HOME;
    process.env.COLONY_HOME = '/tmp/colony-test-home';
    try {
      expect(settingsPath()).toBe('/tmp/colony-test-home/settings.json');
      expect(loadSettings().dataDir).toBe('/tmp/colony-test-home');
    } finally {
      if (original === undefined) delete process.env.COLONY_HOME;
      else process.env.COLONY_HOME = original;
    }
  });
});
