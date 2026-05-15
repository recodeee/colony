import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { loadSettings } from '@colony/config';
import {
  type IngestOmxRuntimeSummaryResult,
  MemoryStore,
  type OmxRuntimeSummaryInput,
  inferIdeFromSessionId,
} from '@colony/core';
import type { Command } from 'commander';
import kleur from 'kleur';
import { withStore } from '../util/store.js';

interface BridgeStatusCommandOptions {
  repoRoot?: string;
  sessionId?: string;
  agent?: string;
  branch?: string;
  json?: boolean;
}

type BridgeStatusBuilder = (
  store: MemoryStore,
  options: {
    session_id: string;
    agent: string;
    repo_root: string;
    branch?: string;
  },
) => Promise<{
  branch: string | null;
  task: string | null;
  blocker: string | null;
  next_action: string;
  attention: {
    unread_count: number;
    blocking_count: number;
    pending_handoff_count: number;
    pending_wake_count: number;
    stalled_lane_count: number;
  };
  ready_work_count: number;
  claimed_file_count: number;
}>;

interface OmxLifecycleRunResult {
  ok: boolean;
  ms: number;
  event_id?: string;
  event_type?: string;
  route?: string;
  duplicate?: boolean;
  context?: string;
  error?: string;
}

interface BridgeCommandDeps {
  buildBridgeStatusPayload?: BridgeStatusBuilder;
  readStdin?: () => Promise<string>;
  readReplayFile?: (path: string) => string;
  createDryRunStore?: () => { store: MemoryStore; cleanup: () => void };
  runOmxLifecycleEnvelope?: (
    payload: unknown,
    options: { defaultCwd?: string; ide?: string; store?: MemoryStore },
  ) => Promise<OmxLifecycleRunResult>;
  ingestOmxRuntimeSummary?: (
    store: MemoryStore,
    payload: OmxRuntimeSummaryInput,
    defaults: { repoRoot?: string; sessionId?: string; agent?: string; branch?: string },
  ) => IngestOmxRuntimeSummaryResult;
}

interface BridgeLifecycleOptions {
  json?: boolean;
  ide?: string;
  cwd?: string;
  replay?: string;
  dryRun?: boolean;
}

interface BridgeReplayOptions {
  json?: boolean;
  ide?: string;
  cwd?: string;
  apply?: boolean;
  rewriteRoot?: string[];
}

interface BridgeRuntimeSummaryOptions {
  json?: boolean;
  repoRoot?: string;
  sessionId?: string;
  agent?: string;
  branch?: string;
}

function sessionFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (
    env.CODEX_SESSION_ID?.trim() ||
    env.CLAUDECODE_SESSION_ID?.trim() ||
    env.CLAUDE_SESSION_ID?.trim() ||
    undefined
  );
}

function agentFromSession(sessionId: string): string | undefined {
  const ide = inferIdeFromSessionId(sessionId);
  if (ide === 'claude-code') return 'claude';
  return ide;
}

