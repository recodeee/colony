import path from 'node:path';
import { type MemoryStore, PheromoneSystem, ProposalSystem, detectRepoBranch } from '@colony/core';
import { activeTaskCandidatesForSession, autoClaimFileForSession } from '../auto-claim.js';
import { type BashCoordinationEvent, parseBashCoordinationEvents } from '../bash-parser.js';
import { ensureHookTaskForSession, mirrorTaskToolUse } from '../task-mirror.js';
import type { HookInput } from '../types.js';

/**
 * Tool names whose `file_path` input indicates "this agent just edited that
 * file". Conservative on purpose — `Read` and `Glob` aren't claim-worthy
 * because they don't mutate. `Bash` redirects are handled separately through
 * parseBashCoordinationEvents so ordinary Write/Edit handling stays simple.
 */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const APPLY_PATCH_TOOLS = new Set(['apply_patch', 'ApplyPatch', 'Patch']);
const DIRECT_PATH_FIELDS = ['file_path', 'path', 'notebook_path'];
const PATH_ARRAY_FIELDS = ['file_paths', 'extracted_paths'];
const PSEUDO_HOOK_FILE_PATHS = new Set([
  '/dev/null',
  'dev/null',
  '/dev/stdin',
  'dev/stdin',
  '/dev/stdout',
  'dev/stdout',
  '/dev/stderr',
  'dev/stderr',
  'stdout',
  'stderr',
  'NUL',
]);

type TouchedPathContext = {
  cwd?: string | undefined;
  repoRoot?: string | undefined;
  relativeToCwd?: boolean | undefined;
};

type PathRef = { path: string; role?: string; kind?: string };

export async function postToolUse(store: MemoryStore, input: HookInput): Promise<void> {
  const tool = input.tool_name ?? input.tool ?? 'unknown';
  const toolInput = input.tool_input;
  const toolOutput = input.tool_response ?? input.tool_output;
  const body =
    `${tool} input=${stringifyShort(toolInput)} output=${stringifyShort(toolOutput)}`.slice(
      0,
      4000,
    );
  if (!body.trim()) return;

  // Capture touched files in the observation metadata. Parsing content for
  // file_path later would require reversing compression — cheap to record
  // at write time, expensive to recover at query time. The `observe` and
  // `debrief` commands both depend on this surface for edit-vs-claim
  // diagnostics, so we pay the tiny write cost unconditionally.
  const touchedFiles = extractTouchedFiles(
    tool,
    toolInput,
    touchedPathContextForToolUse(store, input),
  );
  const metadata: Record<string, unknown> = { tool };
  if (touchedFiles.length > 0) {
    metadata.file_path = touchedFiles[0];
    metadata.file_paths = touchedFiles;
    metadata.extracted_paths = touchedFiles;
  }

  store.addObservation({
    session_id: input.session_id,
    kind: 'tool_use',
    content: body,
    metadata,
  });

  mirrorTaskToolUse(store, input);

  const bashEvents = extractBashCoordinationEvents(store, input, tool, toolInput);
  for (const event of bashEvents) {
    if (event.kind === 'auto-claim') continue;
    store.addObservation({
      session_id: input.session_id,
      kind: event.kind,
      content: bashEventContent(event),
      metadata: bashEventMetadata(tool, event),
    });
  }
  applyBashRedirectAutoClaims(store, input, bashEvents);

  // Side effect: record a claim for every file this tool edited. Observed
  // (not predictive) — the agent doesn't have to know the claim system
  // exists for the claim system to protect its work. The next session that
  // touches the same file gets a warning in its UserPromptSubmit preface.
  autoClaimFromToolUse(store, input);

  // Second, finer-grained side effect: leave an ambient pheromone trail.
  // Claims are binary ("who owns this now"); pheromones are graded
  // ("how much activity has happened here recently"). Both are cheap to
  // write; the preface code decides which one to surface at read time.
  depositPheromoneFromToolUse(store, input);

  // Third side effect: passive proposal reinforcement. Editing a file
  // listed in a pending proposal's touches_files is weak evidence that
  // the proposal matters, so we count it as an 'adjacent' reinforcement.
  // This is what lets proposals accumulate strength without agents
  // thinking about them explicitly — the ordinary work of editing code
  // feeds the foraging algorithm for free.
  reinforceAdjacentProposals(store, input);
}

