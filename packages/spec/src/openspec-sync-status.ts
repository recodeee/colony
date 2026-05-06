import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { MemoryStore } from '@colony/core';
import type { ObservationRow, TaskRow } from '@colony/storage';

export type OpenSpecSyncIssueCode =
  | 'missing-openspec-change'
  | 'unchecked-openspec-checkbox'
  | 'missing-pr-evidence'
  | 'missing-verification-evidence'
  | 'merged-pr-cleanup-unchecked'
  | 'unlinked-openspec-plan'
  | 'stale-openspec-checkbox';

export type OpenSpecSyncSeverity = 'warning' | 'error';

export interface OpenSpecTaskSyncMetadata {
  openspec_change_path: string | null;
  openspec_plan_slug: string | null;
  openspec_task_id: string | null;
  pr_url: string | null;
  merge_state: string | null;
  verification_evidence: string[];
}

export interface OpenSpecSyncTaskState {
  task_id: number;
  title: string;
  branch: string;
  status: string;
  metadata: OpenSpecTaskSyncMetadata;
  colony_complete: boolean;
  requires_full_openspec: boolean;
  last_activity_ts: number;
}

export interface OpenSpecSyncIssue {
  code: OpenSpecSyncIssueCode;
  severity: OpenSpecSyncSeverity;
  reason: string;
  repair_actions: string[];
  task_id?: number;
  branch?: string;
  openspec_change_path?: string;
  openspec_plan_slug?: string;
  openspec_task_id?: string;
  file_path?: string;
  line?: number;
  checkbox_text?: string;
}

export interface OpenSpecSyncStatus {
  repo_root: string;
  generated_at: string;
  stale_after_ms: number;
  task_count: number;
  linked_task_count: number;
  issue_count: number;
  issues: OpenSpecSyncIssue[];
  tasks: OpenSpecSyncTaskState[];
}

export interface OpenSpecSyncStatusInput {
  store: MemoryStore;
  repoRoot: string;
  now?: number;
  staleAfterMs?: number;
  limit?: number;
}

interface ParsedCheckbox {
  slug: string;
  source: 'change' | 'plan';
  path: string;
  line: number;
  checked: boolean;
  text: string;
  subtask_index: number | null;
}

const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60_000;
const TASK_SCAN_LIMIT = 10_000;
const TIMELINE_SCAN_LIMIT = 500;
const PR_URL_RE = /https:\/\/github\.com\/[^\s)]+\/pull\/\d+/g;
const CHECKBOX_RE = /^\s*-\s+\[([ xX])\]\s+(.+)$/;

export function openspecSyncStatus(input: OpenSpecSyncStatusInput): OpenSpecSyncStatus {
  const repoRoot = resolve(input.repoRoot);
  const now = input.now ?? Date.now();
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const tasks = input.store.storage
    .listTasks(TASK_SCAN_LIMIT)
    .filter((task) => task.repo_root === repoRoot)
    .map((task) => readTaskState(input.store, task, repoRoot))
    .sort((a, b) => b.last_activity_ts - a.last_activity_ts || b.task_id - a.task_id);
  const checkboxes = parseOpenSpecCheckboxes(repoRoot);
  const issues: OpenSpecSyncIssue[] = [];

  for (const task of tasks) {
    const changeExists = task.metadata.openspec_change_path
      ? openspecChangeExists(repoRoot, task.metadata.openspec_change_path)
      : false;

    if (task.requires_full_openspec && !changeExists) issues.push(missingOpenSpecChangeIssue(task));

    if (task.colony_complete && isFullOpenSpecTask(task)) {
      if (!task.metadata.pr_url) issues.push(missingPrEvidenceIssue(task));
      if (task.metadata.verification_evidence.length === 0) {
        issues.push(missingVerificationEvidenceIssue(task));
      }
    }

    if (task.colony_complete) {
      for (const checkbox of matchingUncheckedCheckboxes(checkboxes, task, repoRoot)) {
        issues.push(uncheckedOpenSpecCheckboxIssue(repoRoot, task, checkbox));
      }
    }

    if (task.metadata.merge_state?.toUpperCase() === 'MERGED') {
      for (const checkbox of matchingCleanupCheckboxes(checkboxes, task, repoRoot)) {
        issues.push(mergedPrCleanupUncheckedIssue(repoRoot, task, checkbox));
      }
    }
  }

  for (const checkbox of checkboxes.filter((entry) => !entry.checked)) {
    const task = findTaskForCheckbox(tasks, checkbox, repoRoot);
    if (!task && checkbox.source === 'plan') {
      issues.push(unlinkedOpenSpecPlanIssue(repoRoot, checkbox));
    }
    if (task?.colony_complete) continue;
    if (isCleanupCheckbox(checkbox) && task?.metadata.merge_state?.toUpperCase() === 'MERGED') {
      continue;
    }
    if (!task || now - task.last_activity_ts >= staleAfterMs) {
      issues.push(staleCheckboxIssue(repoRoot, checkbox, task));
    }
  }

  const deduped = dedupeIssues(issues);
  return {
    repo_root: repoRoot,
    generated_at: new Date(now).toISOString(),
    stale_after_ms: staleAfterMs,
    task_count: tasks.length,
    linked_task_count: tasks.filter(isFullOpenSpecTask).length,
    issue_count: deduped.length,
    issues: input.limit ? deduped.slice(0, input.limit) : deduped,
    tasks,
  };
}