export function registerBridgeCommand(program: Command, deps: BridgeCommandDeps = {}): void {
  const bridge = program
    .command('bridge')
    .description('OMX/HUD bridge helpers for compact Colony status');

  bridge
    .command('status')
    .description('Show compact Colony coordination status for HUD consumers')
    .option('--repo-root <path>', 'repo root to scan (defaults to cwd)')
    .option('--session-id <id>', 'your session_id (defaults to CODEX_SESSION_ID)')
    .option('--agent <name>', 'agent name (e.g. codex, claude); inferred from session when omitted')
    .option('--branch <branch>', 'current branch hint used to pick the active lane')
    .option('--json', 'emit the bridge payload as JSON')
    .action(async (opts: BridgeStatusCommandOptions) => {
      const sessionId = opts.sessionId?.trim() || sessionFromEnv();
      if (!sessionId) {
        process.stderr.write(
          `${kleur.red('missing session')} - pass --session-id or set CODEX_SESSION_ID/CLAUDECODE_SESSION_ID\n`,
        );
        process.exitCode = 1;
        return;
      }

      const agent = opts.agent?.trim() || agentFromSession(sessionId);
      if (!agent) {
        process.stderr.write(
          `${kleur.red('missing agent')} - pass --agent or use a session id prefixed with codex@/claude@\n`,
        );
        process.exitCode = 1;
        return;
      }

      const settings = loadSettings();
      const repoRoot = opts.repoRoot?.trim() || process.cwd();
      await withStore(settings, async (store) => {
        const buildBridgeStatusPayload =
          deps.buildBridgeStatusPayload ??
          (await import('@colony/mcp-server')).buildBridgeStatusPayload;
        const payload = await buildBridgeStatusPayload(store, {
          session_id: sessionId,
          agent,
          repo_root: repoRoot,
          ...(opts.branch?.trim() ? { branch: opts.branch.trim() } : {}),
        });

        if (opts.json) {
          process.stdout.write(`${JSON.stringify(payload)}\n`);
          return;
        }

        process.stdout.write(`${kleur.bold('Colony bridge status')}\n`);
        process.stdout.write(`  branch: ${payload.branch ?? '-'}\n`);
        process.stdout.write(`  task: ${payload.task ?? '-'}\n`);
        process.stdout.write(`  blocker: ${payload.blocker ?? 'none'}\n`);
        process.stdout.write(`  next: ${payload.next_action}\n`);
        process.stdout.write(
          `  attention: unread=${payload.attention.unread_count} blocking=${payload.attention.blocking_count} handoffs=${payload.attention.pending_handoff_count} wakes=${payload.attention.pending_wake_count} stalled=${payload.attention.stalled_lane_count}\n`,
        );
        process.stdout.write(`  ready work: ${payload.ready_work_count}\n`);
        process.stdout.write(`  claimed files: ${payload.claimed_file_count}\n`);
      });
    });

  bridge
    .command('lifecycle')
    .description('Receive a colony-omx-lifecycle-v1 envelope from stdin or a file')
    .option('--json', 'emit the routing result as JSON')
    .option('--ide <name>', 'IDE/agent hint used when the envelope omits one')
    .option('--cwd <path>', 'cwd hint used when the envelope uses relative paths')
    .option(
      '--replay <file>',
      'read the envelope JSON from a file (e.g. a saved .pre.json fixture) instead of stdin',
    )
    .option(
      '--dry-run',
      'route the event through an ephemeral SQLite store; the live data dir is untouched',
    )
    .action(async (opts: BridgeLifecycleOptions) => {
      const raw = opts.replay
        ? (deps.readReplayFile ?? defaultReadReplayFile)(opts.replay)
        : await (deps.readStdin ?? readStdin)();
      const payload = raw.trim() ? safeJson(raw) : {};
      const runLifecycle =
        deps.runOmxLifecycleEnvelope ?? (await import('@colony/hooks')).runOmxLifecycleEnvelope;
      const dryRun = opts.dryRun ? (deps.createDryRunStore ?? defaultCreateDryRunStore)() : null;
      try {
        const result = await runLifecycle(payload, {
          defaultCwd: opts.cwd?.trim() || process.cwd(),
          ...(opts.ide?.trim() ? { ide: opts.ide.trim() } : {}),
          ...(dryRun ? { store: dryRun.store } : {}),
        });

        if (opts.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else if (result.ok) {
          const duplicate = result.duplicate === true ? ' duplicate=true' : '';
          const dryRunTag = opts.dryRun ? ' dry_run=true' : '';
          process.stdout.write(
            `${kleur.green('ok')} event=${result.event_type ?? '-'} route=${result.route ?? '-'}${duplicate}${dryRunTag}\n`,
          );
        } else {
          process.stderr.write(`${kleur.red('error')} ${result.error ?? 'lifecycle failed'}\n`);
        }

        if (!result.ok) process.exitCode = 1;
      } finally {
        dryRun?.cleanup();
      }
    });

  bridge
    .command('replay <file>')
    .description(
      'Replay a saved colony-omx-lifecycle-v1 envelope from disk (dry-run by default; pass --apply to write to the live store)',
    )
    .option('--json', 'emit the routing result as JSON')
    .option('--ide <name>', 'IDE/agent hint used when the envelope omits one')
    .option('--cwd <path>', 'cwd hint used when the envelope uses relative paths')
    .option(
      '--apply',
      'apply the envelope against the live SQLite store; default is dry-run against an ephemeral DB',
    )
    .option(
      '--rewrite-root <pair>',
      'rewrite absolute paths in the envelope as <from>=<to> (repeatable; useful when replaying a capture from another machine)',
      (value: string, previous: string[] | undefined) => (previous ?? []).concat([value]),
    )
    .action(async (file: string, opts: BridgeReplayOptions) => {
      const inputPath = resolvePath(process.cwd(), file);
      const raw = (deps.readReplayFile ?? defaultReadReplayFile)(inputPath);
      let payload = raw.trim() ? safeJson(raw) : {};

      const rewriteRules = parseRewriteRootPairs(opts.rewriteRoot);
      if (rewriteRules.length > 0) {
        payload = rewriteEnvelopePaths(payload, rewriteRules);
      }

      const applied = opts.apply === true;
      if (applied && !opts.json) {
        process.stderr.write(`${kleur.yellow('applying to live store')}\n`);
      }

      const runLifecycle =
        deps.runOmxLifecycleEnvelope ?? (await import('@colony/hooks')).runOmxLifecycleEnvelope;
      const dryRun = applied ? null : (deps.createDryRunStore ?? defaultCreateDryRunStore)();
      try {
        const result = await runLifecycle(payload, {
          defaultCwd: opts.cwd?.trim() || process.cwd(),
          ...(opts.ide?.trim() ? { ide: opts.ide.trim() } : {}),
          ...(dryRun ? { store: dryRun.store } : {}),
        });

        const augmented = { ...result, replay: true, applied, input_path: inputPath };

        if (opts.json) {
          process.stdout.write(`${JSON.stringify(augmented, null, 2)}\n`);
        } else if (result.ok) {
          const duplicate = result.duplicate === true ? ' duplicate=true' : '';
          process.stdout.write(
            `${kleur.green('ok')} event=${result.event_type ?? '-'} route=${result.route ?? '-'}${duplicate} replay=true applied=${applied}\n`,
          );
        } else {
          process.stderr.write(`${kleur.red('error')} ${result.error ?? 'lifecycle failed'}\n`);
        }

        if (!result.ok) process.exitCode = 1;
      } finally {
        dryRun?.cleanup();
      }
    });

  bridge
    .command('runtime-summary')
    .description('Receive a compact OMX runtime summary from stdin')
    .option('--json', 'emit the ingestion result as JSON')
    .option('--repo-root <path>', 'repo root hint (defaults to cwd)')
    .option('--session-id <id>', 'session id fallback')
    .option('--agent <name>', 'agent fallback')
    .option('--branch <branch>', 'branch fallback')
    .action(async (opts: BridgeRuntimeSummaryOptions) => {
      const raw = await (deps.readStdin ?? readStdin)();
      const payload = raw.trim() ? safeJson(raw) : {};
      const settings = loadSettings();
      await withStore(settings, async (store) => {
        const ingest =
          deps.ingestOmxRuntimeSummary ?? (await import('@colony/core')).ingestOmxRuntimeSummary;
        const result = ingest(store, payload, {
          repoRoot: opts.repoRoot?.trim() || process.cwd(),
          ...(opts.sessionId?.trim() ? { sessionId: opts.sessionId.trim() } : {}),
          ...(opts.agent?.trim() ? { agent: opts.agent.trim() } : {}),
          ...(opts.branch?.trim() ? { branch: opts.branch.trim() } : {}),
        });

        if (opts.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else if (result.ok) {
          process.stdout.write(
            `${kleur.green('ok')} observation=${result.observation_id ?? '-'} warnings=${result.warnings?.length ?? 0}\n`,
          );
        } else {
          process.stderr.write(
            `${kleur.red('error')} ${result.error ?? 'summary ingest failed'}\n`,
          );
        }

        if (!result.ok) process.exitCode = 1;
      });
    });
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
  });
}

