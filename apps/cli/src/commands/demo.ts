import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings } from '@colony/config';
import {
  type GuardedClaimResult,
  MemoryStore,
  createSessionId,
  guardedClaimFile,
} from '@colony/core';
import type { Command } from 'commander';
import kleur from 'kleur';

interface DemoOptions {
  json?: boolean;
  keepData?: boolean;
}

interface DemoFrame {
  frame: number;
  step: string;
  status: string;
  detail: Record<string, unknown>;
}

interface DemoResult {
  data_dir: string;
  task_id: number;
  branch: string;
  file_path: string;
  agents: { claude_code: string; codex: string };
  frames: DemoFrame[];
  cleaned_up: boolean;
}

export function registerDemoCommand(program: Command): void {
  program
    .command('demo')
    .description(
      'Run a 60-second guided demo: two simulated agents try the same file, colony prevents the collision.',
    )
    .option('--json', 'emit a structured JSON transcript instead of narrated output')
    .option('--keep-data', 'keep the temp data dir after the demo for inspection')
    .action(async (opts: DemoOptions) => {
      const result = runDemo(opts);
      if (opts.json === true) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      }
    });
}

export function runDemo(opts: DemoOptions = {}): DemoResult {
  const tempDir = mkdtempSync(join(tmpdir(), 'colony-demo-'));
  const dbPath = join(tempDir, 'data.db');
  const settings = loadSettings();
  const frames: DemoFrame[] = [];
  const narrate = opts.json !== true;
  const log = (line: string): void => {
    if (narrate) process.stdout.write(`${line}\n`);
  };

  const repoRoot = '/tmp/colony-demo-repo';
  const branch = 'agent/demo-feature-x';
  const filePath = 'src/api.ts';
  const sessionA = createSessionId();
  const sessionB = createSessionId();
  let cleanedUp = false;

  log(`${kleur.bold('colony demo')} — two agents, one file, contention prevented in ~5 seconds`);
  log(kleur.dim(`Isolated demo store: ${dbPath}`));
  log('');

  const store = new MemoryStore({ dbPath, settings });
  let taskId = 0;
  try {
    const task = store.storage.findOrCreateTask({
      title: 'Add /api endpoint',
      repo_root: repoRoot,
      branch,
      created_by: 'colony-demo',
    });
    taskId = task.id;

    log(
      `${kleur.cyan('•')} Task: #${task.id} ${kleur.bold(task.title)} on ${kleur.yellow(branch)}`,
    );
    frames.push({
      frame: 0,
      step: 'task_created',
      status: 'ok',
      detail: { task_id: task.id, title: task.title, branch },
    });

    store.startSession({ id: sessionA, ide: 'claude-code', cwd: repoRoot });
    store.startSession({ id: sessionB, ide: 'codex', cwd: repoRoot });
    log(
      `${kleur.cyan('•')} Two agents joined: ${agentLabel('claude-code', sessionA)}, ${agentLabel('codex', sessionB)}`,
    );
    frames.push({
      frame: 0,
      step: 'sessions_started',
      status: 'ok',
      detail: { claude_code: sessionA, codex: sessionB },
    });
    log('');

    log(
      `${kleur.bold('Frame 1.')} ${agentLabel('claude-code', sessionA)} claims ${kleur.yellow(filePath)} before editing.`,
    );
    const claimA = guardedClaimFile(store, {
      task_id: task.id,
      session_id: sessionA,
      file_path: filePath,
      agent: 'claude-code',
    });
    log(`        ${formatStatus(claimA.status)}  ${kleur.dim(describeClaim(claimA))}`);
    frames.push({
      frame: 1,
      step: 'claude_code_claim',
      status: claimA.status,
      detail: claimDetail(claimA),
    });
    log('');

    log(`${kleur.bold('Frame 2.')} ${agentLabel('codex', sessionB)} tries to claim the same file.`);
    const claimB = guardedClaimFile(store, {
      task_id: task.id,
      session_id: sessionB,
      file_path: filePath,
      agent: 'codex',
    });
    log(`        ${formatStatus(claimB.status)}  ${kleur.dim(describeClaim(claimB))}`);
    if (claimB.status === 'blocked_active_owner' && narrate) {
      log(
        `        ${kleur.dim('Hint to codex:')} ${claimB.recommendation ?? 'request handoff or wait for release'}`,
      );
      log(
        `        ${kleur.green('Without colony:')} both agents would have edited ${filePath} in parallel.`,
      );
    }
    frames.push({
      frame: 2,
      step: 'codex_claim',
      status: claimB.status,
      detail: claimDetail(claimB),
    });
    log('');

    log(
      `${kleur.bold('Frame 3.')} ${agentLabel('claude-code', sessionA)} finishes and releases. ${agentLabel('codex', sessionB)} retries.`,
    );
    store.storage.releaseClaim({
      task_id: task.id,
      file_path: filePath,
      session_id: sessionA,
    });
    const claimBRetry = guardedClaimFile(store, {
      task_id: task.id,
      session_id: sessionB,
      file_path: filePath,
      agent: 'codex',
    });
    log(`        ${formatStatus(claimBRetry.status)}  ${kleur.dim(describeClaim(claimBRetry))}`);
    frames.push({
      frame: 3,
      step: 'codex_retry_after_release',
      status: claimBRetry.status,
      detail: claimDetail(claimBRetry),
    });
    log('');

    log(`${kleur.bold('Recap.')}`);
    log(`  1. claude-code claimed ${filePath} → ${formatStatus(claimA.status)}`);
    log(
      `  2. codex tried the same file → ${formatStatus(claimB.status)} ${kleur.dim('(collision prevented)')}`,
    );
    log(
      `  3. claude-code released, codex retried → ${formatStatus(claimBRetry.status)} ${kleur.dim('(ownership transferred cleanly)')}`,
    );
    log('');
    log(
      kleur.dim(
        'Next: install colony for your IDE so this happens automatically on every PreToolUse:Edit. → ',
      ) + kleur.bold('colony install'),
    );
  } finally {
    store.close();
    if (opts.keepData !== true) {
      rmSync(tempDir, { recursive: true, force: true });
      cleanedUp = true;
    }
  }

  return {
    data_dir: tempDir,
    task_id: taskId,
    branch,
    file_path: filePath,
    agents: { claude_code: sessionA, codex: sessionB },
    frames,
    cleaned_up: cleanedUp,
  };
}

