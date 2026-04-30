import {
  type MemoryStore,
  type WorktreeContentionReport,
  readWorktreeContentionReport,
} from '@colony/core';
import type { PlanValidationRuntime } from './context.js';

export type PlanValidationSeverity = 'error' | 'warning' | 'info';

export type PlanValidationFindingCode =
  | 'file_already_claimed'
  | 'parallel_file_scope_overlap'
  | 'stale_blocker_exists'
  | 'quota_risk_runtime_assigned'
  | 'dirty_worktree_touches_planned_file'
  | 'omx_active_note_conflicts'
  | 'required_mcp_capability_unavailable'
  | 'protected_file_without_strict_claim_policy';

export interface PlanValidationSubtaskInput {
  title: string;
  description: string;
  file_scope: string[];
  depends_on?: number[] | undefined;
  spec_row_id?: string | undefined;
  capability_hint?: CapabilityHint | undefined;
}

export type CapabilityHint = 'ui_work' | 'api_work' | 'test_work' | 'infra_work' | 'doc_work';

export interface PlanValidationFinding {
  code: PlanValidationFindingCode;
  severity: PlanValidationSeverity;
  message: string;
  subtask_index?: number;
  file_path?: string;
  task_id?: number;
  branch?: string;
  session_id?: string;
  agent?: string;
  capability_hint?: CapabilityHint;
  detail?: string;
  related_subtask_indices?: number[];
}

export interface PlanValidationSummary {
  generated_at: string;
  blocking: boolean;
  finding_count: number;
  counts: Record<PlanValidationSeverity, number>;
  findings: PlanValidationFinding[];
}

interface LiveClaim {
  task_id: number;
  file_path: string;
  session_id: string;
  claimed_at: number;
  branch: string;
}

const DEFAULT_REQUIRED_MCP_TOOLS = [
  'mcp__colony__task_plan_claim_subtask',
  'mcp__colony__task_claim_file',
  'mcp__colony__task_ready_for_agent',
];

const DEFAULT_AVAILABLE_MCP_TOOLS = [
  ...DEFAULT_REQUIRED_MCP_TOOLS,
  'mcp__colony__task_plan_publish',
  'mcp__colony__task_plan_validate',
  'mcp__colony__queen_plan_goal',
  'mcp__colony__attention_inbox',
  'mcp__colony__hivemind_context',
];

const DEFAULT_STALE_BLOCKER_MINUTES = 60;

export function buildPlanValidationSummary(args: {
  store: MemoryStore;
  repo_root: string;
  subtasks: PlanValidationSubtaskInput[];
  runtime?: PlanValidationRuntime | undefined;
  live_claims?: LiveClaim[] | undefined;
}): PlanValidationSummary {
  const now = args.runtime?.now?.() ?? Date.now();
  const findings = [
    ...fileClaimFindings(args.subtasks, args.live_claims ?? liveClaims(args.store, args.repo_root)),
    ...parallelScopeOverlapFindings(args.store, args.subtasks, args.runtime),
    ...staleBlockerFindings(args.store, args.repo_root, args.subtasks, now),
    ...quotaRiskFindings(args.store, args.repo_root, args.subtasks, args.runtime),
    ...dirtyWorktreeFindings(args.repo_root, args.subtasks, args.runtime),
    ...omxNoteFindings(args.store, args.repo_root, args.subtasks, args.runtime),
    ...mcpCapabilityFindings(args.runtime),
    ...protectedFileFindings(args.subtasks, args.runtime),
  ].sort(compareFindings);

  const counts = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return {
    generated_at: new Date(now).toISOString(),
    blocking: counts.error > 0,
    finding_count: findings.length,
    counts,
    findings,
  };
}

function fileClaimFindings(
  subtasks: PlanValidationSubtaskInput[],
  claims: LiveClaim[],
): PlanValidationFinding[] {
  const findings: PlanValidationFinding[] = [];
  for (let subtaskIndex = 0; subtaskIndex < subtasks.length; subtaskIndex++) {
    const subtask = subtasks[subtaskIndex];
    if (!subtask) continue;
    for (const filePath of subtask.file_scope) {
      for (const claim of claims.filter((candidate) => candidate.file_path === filePath)) {
        findings.push({
          code: 'file_already_claimed',
          severity: 'warning',
          message: `file already claimed: ${filePath}`,
          subtask_index: subtaskIndex,
          file_path: filePath,
          task_id: claim.task_id,
          branch: claim.branch,
          session_id: claim.session_id,
        });
      }
    }
  }
  return findings;
}