export function formatOpenSpecSyncStatus(status: OpenSpecSyncStatus): string {
  const lines = [
    `OpenSpec sync: ${status.issue_count} issue(s), ${status.linked_task_count}/${status.task_count} linked task(s)`,
  ];
  if (status.issues.length === 0) {
    lines.push('No sync drift detected.');
    return `${lines.join('\n')}\n`;
  }

  for (const issue of status.issues) {
    const loc =
      issue.file_path && issue.line ? `${issue.file_path}:${issue.line}` : (issue.branch ?? '-');
    const task = issue.task_id ? ` task #${issue.task_id}` : '';
    lines.push(`- ${issue.code}${task} ${loc}: ${issue.reason}`);
    for (const action of issue.repair_actions) lines.push(`  fix: ${action}`);
  }
  return `${lines.join('\n')}\n`;
}

function readTaskState(store: MemoryStore, task: TaskRow, repoRoot: string): OpenSpecSyncTaskState {
  const timeline = store.storage.taskTimeline(task.id, TIMELINE_SCAN_LIMIT);
  const metadata = extractTaskSyncMetadata(task, timeline, repoRoot);
  const lastActivity = Math.max(task.updated_at, ...timeline.map((row) => row.ts), 0);
  return {
    task_id: task.id,
    title: task.title,
    branch: task.branch,
    status: task.status,
    metadata,
    colony_complete: isColonyComplete(task, timeline, metadata),
    requires_full_openspec: requiresFullOpenSpec(task, timeline, metadata),
    last_activity_ts: lastActivity,
  };
}

function extractTaskSyncMetadata(
  task: TaskRow,
  timeline: ObservationRow[],
  repoRoot: string,
): OpenSpecTaskSyncMetadata {
  const metadata: OpenSpecTaskSyncMetadata = {
    ...inferOpenSpecLinkFromBranch(task.branch, repoRoot),
    pr_url: null,
    merge_state: null,
    verification_evidence: [],
  };

  for (const row of timeline.slice().reverse()) {
    const parsed = parseMetadata(row.metadata);
    const changePath = stringValue(parsed.openspec_change_path);
    if (changePath) metadata.openspec_change_path = changePath;
    const planSlug =
      stringValue(parsed.openspec_plan_slug) ??
      stringValue(parsed.plan_slug) ??
      stringValue(parsed.parent_plan_slug);
    if (planSlug) metadata.openspec_plan_slug = planSlug;
    const taskId = stringValue(parsed.openspec_task_id) ?? stringValue(parsed.spec_row_id);
    if (taskId) metadata.openspec_task_id = taskId;
    const prUrl = stringValue(parsed.pr_url) ?? stringValue(parsed.pull_request_url);
    if (prUrl) metadata.pr_url = prUrl;
    const mergeState = stringValue(parsed.merge_state) ?? stringValue(parsed.pr_state);
    if (mergeState) metadata.merge_state = mergeState;
    const evidence = verificationEvidence(parsed.verification_evidence);
    if (evidence.length > 0) metadata.verification_evidence = evidence;

    const contentPr = row.content.match(PR_URL_RE)?.[0];
    if (!metadata.pr_url && contentPr) metadata.pr_url = contentPr;
    if (!metadata.merge_state && /\bMERGED\b/i.test(row.content)) metadata.merge_state = 'MERGED';
    if (
      metadata.verification_evidence.length === 0 &&
      /(?:tested|verification|evidence)=/i.test(row.content)
    ) {
      metadata.verification_evidence = [row.content.slice(0, 200)];
    }
  }

  return metadata;
}

