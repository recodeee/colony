import { type MemoryStore, TaskThread } from '@colony/core';
import { ensureHookTaskForSession } from '../task-mirror.js';
import type { HookInput } from '../types.js';
import { extractTouchedFiles } from './post-tool-use.js';

export interface ClaimBeforeEditResult {
  files: string[];
  edits_with_claim: string[];
  edits_missing_claim: string[];
  auto_claimed_before_edit: string[];
  warnings: string[];
}

export function preToolUse(store: MemoryStore, input: HookInput): string {
  return claimBeforeEditWarning(claimBeforeEditFromToolUse(store, input));
}

export function claimBeforeEditFromToolUse(
  store: MemoryStore,
  input: Pick<HookInput, 'session_id' | 'tool_name' | 'tool' | 'tool_input' | 'ide' | 'cwd'>,
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

  let task_id: number;
  try {
    task_id = ensureHookTaskForSession(store, input);
  } catch (err) {
    result.edits_missing_claim.push(...files);
    for (const file_path of files) {
      store.addObservation({
        session_id: input.session_id,
        kind: 'claim-before-edit',
        content: `edits_missing_claim: ${file_path}`,
        metadata: {
          kind: 'claim-before-edit',
          source: 'pre-tool-use',
          outcome: 'edits_missing_claim',
          file_path,
          tool: toolName,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
    result.warnings.push(claimWarning(toolName, files, err));
    return result;
  }

  const thread = new TaskThread(store, task_id);
  for (const file_path of files) {
    const existing = store.storage.getClaim(task_id, file_path);
    if (existing?.session_id === input.session_id) {
      result.edits_with_claim.push(file_path);
      recordClaimBeforeEdit(store, input.session_id, task_id, {
        outcome: 'edits_with_claim',
        file_path,
        tool: toolName,
      });
      continue;
    }

    result.edits_missing_claim.push(file_path);
    recordClaimBeforeEdit(store, input.session_id, task_id, {
      outcome: 'edits_missing_claim',
      file_path,
      tool: toolName,
      ...(existing?.session_id ? { other_session: existing.session_id } : {}),
    });

    if (existing && existing.session_id !== input.session_id) {
      store.addObservation({
        session_id: input.session_id,
        kind: 'claim-conflict',
        content: `${input.session_id} pre-claimed ${file_path} while ${existing.session_id} held the claim`,
        task_id,
        metadata: {
          source: 'pre-tool-use',
          file_path,
          tool: toolName,
          other_session: existing.session_id,
        },
      });
    }

    const observation_id = thread.claimFile({
      session_id: input.session_id,
      file_path,
      note: `auto before ${toolName}`,
      metadata: {
        source: 'pre-tool-use',
        tool: toolName,
        auto_claimed_before_edit: true,
      },
    });
    result.auto_claimed_before_edit.push(file_path);
    recordClaimBeforeEdit(store, input.session_id, task_id, {
      outcome: 'auto_claimed_before_edit',
      file_path,
      tool: toolName,
      claim_observation_id: observation_id,
    });
  }

  return result;
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

function claimWarning(toolName: string, files: string[], err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  return [
    `Claim-before-edit warning: ${toolName || 'write tool'} targets ${files.join(', ')}`,
    'Call task_claim_file before editing. Claims are warnings, not locks.',
    `Auto-claim skipped: ${reason}`,
  ].join('\n');
}