function parallelScopeOverlapFindings(
  store: MemoryStore,
  subtasks: PlanValidationSubtaskInput[],
  runtime?: PlanValidationRuntime,
): PlanValidationFinding[] {
  const findings: PlanValidationFinding[] = [];
  const protectedPatterns = runtime?.protectedFilePatterns ?? store.settings.protected_files;
  for (let i = 0; i < subtasks.length; i++) {
    for (let j = i + 1; j < subtasks.length; j++) {
      const a = subtasks[i];
      const b = subtasks[j];
      if (!a || !b) continue;
      if (hasDependencyPath(subtasks, i, j) || hasDependencyPath(subtasks, j, i)) continue;

      for (const filePath of intersect(a.file_scope, b.file_scope)) {
        const protectedFile = protectedPatterns.some((pattern) =>
          matchesPattern(filePath, pattern),
        );
        findings.push({
          code: 'parallel_file_scope_overlap',
          severity: 'warning',
          message: `parallel sub-tasks share ${protectedFile ? 'protected ' : ''}file: ${filePath}`,
          subtask_index: i,
          file_path: filePath,
          related_subtask_indices: [i, j],
          detail: `sub-tasks ${i} and ${j} should be serialized with depends_on or split through a shared refactor`,
        });
      }
    }
  }
  return findings;
}

function staleBlockerFindings(
  store: MemoryStore,
  repoRoot: string,
  subtasks: PlanValidationSubtaskInput[],
  now: number,
): PlanValidationFinding[] {
  const planned = plannedFiles(subtasks);
  const thresholdMs = DEFAULT_STALE_BLOCKER_MINUTES * 60_000;
  const findings: PlanValidationFinding[] = [];
  for (const task of store.storage.listTasks(2000)) {
    if (task.repo_root !== repoRoot) continue;
    for (const row of store.storage.taskTimeline(task.id, 200)) {
      if (row.kind !== 'blocker' && row.kind !== 'blocked_path') continue;
      if (now - row.ts < thresholdMs) continue;
      const match = matchingPlannedFile(row.content, planned);
      if (!match) continue;
      findings.push({
        code: 'stale_blocker_exists',
        severity: 'warning',
        message: `stale blocker exists for ${match}`,
        file_path: match,
        task_id: task.id,
        branch: task.branch,
        session_id: row.session_id,
        detail: trim(row.content),
      });
    }
  }
  return findings;
}

function quotaRiskFindings(
  store: MemoryStore,
  repoRoot: string,
  subtasks: PlanValidationSubtaskInput[],
  runtime?: PlanValidationRuntime,
): PlanValidationFinding[] {
  const runtimes = runtime?.quotaRiskRuntimes ?? quotaRiskRuntimesFromStore(store, repoRoot);
  const findings: PlanValidationFinding[] = [];
  for (let subtaskIndex = 0; subtaskIndex < subtasks.length; subtaskIndex++) {
    const subtask = subtasks[subtaskIndex];
    if (!subtask?.capability_hint) continue;
    for (const runtime of runtimes) {
      const capabilities = runtime.capability_hints;
      if (capabilities && !capabilities.includes(subtask.capability_hint)) continue;
      const finding: PlanValidationFinding = {
        code: 'quota_risk_runtime_assigned',
        severity: 'info',
        message: `quota-risk runtime assigned near ${subtask.capability_hint}`,
        subtask_index: subtaskIndex,
        agent: runtime.agent,
        capability_hint: subtask.capability_hint,
        detail: runtime.reason,
      };
      if (runtime.session_id !== undefined) finding.session_id = runtime.session_id;
      findings.push(finding);
    }
  }
  return findings;
}

