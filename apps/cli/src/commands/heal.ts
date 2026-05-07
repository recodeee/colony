import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadSettings } from '@colony/config';
import type { MemoryStore } from '@colony/core';
import { type TaskClaimRow, type TaskRow, isProtectedBranch } from '@colony/storage';
import type { Command } from 'commander';
import kleur from 'kleur';
import { withStore } from '../util/store.js';

const HEAL_SESSION_ID = 'colony-heal';
const HEAL_AGENT_BRANCH_PREFIX = 'agent/';

type HealAction =
  | {
      id: string;
      type: 'release-expired-quota';
      task_id: number;
      task_title: string;
      repo_root: string;
      branch: string;
      file_path: string;
      session_id: string;
      handoff_observation_id: number;
      expires_at: number;
      age_minutes: number;
      summary: string;
    }
  | {
      id: string;
      type: 'redirect-protected-claim';
      source_task_id: number;
      source_task_title: string;
      target_task_id: number;
      target_task_title: string;
      repo_root: string;
      source_branch: string;
      target_branch: string;
      file_path: string;
      session_id: string;
      age_minutes: number;
      summary: string;
    };

interface HealPlan {
  generated_at: number;
  mode: 'propose' | 'apply';
  repo_root: string;
  summary: {
    actions: number;
    expired_quota_claims: number;
    protected_claim_redirects: number;
  };
  actions: HealAction[];
}

interface HealApplyResult {
  action: HealAction;
  status: 'applied' | 'declined' | 'skipped';
  repair_observation_id: number | null;
  reason: string | null;
}

interface HealOpts {
  repoRoot?: string;
  apply?: boolean;
  yes?: boolean;
  json?: boolean;
}

export function registerHealCommand(program: Command): void {
  program
    .command('heal')
    .description('Propose and apply reversible Colony coordination repairs')
    .option('--repo-root <path>', 'repo root to heal (defaults to process.cwd())')
    .option('--apply', 'apply approved repair actions one at a time')
    .option('--yes', 'with --apply, approve every proposed action without prompting')
    .option('--json', 'emit structured JSON')
    .action(async (opts: HealOpts) => {
      const settings = loadSettings();
      const repoRoot = resolve(opts.repoRoot ?? process.cwd());
      const apply = opts.apply === true;
      if (apply && opts.yes !== true && process.stdin.isTTY !== true) {
        process.stderr.write(
          `${kleur.red('error')} colony heal --apply needs an interactive terminal or --yes\n`,
        );
        process.exitCode = 1;
        return;
      }

      await withStore(settings, async (store) => {
        const plan = buildHealPlan(store, {
          repo_root: repoRoot,
          mode: apply ? 'apply' : 'propose',
          now: Date.now(),
        });
        if (!apply) {
          process.stdout.write(
            `${opts.json === true ? JSON.stringify(plan, null, 2) : formatHealPlan(plan)}\n`,
          );
          return;
        }

        const results: HealApplyResult[] = [];
        for (const action of plan.actions) {
          const approved =
            opts.yes === true
              ? true
              : await confirmAction(`${formatActionSummary(action)}\nApply this repair?`);
          if (!approved) {
            results.push({
              action,
              status: 'declined',
              repair_observation_id: null,
              reason: 'user declined',
            });
            continue;
          }
          results.push(applyHealAction(store, action, Date.now()));
        }

        const payload = { ...plan, results };
        process.stdout.write(
          `${opts.json === true ? JSON.stringify(payload, null, 2) : formatHealApply(payload)}\n`,
        );
      });
    });
}

