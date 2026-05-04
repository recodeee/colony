import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROTECTED_FILES,
  SettingsSchema,
  defaultSettings,
  loadSettings,
  loadSettingsForCwd,
  repoSettingsPath,
  settingsPath,
} from '../src/index.js';

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
    expect(parsed.protected_files).toEqual([...DEFAULT_PROTECTED_FILES]);
    expect(parsed.protected_files).toEqual(
      expect.arrayContaining(['apps/cli/src/commands/health.ts', 'apps/cli/test/health.test.ts']),
    );
    expect(parsed.bridge.writeOmxNotepadPointer).toBe(false);
    expect(parsed.bridge.policyMode).toBe('warn');
  });

  it('rejects invalid intensity', () => {
    expect(() => SettingsSchema.parse({ compression: { intensity: 'xxx' } })).toThrow();
  });

  it('allows enabling the OMX notepad pointer bridge', () => {
    const parsed = SettingsSchema.parse({
      bridge: { writeOmxNotepadPointer: true, policyMode: 'audit-only' },
    });
    expect(parsed.bridge.writeOmxNotepadPointer).toBe(true);
    expect(parsed.bridge.policyMode).toBe('audit-only');
  });

  it('rejects unknown bridge policy modes', () => {
    expect(() => SettingsSchema.parse({ bridge: { policyMode: 'hard-block' } })).toThrow();
  });

  it('defaults match exported defaultSettings', () => {
    expect(defaultSettings.workerPort).toBe(37777);
    expect(defaultSettings.embedding.provider).toBe('local');
    expect(defaultSettings.foraging.proposalHalfLifeMinutes).toBe(60);
    expect(defaultSettings.foraging.proposalNoiseFloor).toBe(0.3);
    expect(defaultSettings.foraging.promotionThreshold).toBe(2.5);
    expect(defaultSettings.fileHeatHalfLifeMinutes).toBe(30);
    expect(defaultSettings.claimStaleMinutes).toBe(240);
    expect(defaultSettings.protected_files).toEqual([...DEFAULT_PROTECTED_FILES]);
    expect(defaultSettings.bridge.writeOmxNotepadPointer).toBe(false);
    expect(defaultSettings.bridge.policyMode).toBe('warn');
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

  it('merges repo-local settings over local defaults for hook policy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'colony-config-repo-'));
    const original = process.env.COLONY_HOME;
    try {
      process.env.COLONY_HOME = join(dir, 'home');
      const repo = join(dir, 'repo');
      mkdirSync(join(repo, '.git'), { recursive: true });
      mkdirSync(join(repo, '.colony'), { recursive: true });
      writeFileSync(
        join(repo, '.colony', 'settings.json'),
        JSON.stringify({
          bridge: { policyMode: 'block-on-conflict' },
          protected_files: ['apps/cli/src/commands/health.ts'],
        }),
        'utf8',
      );

      expect(repoSettingsPath(join(repo, 'packages', 'hooks'))).toBe(
        join(repo, '.colony', 'settings.json'),
      );
      const settings = loadSettingsForCwd(join(repo, 'packages', 'hooks'));
      expect(settings.bridge.policyMode).toBe('block-on-conflict');
      expect(settings.bridge.writeOmxNotepadPointer).toBe(false);
      expect(settings.protected_files).toEqual(['apps/cli/src/commands/health.ts']);
    } finally {
      if (original === undefined) delete process.env.COLONY_HOME;
      else process.env.COLONY_HOME = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
