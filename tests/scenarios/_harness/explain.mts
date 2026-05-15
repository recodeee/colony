#!/usr/bin/env tsx
/**
 * scenarios:explain — print a human-readable summary of a scenario's
 * timeline and expected substrate without running it. Useful for
 * triage and for new agents reading what a scenario claims to assert.
 *
 * Usage:
 *   pnpm scenarios:explain <slug>
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInputsJsonl } from './run.mjs';
import type {
  ExpectedClaim,
  ExpectedLifecycleEvent,
  ExpectedObservation,
  ExpectedMcpMetric,
  ExpectedSubstrate,
} from './assert.mjs';

const harnessDir = dirname(fileURLToPath(import.meta.url));
const scenariosRoot = resolve(harnessDir, '..');

const slug = process.argv[2];
if (!slug) {
  console.error('usage: pnpm scenarios:explain <slug>');
  process.exit(2);
}

const dir = join(scenariosRoot, slug);
const inputsPath = join(dir, 'inputs.jsonl');
const expectedPath = join(dir, 'expected.json');
const metaPath = join(dir, 'meta.yaml');

if (!existsSync(inputsPath)) {
  console.error(`scenario "${slug}" has no inputs.jsonl at ${inputsPath}`);
  process.exit(1);
}

const inputs = parseInputsJsonl(inputsPath);
const expected: ExpectedSubstrate | null = existsSync(expectedPath)
  ? (JSON.parse(readFileSync(expectedPath, 'utf8')) as ExpectedSubstrate)
  : null;
const meta = existsSync(metaPath) ? readFileSync(metaPath, 'utf8').trim() : null;

console.log(`# ${slug}`);
if (meta) {
  console.log('');
  console.log(meta);
}
console.log('');
console.log('Timeline:');
for (const input of inputs) {
  const t = `t+${String(input.at_ms).padStart(6, ' ')}ms`;
  const payload = input.payload as Record<string, unknown>;
  if (input.kind === 'lifecycle') {
    const agent = stringField(payload, 'agent') ?? inferAgent(stringField(payload, 'session_id'));
    const event = stringField(payload, 'event_name') ?? '<unknown>';
    const file = extractFile(payload);
    const session = stringField(payload, 'session_id') ?? '';
    console.log(
      `  ${t}  ${agent.padEnd(7, ' ')}  ${event.padEnd(14, ' ')}  ${file ? file : session}`,
    );
  } else if (input.kind === 'mcp') {
    const op = stringField(payload, 'operation') ?? '<op>';
    const session = stringField(payload, 'session_id') ?? '';
    console.log(`  ${t}  mcp     ${op.padEnd(14, ' ')}  ${session}`);
  } else if (input.kind === 'task') {
    const action = stringField(payload, 'action') ?? '<action>';
    const session = stringField(payload, 'session_id') ?? '';
    const file = stringField(payload, 'file_path');
    console.log(
      `  ${t}  task    ${action.padEnd(14, ' ')}  ${file ? `${file} ` : ''}${session}`,
    );
  } else {
    console.log(`  ${t}  tick    ${stringField(payload, 'reason') ?? ''}`);
  }
}
console.log('');
console.log('Expected:');
if (!expected) {
  console.log('  (no expected.json yet — run `pnpm scenarios:record` to bootstrap)');
} else {
  if (expected.observations?.length) {
    console.log(`  observations[]: ${expected.observations.map(describeObservation).join(', ')}`);
  }
  if (expected.claims?.length) {
    console.log(`  claims[]:       ${expected.claims.map(describeClaim).join(', ')}`);
  }
  if (expected.mcp_metrics?.length) {
    console.log(`  mcp_metrics[]:  ${expected.mcp_metrics.map(describeMetric).join(', ')}`);
  }
  if (expected.lifecycle_events?.length) {
    console.log(
      `  lifecycle[]:    ${expected.lifecycle_events.map(describeLifecycle).join(', ')}`,
    );
  }
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function inferAgent(sessionId: string | null): string {
  if (!sessionId) return 'agent';
  if (sessionId.startsWith('claude')) return 'claude';
  if (sessionId.startsWith('codex')) return 'codex';
  if (sessionId.startsWith('queen')) return 'queen';
  return 'agent';
}

function extractFile(payload: Record<string, unknown>): string | null {
  const toolInput = payload.tool_input as Record<string, unknown> | undefined;
  if (!toolInput) return null;
  if (typeof toolInput.path === 'string') return shortenPath(toolInput.path);
  if (Array.isArray(toolInput.paths)) {
    for (const p of toolInput.paths as Array<Record<string, unknown> | string>) {
      if (typeof p === 'string') return shortenPath(p);
      if (p && typeof p === 'object' && typeof p.path === 'string') return shortenPath(p.path);
    }
  }
  return null;
}

function shortenPath(p: string): string {
  return p.replaceAll('<REPO_ROOT>/', '').replaceAll('<REPO_ROOT>', '');
}

function describeObservation(o: ExpectedObservation): string {
  const meta = o.metadata_subset
    ? `(${Object.entries(o.metadata_subset)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(',')})`
    : '';
  return `${o.kind}${meta}`;
}

function describeClaim(c: ExpectedClaim): string {
  return `${c.file_path}${c.session_id ? ` owner=${c.session_id}` : ''}${c.state ? ` (${c.state})` : ''}`;
}

function describeMetric(m: ExpectedMcpMetric): string {
  return `${m.operation}${m.ok === false ? '(err)' : ''}`;
}

function describeLifecycle(e: ExpectedLifecycleEvent): string {
  return `${e.event_type}${e.event_id ? `#${e.event_id}` : ''}`;
}