function buildHealPlan(
  store: MemoryStore,
  opts: { repo_root: string; mode: HealPlan['mode']; now: number },
): HealPlan {
  const tasks = store.storage
    .listTasks(2_000)
    .filter((task) => resolve(task.repo_root) === resolve(opts.repo_root));
  const actions: HealAction[] = [];
  let nextActionId = 1;

  for (const task of tasks) {
    for (const claim of store.storage.listClaims(task.id)) {
      const expiredQuota = expiredQuotaAction(nextActionId, task, claim, opts.now);
      if (expiredQuota) {
        actions.push(expiredQuota);
        nextActionId += 1;
      }
    }
  }

  for (const task of tasks) {
    if (!isProtectedBranch(task.branch)) continue;
    for (const claim of store.storage.listClaims(task.id)) {
      const redirect = protectedClaimRedirectAction(
        nextActionId,
        store,
        tasks,
        task,
        claim,
        opts.now,
      );
      if (redirect) {
        actions.push(redirect);
        nextActionId += 1;
      }
    }
  }

  return {
    generated_at: opts.now,
    mode: opts.mode,
    repo_root: opts.repo_root,
    summary: {
      actions: actions.length,
      expired_quota_claims: actions.filter((action) => action.type === 'release-expired-quota')
        .length,
      protected_claim_redirects: actions.filter(
        (action) => action.type === 'redirect-protected-claim',
      ).length,
    },
    actions,
  };
}

function expiredQuotaAction(
  id: number,
  task: TaskRow,
  claim: TaskClaimRow,
  now: number,
): HealAction | null {
  if (claim.state !== 'handoff_pending') return null;
  if (claim.handoff_observation_id === null) return null;
  if (typeof claim.expires_at !== 'number' || now < claim.expires_at) return null;
  const ageMinutes = ageMinutesSince(claim.claimed_at, now);
  return {
    id: `repair-${id}`,
    type: 'release-expired-quota',
    task_id: task.id,
    task_title: task.title,
    repo_root: task.repo_root,
    branch: task.branch,
    file_path: claim.file_path,
    session_id: claim.session_id,
    handoff_observation_id: claim.handoff_observation_id,
    expires_at: claim.expires_at,
    age_minutes: ageMinutes,
    summary: `release expired quota claim ${claim.file_path} on ${task.branch} from ${claim.session_id}`,
  };
}

function protectedClaimRedirectAction(
  id: number,
  store: MemoryStore,
  tasks: TaskRow[],
  sourceTask: TaskRow,
  claim: TaskClaimRow,
  now: number,
): HealAction | null {
  if (claim.state !== 'active') return null;
  const target = uniqueRedirectTarget(store, tasks, sourceTask, claim);
  if (!target) return null;
  if (store.storage.getClaim(target.id, claim.file_path)) return null;
  const ageMinutes = ageMinutesSince(claim.claimed_at, now);
  return {
    id: `repair-${id}`,
    type: 'redirect-protected-claim',
    source_task_id: sourceTask.id,
    source_task_title: sourceTask.title,
    target_task_id: target.id,
    target_task_title: target.title,
    repo_root: sourceTask.repo_root,
    source_branch: sourceTask.branch,
    target_branch: target.branch,
    file_path: claim.file_path,
    session_id: claim.session_id,
    age_minutes: ageMinutes,
    summary: `redirect protected-branch claim ${claim.file_path} from ${sourceTask.branch} to ${target.branch}`,
  };
}