function inferOpenSpecLinkFromBranch(
  branch: string,
  repoRoot: string,
): Pick<
  OpenSpecTaskSyncMetadata,
  'openspec_change_path' | 'openspec_plan_slug' | 'openspec_task_id'
> {
  const subtask = branch.match(/^spec\/([a-z0-9-]+)\/sub-(\d+)$/);
  if (subtask?.[1]) {
    return {
      openspec_change_path: join(repoRoot, 'openspec', 'changes', subtask[1], 'CHANGE.md'),
      openspec_plan_slug: subtask[1],
      openspec_task_id: null,
    };
  }

  const root = branch.match(/^spec\/([a-z0-9-]+)$/);
  if (root?.[1]) {
    return {
      openspec_change_path: join(repoRoot, 'openspec', 'changes', root[1], 'CHANGE.md'),
      openspec_plan_slug: null,
      openspec_task_id: null,
    };
  }

  return {
    openspec_change_path: null,
    openspec_plan_slug: null,
    openspec_task_id: null,
  };
}

function isColonyComplete(
  task: TaskRow,
  timeline: ObservationRow[],
  metadata: OpenSpecTaskSyncMetadata,
): boolean {
  if (['completed', 'archived', 'auto-archived'].includes(task.status.toLowerCase())) return true;
  if (metadata.merge_state?.toUpperCase() === 'MERGED' && metadata.pr_url) return true;
  return timeline.some((row) => {
    if (row.kind === 'plan-subtask-claim') {
      return parseMetadata(row.metadata).status === 'completed';
    }
    return row.kind === 'plan-archived';
  });
}

function requiresFullOpenSpec(
  task: TaskRow,
  timeline: ObservationRow[],
  metadata: OpenSpecTaskSyncMetadata,
): boolean {
  if (task.branch.startsWith('spec/')) return true;
  if (metadata.openspec_change_path || metadata.openspec_plan_slug) return true;
  for (const row of timeline) {
    const parsed = parseMetadata(row.metadata);
    const tier = stringValue(parsed.openspec_tier) ?? stringValue(parsed.openspecTier);
    if (tier === 'T2' || tier === 'T3') return true;
    if (tier === 'T0' || tier === 'T1') return false;
    if (
      /\bOpenSpec tier:\s*T[23]\b/i.test(row.content) ||
      /\bT[23]\b.*\bOpenSpec\b/i.test(row.content)
    ) {
      return true;
    }
  }
  return false;
}

function isFullOpenSpecTask(task: OpenSpecSyncTaskState): boolean {
  return (
    task.requires_full_openspec ||
    task.metadata.openspec_change_path !== null ||
    task.metadata.openspec_plan_slug !== null
  );
}

function parseOpenSpecCheckboxes(repoRoot: string): ParsedCheckbox[] {
  return [...parseChangeCheckboxes(repoRoot), ...parsePlanCheckboxes(repoRoot)];
}

function parseChangeCheckboxes(repoRoot: string): ParsedCheckbox[] {
  const root = join(repoRoot, 'openspec', 'changes');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'archive')
    .flatMap((entry) =>
      parseCheckboxFile(entry.name, 'change', join(root, entry.name, 'tasks.md')),
    );
}