function dirtyWorktreeFindings(
  repoRoot: string,
  subtasks: PlanValidationSubtaskInput[],
  runtime?: PlanValidationRuntime,
): PlanValidationFinding[] {
  const report = readContention(repoRoot, runtime);
  if (!report) return [];
  const planned = plannedFiles(subtasks);
  const byFile = subtaskIndexByFile(subtasks);
  const findings: PlanValidationFinding[] = [];
  for (const worktree of report.worktrees) {
    for (const dirty of worktree.dirty_files) {
      if (!planned.has(dirty.path)) continue;
      const finding: PlanValidationFinding = {
        code: 'dirty_worktree_touches_planned_file',
        severity: 'warning',
        message: `dirty worktree touches planned file: ${dirty.path}`,
        file_path: dirty.path,
        branch: worktree.branch,
        detail: `${worktree.path} ${dirty.status.trim()}`,
      };
      const subtaskIndex = byFile.get(dirty.path);
      if (subtaskIndex !== undefined) finding.subtask_index = subtaskIndex;
      findings.push(finding);
    }
  }
  return findings;
}

function omxNoteFindings(
  store: MemoryStore,
  repoRoot: string,
  subtasks: PlanValidationSubtaskInput[],
  runtime?: PlanValidationRuntime,
): PlanValidationFinding[] {
  const notes = runtime?.omxNotes ?? omxNotesFromStore(store, repoRoot);
  const planned = plannedFiles(subtasks);
  const byFile = subtaskIndexByFile(subtasks);
  const findings: PlanValidationFinding[] = [];
  for (const note of notes) {
    const files = note.file_paths?.length
      ? note.file_paths
      : [...planned].filter((file) => note.content.includes(file));
    for (const file of files) {
      if (!planned.has(file)) continue;
      const finding: PlanValidationFinding = {
        code: 'omx_active_note_conflicts',
        severity: 'info',
        message: `OMX active note conflicts with proposed subtask: ${file}`,
        file_path: file,
        session_id: note.session_id,
        detail: trim(note.content),
      };
      const subtaskIndex = byFile.get(file);
      if (subtaskIndex !== undefined) finding.subtask_index = subtaskIndex;
      findings.push(finding);
    }
  }
  return findings;
}

function mcpCapabilityFindings(runtime?: PlanValidationRuntime): PlanValidationFinding[] {
  const available = new Set(runtime?.availableMcpTools ?? DEFAULT_AVAILABLE_MCP_TOOLS);
  const required = runtime?.requiredMcpTools ?? DEFAULT_REQUIRED_MCP_TOOLS;
  return required
    .filter((tool) => !available.has(tool))
    .map((tool) => ({
      code: 'required_mcp_capability_unavailable' as const,
      severity: 'error' as const,
      message: `required MCP capability unavailable: ${tool}`,
      detail: tool,
    }));
}

function protectedFileFindings(
  subtasks: PlanValidationSubtaskInput[],
  runtime?: PlanValidationRuntime,
): PlanValidationFinding[] {
  if (runtime?.strictClaimPolicy === true) return [];
  const patterns = runtime?.protectedFilePatterns ?? [];
  if (patterns.length === 0) return [];
  const findings: PlanValidationFinding[] = [];
  for (let subtaskIndex = 0; subtaskIndex < subtasks.length; subtaskIndex++) {
    const subtask = subtasks[subtaskIndex];
    if (!subtask) continue;
    for (const filePath of subtask.file_scope) {
      if (!patterns.some((pattern) => matchesPattern(filePath, pattern))) continue;
      findings.push({
        code: 'protected_file_without_strict_claim_policy',
        severity: 'warning',
        message: `protected file without strict claim policy: ${filePath}`,
        subtask_index: subtaskIndex,
        file_path: filePath,
      });
    }
  }
  return findings;
}

function liveClaims(store: MemoryStore, repoRoot: string): LiveClaim[] {
  const rows: LiveClaim[] = [];
  for (const task of store.storage.listTasks(2000)) {
    if (task.repo_root !== repoRoot) continue;
    for (const claim of store.storage.listClaims(task.id)) {
      rows.push({ ...claim, branch: task.branch });
    }
  }
  return rows;
}

