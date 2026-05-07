import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUFLO_BRIDGE_EVENT_NAMES } from '@colony/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  initRufloSidecar,
  readRufloSidecarStatus,
  rufloSidecarSchema,
} from '../src/commands/sidecar.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'colony-ruflo-sidecar-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Ruflo sidecar command helpers', () => {
  it('creates an optional sidecar scaffold without vendoring Ruflo', () => {
    const result = initRufloSidecar({ cwd: dir });

    expect(result.dir).toBe(join(dir, 'ruflo-sidecar'));
    expect(existsSync(join(result.dir, 'colony-ruflo-sidecar.json'))).toBe(true);
    expect(existsSync(join(result.dir, 'events.ndjson'))).toBe(true);
    expect(existsSync(join(result.dir, 'sample-event.json'))).toBe(true);
    expect(existsSync(join(result.dir, 'README.md'))).toBe(true);

    const config = JSON.parse(readFileSync(result.config_path, 'utf8')) as {
      sidecar: string;
      colony_bridge: { event_names: string[] };
      rules: string[];
    };
    expect(config.sidecar).toBe('ruflo');
    expect(config.colony_bridge.event_names).toContain('agent/finish');
    expect(config.rules.join(' ')).toContain('Do not vendor Ruflo into Colony');
  });

  it('does not overwrite existing scaffold files unless forced', () => {
    const first = initRufloSidecar({ cwd: dir });
    writeFileSync(first.config_path, '{"custom":true}\n');

    const second = initRufloSidecar({ cwd: dir });
    expect(second.files.find((file) => file.path === first.config_path)?.status).toBe('skipped');
    expect(readFileSync(first.config_path, 'utf8')).toBe('{"custom":true}\n');

    const forced = initRufloSidecar({ cwd: dir, force: true });
    expect(forced.files.find((file) => file.path === first.config_path)?.status).toBe(
      'overwritten',
    );
    expect(readFileSync(first.config_path, 'utf8')).toContain('colony.ruflo_sidecar.v1');
  });

  it('reports sidecar readiness from config and event log presence', () => {
    const missing = readRufloSidecarStatus({ cwd: dir });
    expect(missing.ready).toBe(false);
    expect(missing.config_exists).toBe(false);

    initRufloSidecar({ cwd: dir });
    const ready = readRufloSidecarStatus({ cwd: dir });
    expect(ready.ready).toBe(true);
    expect(ready.config_exists).toBe(true);
    expect(ready.event_log_exists).toBe(true);
  });

  it('prints the same bridge event names Ruflo events map through', () => {
    const schema = rufloSidecarSchema();
    expect(schema.event_contract).toBe('RufloBridgeEvent');
    expect(schema.event_names).toEqual([...RUFLO_BRIDGE_EVENT_NAMES]);
    expect(schema.required_fields).toEqual(['name']);
  });
});