function parsePlanCheckboxes(repoRoot: string): ParsedCheckbox[] {
  const root = join(repoRoot, 'openspec', 'plans');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => [
      ...parseCheckboxFile(entry.name, 'plan', join(root, entry.name, 'checkpoints.md')),
      ...parseCheckboxFile(entry.name, 'plan', join(root, entry.name, 'tasks.md')),
    ]);
}

function parseCheckboxFile(
  slug: string,
  source: ParsedCheckbox['source'],
  path: string,
): ParsedCheckbox[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line, index) => {
      const match = line.match(CHECKBOX_RE);
      const mark = match?.[1];
      const text = match?.[2]?.trim();
      if (!mark || !text) return [];
      return [
        {
          slug,
          source,
          path,
          line: index + 1,
          checked: mark === 'x' || mark === 'X',
          text,
          subtask_index: parseSubtaskIndex(text),
        },
      ];
    });
}

function parseSubtaskIndex(text: string): number | null {
  const match = text.match(/\bsub-(\d+)\b/i);
  return match?.[1] ? Number(match[1]) : null;
}

function matchingUncheckedCheckboxes(
  checkboxes: ParsedCheckbox[],
  task: OpenSpecSyncTaskState,
  repoRoot: string,
): ParsedCheckbox[] {
  return checkboxes.filter(
    (checkbox) => !checkbox.checked && checkboxMatchesTask(checkbox, task, repoRoot),
  );
}

function matchingCleanupCheckboxes(
  checkboxes: ParsedCheckbox[],
  task: OpenSpecSyncTaskState,
  repoRoot: string,
): ParsedCheckbox[] {
  return matchingUncheckedCheckboxes(checkboxes, task, repoRoot).filter(isCleanupCheckbox);
}

function checkboxMatchesTask(
  checkbox: ParsedCheckbox,
  task: OpenSpecSyncTaskState,
  repoRoot: string,
): boolean {
  if (task.metadata.openspec_plan_slug && checkbox.slug === task.metadata.openspec_plan_slug) {
    const subtask = task.branch.match(/^spec\/[a-z0-9-]+\/sub-(\d+)$/)?.[1];
    if (subtask !== undefined && checkbox.subtask_index === Number(subtask)) return true;
    if (includesNeedle(checkbox.text, task.title)) return true;
    if (
      task.metadata.openspec_task_id &&
      includesNeedle(checkbox.text, task.metadata.openspec_task_id)
    ) {
      return true;
    }
  }

  if (task.metadata.openspec_change_path) {
    const changeDir = dirname(resolveOpenSpecPath(repoRoot, task.metadata.openspec_change_path));
    if (dirname(checkbox.path) === changeDir) return true;
  }

  return false;
}

function findTaskForCheckbox(
  tasks: OpenSpecSyncTaskState[],
  checkbox: ParsedCheckbox,
  repoRoot: string,
): OpenSpecSyncTaskState | null {
  const matched = tasks.find((task) => checkboxMatchesTask(checkbox, task, repoRoot));
  if (matched) return matched;
  if (checkbox.source === 'plan' && checkbox.subtask_index !== null) {
    return (
      tasks.find((task) => task.branch === `spec/${checkbox.slug}/sub-${checkbox.subtask_index}`) ??
      null
    );
  }
  return tasks.find((task) => task.branch === `spec/${checkbox.slug}`) ?? null;
}

function missingOpenSpecChangeIssue(task: OpenSpecSyncTaskState): OpenSpecSyncIssue {
  return {
    code: 'missing-openspec-change',
    severity: 'error',
    task_id: task.task_id,
    branch: task.branch,
    reason: 'Colony task is marked T2/T3 or spec-scoped but has no existing OpenSpec change path.',
    repair_actions: [
      `Create openspec/changes/<slug>/CHANGE.md for task #${task.task_id}.`,
      `Post task evidence linking task #${task.task_id}: openspec_change_path=<path>; openspec_plan_slug=<slug when applicable>; openspec_task_id=<T row when applicable>.`,
      'Keep T0/T1 work on the compact path; do not scaffold full OpenSpec unless scope grew.',
    ],
  };
}