function shortId(id: string): string {
  // Session ids are `sess_<base36 ms>_<8 hex>`. The base36 ms prefix is
  // identical for sessions created in the same millisecond, so truncating
  // from the front collapses both demo agents to the same visible id.
  // Keep the trailing random hex.
  if (id.length <= 12) return id;
  const tail = id.slice(-8);
  return `sess_${tail}`;
}

function agentLabel(name: string, sessionId: string): string {
  return `${kleur.green(name)} ${kleur.dim(`(${shortId(sessionId)})`)}`;
}

function formatStatus(status: string): string {
  switch (status) {
    case 'claimed':
    case 'refreshed_same_session':
    case 'refreshed_same_lane':
    case 'superseded_inactive_owner':
      return kleur.green(`✓ ${status}`);
    case 'blocked_active_owner':
    case 'protected_branch_rejected':
    case 'task_not_found':
    case 'invalid_path':
      return kleur.red(`✗ ${status}`);
    case 'takeover_recommended':
      return kleur.yellow(`! ${status}`);
    default:
      return status;
  }
}

function describeClaim(claim: GuardedClaimResult): string {
  switch (claim.status) {
    case 'claimed':
      return `claim recorded on task #${claim.claim_task_id ?? claim.task_id}`;
    case 'blocked_active_owner':
      return `owner: ${claim.owner_agent ?? 'unknown'} (${shortId(claim.owner_session_id ?? '?')})`;
    case 'takeover_recommended':
      return claim.recommendation ?? 'inactive owner; takeover recommended';
    case 'protected_branch_rejected':
      return claim.protected_branch?.warning ?? 'rejected on protected branch';
    case 'task_not_found':
      return `task ${claim.task_id} not found`;
    case 'invalid_path':
      return `path not claimable: ${claim.file_path}`;
    default:
      return '';
  }
}

function claimDetail(claim: GuardedClaimResult): Record<string, unknown> {
  const detail: Record<string, unknown> = {
    task_id: claim.task_id,
    file_path: claim.file_path,
    status: claim.status,
  };
  if (claim.claim_task_id !== undefined) detail.claim_task_id = claim.claim_task_id;
  if (claim.owner_session_id !== undefined) detail.owner_session_id = claim.owner_session_id;
  if (claim.owner_agent !== undefined) detail.owner_agent = claim.owner_agent;
  if (claim.recommendation !== undefined) detail.recommendation = claim.recommendation;
  return detail;
}
