import { type MemoryStore, detectRepoBranch } from '@colony/core';
import { type AutoClaimFileForSessionResult, autoClaimFileBeforeEdit } from '../auto-claim.js';
import type { HookInput } from '../types.js';
import { extractTouchedFiles } from './post-tool-use.js';

export interface ClaimBeforeEditResult {
  files: string[];
  edits_with_claim: string[];
  edits_missing_claim: string[];
  auto_claimed_before_edit: string[];
  warnings: string[];
}

type PreToolUseInput = Pick<HookInput, 'session_id' | 'tool_name' | 'tool' | 'tool_input' | 'cwd'>;
type AutoClaimFailure = Extract<AutoClaimFileForSessionResult, { ok: false }>;

export function preToolUse(store: MemoryStore, input: HookInput): string {
  return claimBeforeEditWarning(claimBeforeEditFromToolUse(store, input));
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
    recordClaimBeforeEditFailure(store, input.session_id, {
      file_path,
      tool: toolName,
      code: claim.code,
      error: claim.error,
      candidates: claim.candidates,
    });
    result.warnings.push(claimWarning(toolName, file_path, claim));
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
  const session = store.storage.getSession(input.session_id);
  const cwd = input.cwd ?? session?.cwd ?? undefined;
  const detected = cwd ? detectRepoBranch(cwd) : null;
  return detected ? { repo_root: detected.repo_root, branch: detected.branch } : {};
}

function recordClaimBeforeEditFailure(
  store: MemoryStore,
  session_id: string,
  metadata: {
    file_path: string;
    tool: string;
    code: 'ACTIVE_TASK_NOT_FOUND' | 'AMBIGUOUS_ACTIVE_TASK';
    error: string;
    candidates: AutoClaimFailure['candidates'];
  },
): void {
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
}

function compactCandidates(candidates: AutoClaimFailure['candidates']): Array<{
  task_id: number;
  title: string;
  repo_root: string;
  branch: string;
  status: string;
  agent: string;
}> {
  return candidates.slice(0, 5).map((candidate) => ({
    task_id: candidate.task_id,
    title: candidate.title,
    repo_root: candidate.repo_root,
    branch: candidate.branch,
    status: candidate.status,
    agent: candidate.agent,
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
  return result.warnings.join('\n');
}

function claimWarning(toolName: string, filePath: string, claim: AutoClaimFailure): string {
  return [
    `${claim.code}: ${toolName || 'write tool'} target ${filePath}`,
    claim.error,
    `candidates=${JSON.stringify(compactCandidates(claim.candidates))}`,
  ].join('\n');
}