function uncheckedOpenSpecCheckboxIssue(
  repoRoot: string,
  task: OpenSpecSyncTaskState,
  checkbox: ParsedCheckbox,
): OpenSpecSyncIssue {
  return {
    code: 'unchecked-openspec-checkbox',
    severity: 'warning',
    task_id: task.task_id,
    branch: task.branch,
    file_path: relativePath(repoRoot, checkbox.path),
    line: checkbox.line,
    checkbox_text: checkbox.text,
    ...optionalText('openspec_plan_slug', task.metadata.openspec_plan_slug),
    ...optionalText('openspec_task_id', task.metadata.openspec_task_id),
    reason: 'Colony says the task is complete, but the linked OpenSpec checkbox is still open.',
    repair_actions: [
      `Update ${relativePath(repoRoot, checkbox.path)}:${checkbox.line} checkbox from [ ] to [x] after verifying the completion evidence.`,
      `If the checkbox is not actually complete, reopen or correct Colony task #${task.task_id} evidence instead of marking it done.`,
    ],
  };
}

function missingPrEvidenceIssue(task: OpenSpecSyncTaskState): OpenSpecSyncIssue {
  return {
    code: 'missing-pr-evidence',
    severity: 'error',
    task_id: task.task_id,
    branch: task.branch,
    ...optionalText('openspec_change_path', task.metadata.openspec_change_path),
    ...optionalText('openspec_plan_slug', task.metadata.openspec_plan_slug),
    ...optionalText('openspec_task_id', task.metadata.openspec_task_id),
    reason: 'Colony task is complete but has no PR URL evidence.',
    repair_actions: [
      `Post task evidence for task #${task.task_id}: pr_url=<PR URL>; merge_state=<OPEN|MERGED>; verification_evidence=<commands/results>.`,
      'If no PR was required, record that explicitly in verification_evidence so the exception is searchable.',
    ],
  };
}

function missingVerificationEvidenceIssue(task: OpenSpecSyncTaskState): OpenSpecSyncIssue {
  return {
    code: 'missing-verification-evidence',
    severity: 'warning',
    task_id: task.task_id,
    branch: task.branch,
    ...optionalText('openspec_change_path', task.metadata.openspec_change_path),
    ...optionalText('openspec_plan_slug', task.metadata.openspec_plan_slug),
    ...optionalText('openspec_task_id', task.metadata.openspec_task_id),
    reason: 'Colony task is complete but has no verification evidence.',
    repair_actions: [
      `Post task evidence for task #${task.task_id}: verification_evidence=<test/lint/typecheck command and result>.`,
    ],
  };
}

function mergedPrCleanupUncheckedIssue(
  repoRoot: string,
  task: OpenSpecSyncTaskState,
  checkbox: ParsedCheckbox,
): OpenSpecSyncIssue {
  return {
    code: 'merged-pr-cleanup-unchecked',
    severity: 'error',
    task_id: task.task_id,
    branch: task.branch,
    file_path: relativePath(repoRoot, checkbox.path),
    line: checkbox.line,
    checkbox_text: checkbox.text,
    ...optionalText('openspec_change_path', task.metadata.openspec_change_path),
    ...optionalText('openspec_plan_slug', task.metadata.openspec_plan_slug),
    reason: 'PR is merged but the linked OpenSpec cleanup checkbox is still open.',
    repair_actions: [
      `Add PR URL and MERGED evidence to ${relativePath(repoRoot, checkbox.path)}:${checkbox.line}.`,
      `Run openspec validate --specs before archiving ${task.metadata.openspec_plan_slug ?? '<slug>'}.`,
      'Archive only after validation and cleanup evidence are recorded.',
    ],
  };
}