function extractBashCoordinationEvents(
  store: MemoryStore,
  input: HookInput,
  tool: string,
  toolInput: unknown,
): BashCoordinationEvent[] {
  if (tool !== 'Bash' || typeof toolInput !== 'object' || toolInput === null) return [];

  const command = (toolInput as Record<string, unknown>).command;
  if (typeof command !== 'string') return [];

  const taskId = store.storage.findActiveTaskForSession(input.session_id);
  const task = taskId === undefined ? undefined : store.storage.getTask(taskId);
  const detected = task ? null : input.cwd ? detectRepoBranch(input.cwd) : null;
  return normalizeBashEventPaths(parseBashCoordinationEvents(command), {
    cwd: input.cwd,
    repoRoot: task?.repo_root ?? detected?.repo_root ?? input.cwd,
  });
}

function normalizeBashEventPaths(
  events: BashCoordinationEvent[],
  context: TouchedPathContext,
): BashCoordinationEvent[] {
  return events.flatMap((event) => {
    switch (event.kind) {
      case 'git-op':
        return [event];
      case 'file-op':
        return compactFileOpEvent({
          ...event,
          file_paths: filterClaimableHookFilePaths(
            event.file_paths.map((filePath) =>
              normalizeHookFilePath(filePath, { ...context, relativeToCwd: true }),
            ),
          ),
        });
      case 'auto-claim':
        return compactAutoClaimEvent({
          ...event,
          file_path: normalizeHookFilePath(event.file_path, { ...context, relativeToCwd: true }),
        });
    }
  });
}

function compactFileOpEvent(
  event: BashCoordinationEvent & { kind: 'file-op' },
): BashCoordinationEvent[] {
  return event.file_paths.length === 0 ? [] : [event];
}

function compactAutoClaimEvent(
  event: BashCoordinationEvent & { kind: 'auto-claim' },
): BashCoordinationEvent[] {
  return isPseudoHookFilePath(event.file_path) ? [] : [event];
}

function normalizeHookFilePath(rawPath: string, context: TouchedPathContext): string {
  const repoRoot = context.repoRoot ? path.resolve(context.repoRoot) : undefined;
  const cwd = context.cwd ? path.resolve(context.cwd) : repoRoot;
  if (!path.isAbsolute(rawPath) && !context.relativeToCwd) {
    return normalizeSlashes(path.normalize(rawPath));
  }

  const absolutePath = path.isAbsolute(rawPath)
    ? path.normalize(rawPath)
    : cwd && repoRoot
      ? path.resolve(cwd, rawPath)
      : undefined;

  if (!absolutePath) return normalizeSlashes(path.normalize(rawPath));
  if (repoRoot && isPathInside(absolutePath, repoRoot)) {
    const relativePath = path.relative(repoRoot, absolutePath);
    return relativePath ? normalizeSlashes(relativePath) : '.';
  }
  return normalizeSlashes(absolutePath);
}