function defaultReadReplayFile(path: string): string {
  return readFileSync(path, 'utf8');
}

function defaultCreateDryRunStore(): { store: MemoryStore; cleanup: () => void } {
  const settings = loadSettings();
  const dir = mkdtempSync(join(tmpdir(), 'colony-bridge-replay-'));
  const store = new MemoryStore({ dbPath: join(dir, 'data.db'), settings });
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface RewriteRule {
  from: string;
  to: string;
}

function parseRewriteRootPairs(values: string[] | undefined): RewriteRule[] {
  if (!values || values.length === 0) return [];
  const rules: RewriteRule[] = [];
  for (const value of values) {
    const idx = value.indexOf('=');
    if (idx <= 0 || idx === value.length - 1) {
      process.stderr.write(
        `${kleur.yellow('warn')} ignoring malformed --rewrite-root pair: ${value}\n`,
      );
      continue;
    }
    const from = value.slice(0, idx);
    const to = value.slice(idx + 1);
    if (!isAbsolute(from)) {
      process.stderr.write(
        `${kleur.yellow('warn')} --rewrite-root <from> must be absolute: ${from}\n`,
      );
      continue;
    }
    rules.push({ from, to });
  }
  return rules;
}

function rewriteEnvelopePaths(value: unknown, rules: RewriteRule[]): Record<string, unknown> {
  const rewritten = rewriteValue(value, rules);
  return rewritten && typeof rewritten === 'object' && !Array.isArray(rewritten)
    ? (rewritten as Record<string, unknown>)
    : {};
}

function rewriteValue(value: unknown, rules: RewriteRule[]): unknown {
  if (typeof value === 'string') return rewriteString(value, rules);
  if (Array.isArray(value)) return value.map((entry) => rewriteValue(entry, rules));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = rewriteValue(entry, rules);
    }
    return out;
  }
  return value;
}

function rewriteString(value: string, rules: RewriteRule[]): string {
  for (const rule of rules) {
    if (value === rule.from) return rule.to;
    const prefix = rule.from.endsWith('/') ? rule.from : `${rule.from}/`;
    if (value.startsWith(prefix)) return `${rule.to}${value.slice(rule.from.length)}`;
  }
  return value;
}
