#!/usr/bin/env node
// Benchmark the bridge-lifecycle fast-path vs the in-process Node fallback.
//
// Boots a fresh worker against a temp HOME, then runs N concurrent
// invocations of `apps/cli/bin/colony.sh bridge lifecycle --json ...` with
// realistic OMX envelopes — once with the daemon reachable (fast path),
// once with COLONY_BRIDGE_FAST=0 (forced fallback, mirrors today's behavior
// before this PR). Reports wall time, mean, p95.
//
// Usage:  node scripts/bench-bridge-fastpath.mjs [concurrency] [iterations]
//
// Default: 8 concurrent × 4 iterations = 32 events per path.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const SHIM = resolve(REPO, 'apps/cli/bin/colony.sh');

const CONCURRENCY = Number(process.argv[2] ?? 8);
const ITERATIONS = Number(process.argv[3] ?? 4);
const TOTAL = CONCURRENCY * ITERATIONS;
const PORT = Number(process.env.BENCH_PORT ?? 37788);

function mkenvelope(i) {
  return JSON.stringify({
    schema: 'colony-omx-lifecycle-v1',
    event_id: `bench_evt_${process.pid}_${Date.now()}_${i}`,
    event_name: 'pre_tool_use',
    session_id: `bench_sess_${process.pid}`,
    agent: 'claude',
    cwd: '/tmp/bench',
    repo_root: '/tmp/bench',
    branch: 'agent/claude/bench',
    timestamp: new Date().toISOString(),
    source: 'bench',
    tool_name: 'Edit',
    tool_input: {
      operation: 'replace',
      paths: [{ path: 'src/x.ts', role: 'target', kind: 'file' }],
      input_summary: `bench iteration ${i}`,
      edit_count: 1,
      file_count: 1,
      redacted: true,
    },
  });
}

function runOnce(envelope, env) {
  const start = process.hrtime.bigint();
  const result = spawnSync(
    'sh',
    [SHIM, 'bridge', 'lifecycle', '--json', '--ide', 'claude-code', '--cwd', '/tmp/bench'],
    {
      input: envelope,
      env,
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { ms, status: result.status ?? -1, stderr: result.stderr ?? '' };
}

async function bench(label, env) {
  const samples = [];
  let failures = 0;
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const batch = [];
    for (let c = 0; c < CONCURRENCY; c++) {
      const i = iter * CONCURRENCY + c;
      batch.push(Promise.resolve(runOnce(mkenvelope(i), env)));
    }
    const results = await Promise.all(batch);
    for (const r of results) {
      samples.push(r.ms);
      if (r.status !== 0) {
        failures++;
        if (failures <= 2)
          process.stderr.write(
            `  [${label}] failure: status=${r.status} ${r.stderr.slice(0, 200)}\n`,
          );
      }
    }
  }
  samples.sort((a, b) => a - b);
  const total = samples.reduce((s, v) => s + v, 0);
  const p95 = samples[Math.floor(samples.length * 0.95)];
  const p99 = samples[Math.floor(samples.length * 0.99)] ?? samples.at(-1);
  return {
    label,
    n: samples.length,
    failures,
    totalMs: total,
    meanMs: total / samples.length,
    medianMs: samples[Math.floor(samples.length / 2)],
    p95Ms: p95,
    p99Ms: p99,
    minMs: samples[0],
    maxMs: samples.at(-1),
  };
}

function fmt(r) {
  return [
    `[${r.label}]`,
    `n=${r.n}`,
    `failures=${r.failures}`,
    `mean=${r.meanMs.toFixed(1)}ms`,
    `median=${r.medianMs.toFixed(1)}ms`,
    `p95=${r.p95Ms.toFixed(1)}ms`,
    `p99=${r.p99Ms.toFixed(1)}ms`,
    `min=${r.minMs.toFixed(1)}ms`,
    `max=${r.maxMs.toFixed(1)}ms`,
  ].join(' ');
}

async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) return true;
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function main() {
  // COLONY_HOME is the data dir directly (not a parent of .colony/).
  const colonyHome = mkdtempSync(join(tmpdir(), 'colony-bench-'));
  const fs = await import('node:fs/promises');
  await fs.writeFile(
    join(colonyHome, 'settings.json'),
    JSON.stringify({
      workerPort: PORT,
      embedding: { provider: 'none', autoStart: false },
    }),
  );
  const tmpHome = colonyHome;

  console.log(
    `bench: concurrency=${CONCURRENCY} iterations=${ITERATIONS} total=${TOTAL} port=${PORT}`,
  );
  console.log(`bench: COLONY_HOME=${tmpHome}`);

  const workerEntry = resolve(REPO, 'apps/worker/dist/server.js');
  const worker = spawn('node', [workerEntry], {
    env: { ...process.env, COLONY_HOME: tmpHome, COLONY_NO_AUTOSTART: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  worker.stderr.on('data', (chunk) => {
    const s = String(chunk).trim();
    if (s) process.stderr.write(`[worker] ${s}\n`);
  });
  process.on('exit', () => {
    try {
      worker.kill('SIGTERM');
    } catch {}
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  const healthy = await waitForHealth(PORT, 5_000);
  if (!healthy) {
    process.stderr.write('bench: worker did not become healthy within 5s — aborting\n');
    process.exit(1);
  }

  const baseEnv = {
    ...process.env,
    COLONY_HOME: tmpHome,
    COLONY_WORKER_PORT: String(PORT),
    COLONY_NO_AUTOSTART: '1',
  };

  // Warmup: 2 events on each path, not measured.
  await runOnce(mkenvelope(-1), { ...baseEnv });
  await runOnce(mkenvelope(-2), { ...baseEnv, COLONY_BRIDGE_FAST: '0' });

  const fast = await bench('fast (daemon)', { ...baseEnv });
  const slow = await bench('slow (force-fallback)', { ...baseEnv, COLONY_BRIDGE_FAST: '0' });

  console.log('');
  console.log(fmt(fast));
  console.log(fmt(slow));
  console.log('');
  if (slow.meanMs > 0) {
    const speedup = slow.meanMs / fast.meanMs;
    const meanSavedMs = slow.meanMs - fast.meanMs;
    console.log(
      `speedup (mean): ${speedup.toFixed(1)}x   saved: ${meanSavedMs.toFixed(1)}ms/event`,
    );
    console.log(`speedup (p95):  ${(slow.p95Ms / fast.p95Ms).toFixed(1)}x`);
  }

  worker.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
}

main().catch((err) => {
  console.error('bench failed:', err);
  process.exit(1);
});