function uniqueRedirectTarget(
  store: MemoryStore,
  tasks: TaskRow[],
  sourceTask: TaskRow,
  claim: TaskClaimRow,
): TaskRow | null {
  const candidates = tasks.filter((task) => {
    if (task.id === sourceTask.id) return false;
    if (resolve(task.repo_root) !== resolve(sourceTask.repo_root)) return false;
    if (!task.branch.startsWith(HEAL_AGENT_BRANCH_PREFIX)) return false;
    if (isProtectedBranch(task.branch)) return false;
    if (task.status === 'archived') return false;
    return store.storage
      .listParticipants(task.id)
      .some(
        (participant) =>
          participant.session_id === claim.session_id && participant.left_at === null,
      );
  });
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function applyHealAction(store: MemoryStore, action: HealAction, now: number): HealApplyResult {
  if (action.type === 'release-expired-quota') {
    const repair_observation_id = applyExpiredQuotaRepair(store, action, now);
    return repair_observation_id === null
      ? {
          action,
          status: 'skipped',
          repair_observation_id: null,
          reason: 'claim no longer matched expired quota-pending state',
        }
      : { action, status: 'applied', repair_observation_id, reason: null };
  }
  const repair_observation_id = applyProtectedClaimRedirect(store, action, now);
  return repair_observation_id === null
    ? {
        action,
        status: 'skipped',
        repair_observation_id: null,
        reason: 'claim no longer matched protected redirect state',
      }
    : { action, status: 'applied', repair_observation_id, reason: null };
}

function applyExpiredQuotaRepair(
  store: MemoryStore,
  action: Extract<HealAction, { type: 'release-expired-quota' }>,
  now: number,
): number | null {
  return store.storage.transaction(() => {
    const current = store.storage.getClaim(action.task_id, action.file_path);
    if (
      !current ||
      current.session_id !== action.session_id ||
      current.state !== 'handoff_pending' ||
      current.handoff_observation_id !== action.handoff_observation_id ||
      typeof current.expires_at !== 'number' ||
      now < current.expires_at
    ) {
      return null;
    }
    const auditId = store.addObservation({
      session_id: HEAL_SESSION_ID,
      task_id: action.task_id,
      kind: 'repair',
      content: `repair: released expired quota-pending claim ${action.file_path} from ${action.session_id}; set ownership to weak_expired; audit history retained.`,
      reply_to: action.handoff_observation_id,
      metadata: {
        kind: 'repair',
        action: 'release-expired-quota',
        task_id: action.task_id,
        file_path: action.file_path,
        branch: action.branch,
        repo_root: action.repo_root,
        owner_session_id: action.session_id,
        handoff_observation_id: action.handoff_observation_id,
        expires_at: current.expires_at,
        now,
      },
    });
    store.storage.markClaimWeakExpired({
      task_id: action.task_id,
      file_path: action.file_path,
      session_id: action.session_id,
      handoff_observation_id: action.handoff_observation_id,
    });
    expireQuotaBatonObservationIfPending(store, action.task_id, action.handoff_observation_id, now);
    store.storage.touchTask(action.task_id, now);
    return auditId;
  });
}

function applyProtectedClaimRedirect(
  store: MemoryStore,
  action: Extract<HealAction, { type: 'redirect-protected-claim' }>,
  now: number,
): number | null {
  return store.storage.transaction(() => {
    const sourceClaim = store.storage.getClaim(action.source_task_id, action.file_path);
    if (
      !sourceClaim ||
      sourceClaim.session_id !== action.session_id ||
      sourceClaim.state !== 'active'
    ) {
      return null;
    }
    if (store.storage.getClaim(action.target_task_id, action.file_path)) return null;

    store.storage.releaseClaim({
      task_id: action.source_task_id,
      file_path: action.file_path,
      session_id: action.session_id,
    });
    store.storage.claimFile({
      task_id: action.target_task_id,
      file_path: action.file_path,
      session_id: action.session_id,
    });
    const auditId = store.addObservation({
      session_id: HEAL_SESSION_ID,
      task_id: action.source_task_id,
      kind: 'repair',
      content: `repair: redirected protected-branch claim ${action.file_path} from ${action.source_branch} to ${action.target_branch} for ${action.session_id}; audit history retained.`,
      metadata: {
        kind: 'repair',
        action: 'redirect-protected-claim',
        source_task_id: action.source_task_id,
        target_task_id: action.target_task_id,
        file_path: action.file_path,
        source_branch: action.source_branch,
        target_branch: action.target_branch,
        repo_root: action.repo_root,
        owner_session_id: action.session_id,
        previous_claimed_at: sourceClaim.claimed_at,
        now,
      },
    });
    store.addObservation({
      session_id: HEAL_SESSION_ID,
      task_id: action.target_task_id,
      kind: 'repair',
      content: `repair: accepted redirected claim ${action.file_path} from protected branch ${action.source_branch}; source repair #${auditId}.`,
      reply_to: auditId,
      metadata: {
        kind: 'repair',
        action: 'accept-redirected-protected-claim',
        source_repair_observation_id: auditId,
        source_task_id: action.source_task_id,
        target_task_id: action.target_task_id,
        file_path: action.file_path,
        source_branch: action.source_branch,
        target_branch: action.target_branch,
        owner_session_id: action.session_id,
        now,
      },
    });
    store.storage.touchTask(action.source_task_id, now);
    store.storage.touchTask(action.target_task_id, now);
    return auditId;
  });
}

function expireQuotaBatonObservationIfPending(
  store: MemoryStore,
  taskId: number,
  observationId: number,
  now: number,
): void {
  const obs = store.storage.getObservation(observationId);
  if (!obs || obs.task_id !== taskId) return;
  if (obs.kind !== 'handoff' && obs.kind !== 'relay') return;
  const metadata = parseMetadata(obs.metadata);
  if (metadata.status !== 'pending') return;
  if (typeof metadata.expires_at !== 'number' || now < metadata.expires_at) return;
  metadata.status = 'expired';
  store.storage.updateObservationMetadata(observationId, JSON.stringify(metadata));
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function formatHealPlan(plan: HealPlan): string {
  const lines = [
    kleur.bold('colony heal'),
    `mode: ${plan.mode}${plan.mode === 'propose' ? ' (no changes)' : ''}`,
    `repo: ${plan.repo_root}`,
    `actions: ${plan.summary.actions}  expired quota: ${plan.summary.expired_quota_claims}  protected redirects: ${plan.summary.protected_claim_redirects}`,
  ];
  if (plan.actions.length === 0) {
    lines.push(kleur.green('No boring repairs ready.'));
    return lines.join('\n');
  }
  lines.push('', kleur.bold('Proposed repairs'));
  plan.actions.forEach((action, index) => {
    lines.push(`  ${index + 1}. ${formatActionSummary(action)}`);
  });
  lines.push('', kleur.dim('Apply with: colony heal --apply'));
  return lines.join('\n');
}

function formatHealApply(payload: HealPlan & { results: HealApplyResult[] }): string {
  const lines = [
    kleur.bold('colony heal --apply'),
    `repo: ${payload.repo_root}`,
    `actions: ${payload.summary.actions}`,
  ];
  if (payload.results.length === 0) {
    lines.push(kleur.green('No boring repairs ready.'));
    return lines.join('\n');
  }
  lines.push('', kleur.bold('Repair log'));
  payload.results.forEach((result, index) => {
    const suffix =
      result.repair_observation_id === null
        ? result.reason
          ? ` (${result.reason})`
          : ''
        : ` audit #${result.repair_observation_id}`;
    lines.push(`  ${index + 1}. [${result.status}] ${formatActionSummary(result.action)}${suffix}`);
  });
  lines.push('', kleur.dim('Audit: colony search "repair"'));
  return lines.join('\n');
}

function formatActionSummary(action: HealAction): string {
  if (action.type === 'release-expired-quota') {
    return `${action.id} release expired quota: task #${action.task_id} ${action.branch} ${action.file_path} from ${action.session_id} -> weak_expired`;
  }
  return `${action.id} redirect protected claim: task #${action.source_task_id} ${action.source_branch} -> task #${action.target_task_id} ${action.target_branch} ${action.file_path} for ${action.session_id}`;
}

async function confirmAction(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${prompt} [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function ageMinutesSince(ts: number, now: number): number {
  return Math.max(0, Math.floor((now - ts) / 60_000));
}
