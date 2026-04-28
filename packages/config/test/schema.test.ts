import { describe, expect, it } from 'vitest';
import { SettingsSchema, defaultSettings, loadSettings, settingsPath } from '../src/index.js';

describe('SettingsSchema', () => {
  it('parses empty object into defaults', () => {
    const parsed = SettingsSchema.parse({});
    expect(parsed.workerPort).toBe(37777);
    expect(parsed.compression.intensity).toBe('full');
    expect(parsed.foraging.proposalHalfLifeMinutes).toBe(60);
    expect(parsed.foraging.proposalNoiseFloor).toBe(0.3);
    expect(parsed.foraging.promotionThreshold).toBe(2.5);
    expect(parsed.fileHeatHalfLifeMinutes).toBe(30);
    expect(parsed.claimStaleMinutes).toBe(240);
    expect(parsed.bridge.writeOmxNotepadPointer).toBe(false);
  });

  it('rejects invalid intensity', () => {
    expect(() => SettingsSchema.parse({ compression: { intensity: 'xxx' } })).toThrow();
  });

  it('allows enabling the OMX notepad pointer bridge', () => {
    const parsed = SettingsSchema.parse({ bridge: { writeOmxNotepadPointer: true } });
    expect(parsed.bridge.writeOmxNotepadPointer).toBe(true);
  });

  it('defaults match exported defaultSettings', () => {
    expect(defaultSettings.workerPort).toBe(37777);
    expect(defaultSettings.embedding.provider).toBe('local');
    expect(defaultSettings.foraging.proposalHalfLifeMinutes).toBe(60);
    expect(defaultSettings.foraging.proposalNoiseFloor).toBe(0.3);
    expect(defaultSettings.foraging.promotionThreshold).toBe(2.5);
    expect(defaultSettings.fileHeatHalfLifeMinutes).toBe(30);
    expect(defaultSettings.claimStaleMinutes).toBe(240);
    expect(defaultSettings.bridge.writeOmxNotepadPointer).toBe(false);
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