function isPathInside(child: string, parent: string): boolean {
  const relativePath = path.relative(parent, child);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function applyBashRedirectAutoClaims(
  store: MemoryStore,
  input: HookInput,
  events: BashCoordinationEvent[],
): void {
  const files = Array.from(
    new Set(events.flatMap((event) => (event.kind === 'auto-claim' ? [event.file_path] : []))),
  );
  for (const file_path of files) {
    const syntheticWrite: Pick<
      HookInput,
      'session_id' | 'tool_name' | 'tool' | 'tool_input' | 'ide' | 'cwd'
    > = {
      session_id: input.session_id,
      tool_name: 'Write',
      tool_input: { file_path },
    };
    if (typeof input.ide === 'string') syntheticWrite.ide = input.ide;
    if (typeof input.cwd === 'string') syntheticWrite.cwd = input.cwd;
    autoClaimFromToolUse(store, syntheticWrite);
    depositPheromoneFromToolUse(store, syntheticWrite);
    reinforceAdjacentProposals(store, syntheticWrite);
  }
}

function bashEventContent(event: BashCoordinationEvent): string {
  switch (event.kind) {
    case 'git-op':
      return `Bash git ${event.op}: ${event.segment}`;
    case 'file-op':
      return `Bash file ${event.op}: ${event.file_paths.join(', ')}`;
    case 'auto-claim':
      return `Bash redirect ${event.operator}: ${event.file_path}`;
  }
}

function bashEventMetadata(tool: string, event: BashCoordinationEvent): Record<string, unknown> {
  const base = { tool, source: 'bash-parser', op: event.op, segment: event.segment };
  switch (event.kind) {
    case 'git-op':
      return { ...base, argv: event.argv };
    case 'file-op':
      return {
        ...base,
        argv: event.argv,
        file_path: event.file_paths[0],
        file_paths: event.file_paths,
        extracted_paths: event.file_paths,
      };
    case 'auto-claim':
      return {
        ...base,
        operator: event.operator,
        file_path: event.file_path,
        file_paths: [event.file_path],
        extracted_paths: [event.file_path],
      };
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function normalizeSlashes(value: string): string {
  return value.replaceAll(path.sep, '/');
}

function filterClaimableHookFilePaths(values: string[]): string[] {
  return unique(
    values.map((value) => value.trim()).filter((value) => value && !isPseudoHookFilePath(value)),
  );
}

function isPseudoHookFilePath(value: string): boolean {
  const normalized = normalizeSlashes(path.normalize(value.trim()));
  return PSEUDO_HOOK_FILE_PATHS.has(normalized);
}

/**
 * Extract file paths that a tool call mutated. Returns `[]` when the tool
 * isn't a write tool or the input shape isn't recognisable — silent-skip
 * rather than throw, because PostToolUse runs on every tool call and any
 * error here would degrade every turn.
 */
export function extractTouchedFiles(
  toolName: string,
  toolInput: unknown,
  context: TouchedPathContext = {},
): string[] {
  if (toolName === 'Bash') return extractBashTouchedFiles(toolInput, context);
  if (APPLY_PATCH_TOOLS.has(toolName)) {
    return normalizeAndFilterTouchedFiles(extractApplyPatchTouchedFiles(toolInput), context);
  }
  if (!WRITE_TOOLS.has(toolName)) return [];
  if (typeof toolInput !== 'object' || toolInput === null) return [];
  return normalizeAndFilterTouchedFiles(
    extractToolInputPathValues(toolInput as Record<string, unknown>),
    context,
  );
}

function extractBashTouchedFiles(toolInput: unknown, context: TouchedPathContext): string[] {
  if (typeof toolInput !== 'object' || toolInput === null) return [];
  const command = (toolInput as Record<string, unknown>).command;
  if (typeof command !== 'string') return [];

  return unique(
    normalizeBashEventPaths(parseBashCoordinationEvents(command), context).flatMap((event) => {
      if (event.kind === 'file-op') return event.file_paths;
      if (event.kind === 'auto-claim') return [event.file_path];
      return [];
    }),
  );
}

function extractApplyPatchTouchedFiles(toolInput: unknown): string[] {
  const paths: string[] =
    typeof toolInput === 'object' && toolInput !== null
      ? extractToolInputPathValues(toolInput as Record<string, unknown>)
      : [];
  const patch = applyPatchText(toolInput);
  if (!patch) return paths;

  for (const line of patch.split(/\r?\n/)) {
    for (const prefix of [
      '*** Add File: ',
      '*** Update File: ',
      '*** Delete File: ',
      '*** Move to: ',
    ]) {
      if (line.startsWith(prefix)) paths.push(line.slice(prefix.length).trim());
    }
  }
  return paths;
}

function extractToolInputPathValues(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const field of DIRECT_PATH_FIELDS) {
    const value = input[field];
    if (typeof value === 'string' && value.length > 0) paths.push(value);
  }
  for (const field of PATH_ARRAY_FIELDS) {
    const value = input[field];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === 'string' && entry.length > 0) paths.push(entry);
    }
  }

  const pathRefs = Array.isArray(input.paths) ? input.paths.filter(isPathRef) : [];
  const claimableRefs = pathRefs.filter(isClaimablePathRef);
  const selectedRefs =
    claimableRefs.length > 0
      ? claimableRefs
      : pathRefs.filter((ref) => ref.kind === undefined || ref.kind === 'file');
  for (const ref of selectedRefs) paths.push(ref.path);

  return paths;
}

function isPathRef(value: unknown): value is PathRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).path === 'string'
  );
}

