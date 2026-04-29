import { type MemoryStore, detectRepoBranch } from '@colony/core';
import {
  type ActiveTaskCandidate,
  type AutoClaimFailureCode,
  type AutoClaimFileForSessionResult,
  autoClaimFileBeforeEdit,
} from '../auto-claim.js';
import type { HookInput } from '../types.js';
import { extractTouchedFiles } from './post-tool-use.js';

const CLAIM_WARNING_DEBOUNCE_MS = 60_000;
const claimWarningDebounceByStore = new WeakMap<MemoryStore, Map<string, number>>();

export interface ClaimBeforeEditFallbackWarning {
  code: AutoClaimFailureCode;
  message: string;
  next_tool: 'task_claim_file';
  /** Concrete invocation string the agent can copy verbatim. */
  next_call: string;
  suggested_args: {
    task_id: number | '<task_id>' | '<candidate.task_id>';
    session_id: string;
    file_path: string;
    note: string;
  };
  candidates?: CompactCandidate[];
}

export interface ClaimBeforeEditResult {
  files: string[];
  edits_with_claim: string[];
  edits_missing_claim: string[];
  auto_claimed_before_edit: string[];
  warnings: ClaimBeforeEditFallbackWarning[];
}

type PreToolUseInput = Pick<HookInput, 'session_id' | 'tool_name' | 'tool' | 'tool_input' | 'cwd'>;
type AutoClaimFailure = Extract<AutoClaimFileForSessionResult, { ok: false }>;
type CompactCandidate = Pick<
  ActiveTaskCandidate,
  'task_id' | 'repo_root' | 'branch' | 'status' | 'updated_at'
>;

export function preToolUse(store: MemoryStore, input: HookInput): string {
  const toolName = input.tool_name ?? input.tool ?? '';
  try {
    return claimBeforeEditWarning(claimBeforeEditFromToolUse(store, input));
  } catch {
    const files = extractTouchedFiles(toolName, input.tool_input);
    return claimBeforeEditWarning({
      files,
      edits_with_claim: [],
      edits_missing_claim: files,
      auto_claimed_before_edit: [],
      warnings: files.map((file_path) =>
        claimWarning(input.session_id, file_path, toolName, {
          ok: false,
          code: 'COLONY_UNAVAILABLE',
          error: 'Colony unavailable for auto-claim',
          candidates: [],
        }),
      ),
    });
  }
}

export function claimBeforeEditFromToolUse(
  store: MemoryStore,
  input: PreToolUseInput,
): ClaimBeforeEditResult {
  const toolName = input.tool_name ?? input.tool ?? '';
  const files = extractTouchedFiles(toolName, input.tool_input);
  const result: ClaimBeforeEditResult = {
    files,
    edits_with_claim: [],
    edits_missing_claim: [],
    auto_claimed_before_edit: [],
    warnings: [],
  };
  if (files.length === 0) return result;

  const scope = taskScopeForToolUse(store, input);

  for (const file_path of files) {
    const claim = autoClaimFileBeforeEdit({
      store,
      session_id: input.session_id,
      ...scope,
      file_path,
      note: `auto before ${toolName}`,
      source: 'pre-tool-use',
      tool: toolName,
      record_conflict: true,
    });

    if (claim.ok && claim.status === 'already_claimed') {
      result.edits_with_claim.push(file_path);
      recordClaimBeforeEdit(store, input.session_id, claim.task_id, {
        outcome: 'edits_with_claim',
        file_path,
        tool: toolName,
      });
      continue;
    }

    if (claim.ok) {
      result.auto_claimed_before_edit.push(file_path);
      recordClaimBeforeEdit(store, input.session_id, claim.task_id, {
        outcome: 'auto_claimed_before_edit',
        file_path,
        tool: toolName,
        ...(claim.observation_id !== null ? { claim_observation_id: claim.observation_id } : {}),
      });
      continue;
    }

    result.edits_missing_claim.push(file_path);
    const warningDebounced = claimWarningDebounced(store, input.session_id, file_path, claim.code);
    recordClaimBeforeEditFailure(store, input.session_id, {
      file_path,
      tool: toolName,
      code: claim.code,
      error: claim.error,
      candidates: claim.candidates,
    });
    if (!warningDebounced)
      result.warnings.push(claimWarning(input.session_id, file_path, toolName, claim));
  }

  return result;
}

function taskScopeForToolUse(
  store: MemoryStore,
  input: PreToolUseInput,
): {
  repo_root?: string;
  branch?: string;
} {
  try {
    const session = store.storage.getSession(input.session_id);
    const cwd = input.cwd ?? session?.cwd ?? undefined;
    const detected = cwd ? detectRepoBranch(cwd) : null;
    return detected ? { repo_root: detected.repo_root, branch: detected.branch } : {};
  } catch {
    return {};
  }
}