function quotaRiskRuntimesFromStore(
  store: MemoryStore,
  repoRoot: string,
): NonNullable<PlanValidationRuntime['quotaRiskRuntimes']> {
  const sessions = new Map(
    store.storage
      .listSessions(2000)
      .filter((session) => session.cwd === repoRoot)
      .map((session) => [session.id, session]),
  );
  const runtimes = new Map<
    string,
    NonNullable<PlanValidationRuntime['quotaRiskRuntimes']>[number]
  >();
  for (const task of store.storage.listTasks(2000)) {
    if (task.repo_root !== repoRoot) continue;
    for (const row of store.storage.taskTimeline(task.id, 100)) {
      if (row.kind !== 'relay' && row.kind !== 'handoff' && row.kind !== 'blocker') continue;
      const text = `${row.content} ${row.metadata ?? ''}`;
      const reason = /rate.limit/i.test(text)
        ? 'rate-limit'
        : /turn.cap/i.test(text)
          ? 'turn-cap'
          : /quota/i.test(text)
            ? 'quota'
            : null;
      if (!reason) continue;
      const session = sessions.get(row.session_id);
      runtimes.set(row.session_id, {
        agent: session?.ide ?? 'unknown',
        session_id: row.session_id,
        reason,
      });
    }
  }
  return [...runtimes.values()];
}

function omxNotesFromStore(
  store: MemoryStore,
  repoRoot: string,
): NonNullable<PlanValidationRuntime['omxNotes']> {
  const notes: NonNullable<PlanValidationRuntime['omxNotes']> = [];
  const sessions = new Set(
    store.storage
      .listSessions(2000)
      .filter((session) => session.cwd === repoRoot)
      .map((session) => session.id),
  );
  for (const task of store.storage.listTasks(2000)) {
    if (task.repo_root !== repoRoot) continue;
    for (const row of store.storage.taskTimeline(task.id, 100)) {
      if (!sessions.has(row.session_id)) continue;
      if (!row.content.includes('mcp__omx_memory__notepad_write_working')) continue;
      notes.push({ session_id: row.session_id, content: row.content });
    }
  }
  return notes;
}

function readContention(
  repoRoot: string,
  runtime?: PlanValidationRuntime,
): WorktreeContentionReport | null {
  try {
    return (
      runtime?.readWorktreeContention?.(repoRoot) ?? readWorktreeContentionReport({ repoRoot })
    );
  } catch {
    return null;
  }
}

function plannedFiles(subtasks: PlanValidationSubtaskInput[]): Set<string> {
  return new Set(subtasks.flatMap((subtask) => subtask.file_scope));
}

function subtaskIndexByFile(subtasks: PlanValidationSubtaskInput[]): Map<string, number> {
  const byFile = new Map<string, number>();
  for (let i = 0; i < subtasks.length; i++) {
    for (const file of subtasks[i]?.file_scope ?? []) if (!byFile.has(file)) byFile.set(file, i);
  }
  return byFile;
}

function hasDependencyPath(
  subtasks: PlanValidationSubtaskInput[],
  from: number,
  to: number,
): boolean {
  const visited = new Set<number>();
  const stack = [from];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    const deps = subtasks[current]?.depends_on ?? [];
    if (deps.includes(to)) return true;
    stack.push(...deps.filter((dep) => dep >= 0 && dep < subtasks.length));
  }
  return false;
}

function intersect(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return [...new Set(left.filter((value) => rightSet.has(value)))];
}

function matchingPlannedFile(content: string, planned: Set<string>): string | null {
  return [...planned].find((file) => content.includes(file)) ?? null;
}

function matchesPattern(filePath: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) return filePath.startsWith(pattern.slice(0, -3));
  if (pattern.startsWith('**/')) return filePath.endsWith(pattern.slice(3));
  return filePath === pattern;
}

function compareFindings(left: PlanValidationFinding, right: PlanValidationFinding): number {
  const severityRank = { error: 0, warning: 1, info: 2 };
  return (
    severityRank[left.severity] - severityRank[right.severity] ||
    left.code.localeCompare(right.code) ||
    (left.file_path ?? '').localeCompare(right.file_path ?? '') ||
    (left.subtask_index ?? -1) - (right.subtask_index ?? -1)
  );
}

function trim(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}