function isClaimablePathRef(ref: PathRef): boolean {
  if (ref.kind === 'pseudo') return false;
  if (ref.kind !== undefined && ref.kind !== 'file') return false;
  return (
    ref.role === undefined ||
    ref.role === 'target' ||
    ref.role === 'destination' ||
    ref.role === 'output' ||
    ref.role === 'unknown'
  );
}

function applyPatchText(toolInput: unknown): string | undefined {
  if (typeof toolInput === 'string') return toolInput;
  if (typeof toolInput !== 'object' || toolInput === null) return undefined;
  const input = toolInput as Record<string, unknown>;
  for (const field of ['command', 'patch', 'input', 'text']) {
    const value = input[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function normalizeAndFilterTouchedFiles(values: string[], context: TouchedPathContext): string[] {
  return filterClaimableHookFilePaths(values.map((value) => normalizeHookFilePath(value, context)));
}

function touchedPathContextForToolUse(
  store: MemoryStore,
  input: Pick<HookInput, 'session_id' | 'cwd' | 'metadata'>,
): TouchedPathContext {
  const metadataScope = hookMetadataScope(input.metadata);
  const session = store.storage.getSession(input.session_id);
  const cwd = input.cwd ?? metadataScope.cwd ?? session?.cwd ?? undefined;
  try {
    const taskId = store.storage.findActiveTaskForSession(input.session_id);
    const task = taskId === undefined ? undefined : store.storage.getTask(taskId);
    const detected = task ? null : cwd ? detectRepoBranch(cwd) : null;
    return {
      cwd,
      repoRoot: task?.repo_root ?? detected?.repo_root ?? metadataScope.repoRoot ?? cwd,
    };
  } catch {
    return { cwd, repoRoot: metadataScope.repoRoot ?? cwd };
  }
}

function hookMetadataScope(metadata: Record<string, unknown> | undefined): {
  cwd?: string;
  repoRoot?: string;
} {
  if (!metadata) return {};
  return {
    ...optionalString('cwd', readString(metadata.cwd)),
    ...optionalString('repoRoot', readString(metadata.repo_root) ?? readString(metadata.repoRoot)),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalString<K extends string>(
  key: K,
  value: string | undefined,
): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

/**
 * Auto-claim files the current session just edited. Uses the same
 * unambiguous active-task resolution as the preflight helper, while keeping
 * the legacy synthetic-task fallback for bare hook calls.
 *
 * Returns the list of files newly claimed and the list of files that were
 * held by a different session at the moment we took over. Exposed for
 * tests; the main handler ignores the return value because the conflict
 * surfacing happens next turn via buildConflictPreface, not mid-tool.
 */
export function autoClaimFromToolUse(
  store: MemoryStore,
  input: Pick<HookInput, 'session_id' | 'tool_name' | 'tool' | 'tool_input' | 'ide' | 'cwd'>,
): { claimed: string[]; conflicts: Array<{ file_path: string; other_session: string }> } {
  const toolName = input.tool_name ?? input.tool ?? '';
  const hasTouchedFiles = extractTouchedFiles(toolName, input.tool_input).length > 0;
  if (!hasTouchedFiles) return { claimed: [], conflicts: [] };

  const claimed: string[] = [];
  const conflicts: Array<{ file_path: string; other_session: string }> = [];
  const candidate = activeTaskCandidateForToolUse(store, input);
  if (!candidate) return { claimed, conflicts };
  const files = extractTouchedFiles(toolName, input.tool_input, {
    cwd: input.cwd,
    repoRoot: candidate.repo_root,
  });

  for (const file_path of files) {
    const existing = store.storage.getClaim(candidate.task_id, file_path);
    if (existing?.session_id === input.session_id) continue;
    const result = autoClaimFileForSession(store, {
      session_id: input.session_id,
      repo_root: candidate.repo_root,
      branch: candidate.branch,
      file_path,
      source: 'post-tool-use',
      tool: toolName,
      observation_kind: 'auto-claim',
      record_conflict: true,
    });
    if (!result.ok || result.status !== 'claimed') continue;
    if (existing?.session_id && existing.session_id !== input.session_id) {
      conflicts.push({ file_path, other_session: existing.session_id });
    }
    claimed.push(file_path);
  }

  return { claimed, conflicts };
}

function activeTaskCandidateForToolUse(
  store: MemoryStore,
  input: Pick<HookInput, 'session_id' | 'ide' | 'cwd'>,
): {
  task_id: number;
  repo_root: string;
  branch: string;
} | null {
  const session = store.storage.getSession(input.session_id);
  const cwd = input.cwd ?? session?.cwd ?? undefined;
  const detected = cwd ? detectRepoBranch(cwd) : null;
  const candidates = activeTaskCandidatesForSession(store, {
    session_id: input.session_id,
    ...(detected ? { repo_root: detected.repo_root, branch: detected.branch } : {}),
  });

  if (candidates.length === 1) {
    const candidate = candidates[0];
    if (!candidate) return null;
    return {
      task_id: candidate.task_id,
      repo_root: candidate.repo_root,
      branch: candidate.branch,
    };
  }

  if (candidates.length > 1 || detected) return null;

  // Preserve the existing PostToolUse safety net for bare hook calls: if a
  // caller gives cwd/ide but no task has joined yet, materialize the hook task
  // and then resolve it through the same unambiguous candidate path.
  const task_id = ensureHookTaskForSession(store, input);
  const task = store.storage.getTask(task_id);
  if (!task) return null;
  return { task_id, repo_root: task.repo_root, branch: task.branch };
}

/**
 * Leave pheromone on every file this tool touched. No-op when the session
 * isn't on a task (solo work needs no coordination) or when the tool wasn't
 * a write tool. Unlike auto-claim, this never conflicts, never reports
 * back — deposits are fire-and-forget. The decay math means "did the
 * deposit matter" is a question for the next turn's conflict surface, not
 * this turn's hook.
 *
 * Exposed for tests; the main handler ignores the return value.
 */
export function depositPheromoneFromToolUse(
  store: MemoryStore,
  input: Pick<HookInput, 'session_id' | 'tool_name' | 'tool' | 'tool_input' | 'cwd'>,
): { deposited: string[] } {
  const toolName = input.tool_name ?? input.tool ?? '';
  const hasTouchedFiles = extractTouchedFiles(toolName, input.tool_input).length > 0;
  if (!hasTouchedFiles) return { deposited: [] };

  const task_id = store.storage.findActiveTaskForSession(input.session_id);
  if (task_id === undefined) return { deposited: [] };
  const task = store.storage.getTask(task_id);
  const files = extractTouchedFiles(toolName, input.tool_input, {
    cwd: input.cwd,
    repoRoot: task?.repo_root,
  });

  const pheromones = new PheromoneSystem(store.storage);
  for (const file_path of files) {
    pheromones.deposit({ task_id, file_path, session_id: input.session_id });
  }
  return { deposited: files };
}

/**
 * Add a weak 'adjacent' reinforcement to every pending proposal on the
 * current branch whose touches_files includes this edit's file_path.
 * No-op when the session isn't on a task, when no write happened, or
 * when the task row is somehow missing.
 *
 * Exported for tests.
 */
export function reinforceAdjacentProposals(
  store: MemoryStore,
  input: Pick<HookInput, 'session_id' | 'tool_name' | 'tool' | 'tool_input' | 'cwd'>,
): { reinforced: number[] } {
  const toolName = input.tool_name ?? input.tool ?? '';
  const hasTouchedFiles = extractTouchedFiles(toolName, input.tool_input).length > 0;
  if (!hasTouchedFiles) return { reinforced: [] };

  const task_id = store.storage.findActiveTaskForSession(input.session_id);
  if (task_id === undefined) return { reinforced: [] };

  const task = store.storage.getTask(task_id);
  if (!task) return { reinforced: [] };
  const files = extractTouchedFiles(toolName, input.tool_input, {
    cwd: input.cwd,
    repoRoot: task.repo_root,
  });

  const proposals = new ProposalSystem(store);
  const reinforced: number[] = [];
  for (const file_path of files) {
    const matches = proposals.pendingProposalsTouching({
      repo_root: task.repo_root,
      branch: task.branch,
      file_path,
    });
    for (const proposal_id of matches) {
      proposals.reinforce({ proposal_id, session_id: input.session_id, kind: 'adjacent' });
      reinforced.push(proposal_id);
    }
  }
  return { reinforced };
}

function stringifyShort(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.length > 500 ? `${v.slice(0, 500)}…` : v;
  try {
    const s = JSON.stringify(v);
    return s.length > 500 ? `${s.slice(0, 500)}…` : s;
  } catch {
    return String(v);
  }
}