function recordClaimBeforeEditFailure(
  store: MemoryStore,
  session_id: string,
  metadata: {
    file_path: string;
    tool: string;
    code: AutoClaimFailureCode;
    error: string;
    candidates: AutoClaimFailure['candidates'];
  },
): void {
  if (metadata.code === 'SESSION_NOT_FOUND' || metadata.code === 'COLONY_UNAVAILABLE') return;
  try {
    store.addObservation({
      session_id,
      kind: 'claim-before-edit',
      content: `edits_missing_claim: ${metadata.file_path}`,
      metadata: {
        kind: 'claim-before-edit',
        source: 'pre-tool-use',
        outcome: 'edits_missing_claim',
        file_path: metadata.file_path,
        tool: metadata.tool,
        code: metadata.code,
        error: metadata.error,
        candidates: compactCandidates(metadata.candidates),
      },
    });
  } catch {
    // Warning output is the fallback path when Colony cannot persist telemetry.
  }
}

function compactCandidates(candidates: AutoClaimFailure['candidates']): Array<{
  task_id: number;
  repo_root: string;
  branch: string;
  status: string;
  updated_at: number;
}> {
  return candidates.slice(0, 5).map((candidate) => ({
    task_id: candidate.task_id,
    repo_root: candidate.repo_root,
    branch: candidate.branch,
    status: candidate.status,
    updated_at: candidate.updated_at,
  }));
}

function recordClaimBeforeEdit(
  store: MemoryStore,
  session_id: string,
  task_id: number,
  metadata: {
    outcome: 'edits_with_claim' | 'edits_missing_claim' | 'auto_claimed_before_edit';
    file_path: string;
    tool: string;
    other_session?: string;
    claim_observation_id?: number;
  },
): void {
  store.addObservation({
    session_id,
    kind: 'claim-before-edit',
    content: `${metadata.outcome}: ${metadata.file_path}`,
    task_id,
    metadata: { kind: 'claim-before-edit', source: 'pre-tool-use', ...metadata },
  });
}

function claimBeforeEditWarning(result: ClaimBeforeEditResult): string {
  return result.warnings.map((warning) => JSON.stringify(warning)).join('\n');
}

function claimWarning(
  session_id: string,
  file_path: string,
  tool_name: string,
  claim: AutoClaimFailure,
): ClaimBeforeEditFallbackWarning {
  const candidates = compactCandidates(claim.candidates);
  // Spell out the exact tool call the agent should make next. When there is
  // exactly one candidate task we substitute its id; ambiguous candidates and
  // no-candidate cases keep a placeholder so the agent picks consciously.
  const taskRef =
    candidates.length === 1
      ? String(candidates[0]?.task_id ?? '<task_id>')
      : candidates.length > 0
        ? '<candidate.task_id>'
        : '<task_id>';
  const next_call = `mcp__colony__task_claim_file({ task_id: ${taskRef}, session_id: "${session_id}", file_path: "${file_path}", note: "pre-edit claim" })`;
  const tool = tool_name || 'edit tool';
  const message = [
    `Missing Colony claim before ${tool} on ${file_path}.`,
    `reason=${claim.code}: ${claim.error}`,
    `next=${next_call}`,
    candidates.length > 0 ? `candidates=${JSON.stringify(candidates)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    code: claim.code,
    message,
    next_tool: 'task_claim_file',
    next_call,
    suggested_args: {
      task_id: candidates.length > 0 ? '<candidate.task_id>' : '<task_id>',
      session_id,
      file_path,
      note: 'pre-edit claim',
    },
    ...(candidates.length > 0 ? { candidates } : {}),
  };
}

function claimWarningDebounced(
  store: MemoryStore,
  session_id: string,
  file_path: string,
  code: AutoClaimFailureCode,
): boolean {
  const now = Date.now();
  const cutoff = now - CLAIM_WARNING_DEBOUNCE_MS;
  const key = `${session_id}\0${file_path}\0${code}`;
  const claimWarningDebounce = claimWarningDebounceByStore.get(store) ?? new Map<string, number>();
  claimWarningDebounceByStore.set(store, claimWarningDebounce);
  const lastEmittedAt = claimWarningDebounce.get(key);
  claimWarningDebounce.set(key, now);
  if (lastEmittedAt !== undefined && lastEmittedAt >= cutoff) return true;
  try {
    return store.timeline(session_id, undefined, 20).some((row) => {
      if (row.kind !== 'claim-before-edit' || row.ts < cutoff) return false;
      const metadata = row.metadata ?? {};
      return (
        metadata.outcome === 'edits_missing_claim' &&
        metadata.file_path === file_path &&
        metadata.code === code
      );
    });
  } catch {
    return false;
  }
}