function staleCheckboxIssue(
  repoRoot: string,
  checkbox: ParsedCheckbox,
  task: OpenSpecSyncTaskState | null,
): OpenSpecSyncIssue {
  return {
    code: 'stale-openspec-checkbox',
    severity: 'warning',
    ...(task ? { task_id: task.task_id, branch: task.branch } : {}),
    ...(task ? optionalText('openspec_plan_slug', task.metadata.openspec_plan_slug) : {}),
    ...(task ? optionalText('openspec_task_id', task.metadata.openspec_task_id) : {}),
    file_path: relativePath(repoRoot, checkbox.path),
    line: checkbox.line,
    checkbox_text: checkbox.text,
    reason: task
      ? 'OpenSpec checkbox is still open and the linked Colony task has no fresh activity.'
      : 'OpenSpec checkbox is still open but no linked Colony task activity was found.',
    repair_actions: [
      `Post fresh task evidence or handoff for ${relativePath(repoRoot, checkbox.path)}:${checkbox.line}.`,
      `If work is complete, update ${relativePath(repoRoot, checkbox.path)}:${checkbox.line} checkbox to [x] and add PR/verification evidence.`,
      'If work is abandoned, retarget or remove the stale checkbox instead of leaving durable drift.',
    ],
  };
}

function unlinkedOpenSpecPlanIssue(repoRoot: string, checkbox: ParsedCheckbox): OpenSpecSyncIssue {
  return {
    code: 'unlinked-openspec-plan',
    severity: 'warning',
    openspec_plan_slug: checkbox.slug,
    file_path: relativePath(repoRoot, checkbox.path),
    line: checkbox.line,
    checkbox_text: checkbox.text,
    reason: 'OpenSpec plan row is open, but no linked Colony task or plan registry row was found.',
    repair_actions: [
      `Publish or repair Colony plan slug ${checkbox.slug} with task_plan_publish/task_plan_claim_subtask, or post evidence with openspec_plan_slug=${checkbox.slug}.`,
      `If work is already closed, update ${relativePath(repoRoot, checkbox.path)}:${checkbox.line} and record PR/verification evidence before archive.`,
    ],
  };
}

function isCleanupCheckbox(checkbox: ParsedCheckbox): boolean {
  return /\b(PR|merge|MERGED|cleanup|sandbox|worktree|archive)\b/i.test(checkbox.text);
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function verificationEvidence(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is string => typeof entry === 'string' && entry.trim() !== '',
    );
  }
  return [];
}

function resolveOpenSpecPath(repoRoot: string, path: string): string {
  return path.startsWith('/') ? path : join(repoRoot, path);
}

function openspecChangeExists(repoRoot: string, path: string): boolean {
  const resolved = resolveOpenSpecPath(repoRoot, path);
  if (existsSync(resolved)) return true;
  const relativeResolved = relativePath(repoRoot, resolved).replaceAll('\\', '/');
  const slug = relativeResolved.match(/^openspec\/changes\/([^/]+)\/CHANGE\.md$/)?.[1];
  if (!slug) return false;
  return archivedOpenSpecChangeExists(join(repoRoot, 'openspec', 'changes', 'archive'), slug);
}

function archivedOpenSpecChangeExists(root: string, slug: string): boolean {
  if (!existsSync(root)) return false;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === slug && existsSync(join(path, 'CHANGE.md'))) return true;
      if (archivedOpenSpecChangeExists(path, slug)) return true;
    }
  }
  return false;
}

function relativePath(repoRoot: string, path: string): string {
  return relative(repoRoot, path) || '.';
}

function includesNeedle(text: string, needle: string): boolean {
  const trimmed = needle.trim();
  return trimmed.length > 0 && text.toLowerCase().includes(trimmed.toLowerCase());
}

function optionalText<K extends string>(key: K, value: string | null): Partial<Record<K, string>> {
  return value ? ({ [key]: value } as Record<K, string>) : {};
}

function dedupeIssues(issues: OpenSpecSyncIssue[]): OpenSpecSyncIssue[] {
  const seen = new Set<string>();
  const out: OpenSpecSyncIssue[] = [];
  for (const issue of issues) {
    const key = [
      issue.code,
      issue.task_id ?? '',
      issue.file_path ?? '',
      issue.line ?? '',
      issue.branch ?? '',
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out.sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      (a.file_path ?? '').localeCompare(b.file_path ?? '') ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.task_id ?? 0) - (b.task_id ?? 0),
  );
}

function severityRank(severity: OpenSpecSyncSeverity): number {
  return severity === 'error' ? 2 : 1;
}
