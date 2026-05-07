import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SettingsSchema, defaultSettings } from '@colony/config';
import { describe, expect, it } from 'vitest';

const POLICIES_DIR = join(__dirname, '..', '..', '..', 'examples', 'policies');

describe('examples/policies snippets', () => {
  const files = readdirSync(POLICIES_DIR).filter((name) => name.endsWith('.json'));

  it('ships at least one snippet per stack', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'nextjs-monorepo.json',
        'python-package.json',
        'rust-workspace.json',
      ]),
    );
  });

  for (const file of files) {
    it(`${file} merges into defaults and parses against SettingsSchema`, () => {
      const raw = readFileSync(join(POLICIES_DIR, file), 'utf8');
      const fragment = JSON.parse(raw) as Record<string, unknown>;
      const merged = { ...defaultSettings, ...fragment };
      const parsed = SettingsSchema.parse(merged);
      expect(parsed.privacy.excludePatterns.length).toBeGreaterThan(0);
      expect(parsed.protected_files.length).toBeGreaterThan(0);
    });
  }
});
