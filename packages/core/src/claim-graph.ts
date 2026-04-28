import type { TaskClaimRow } from '@colony/storage';
import {
  type ClaimAgeClass,
  type ClaimOwnershipStrength,
  classifyClaimAge,
  isStrongClaimAge,
} from './claim-age.js';
import { inferIdeFromSessionId } from './infer-ide.js';
import type { MemoryStore } from './memory-store.js';

const ALL_TASKS_LIMIT = 1_000_000;

export interface ClaimHolder {
  session_id: string;
  agent: string | null;
  task_id: number;
  claimed_at: number;
  age_minutes: number;
  age_class: ClaimAgeClass;
  ownership_strength: ClaimOwnershipStrength;
}

export interface ScopeOverlap {
  file_path: string;
  held_by: ClaimHolder;
}

export interface ClaimGraphOptions {
  now?: number;
  claim_stale_minutes?: number;
  include_weak?: boolean;
}

/** For each file_path, list current strong holders (or null if free). */
export function claimsForPaths(
  store: MemoryStore,
  paths: string[],
  options: ClaimGraphOptions = {},
): Map<string, ClaimHolder | null> {
  const result = new Map<string, ClaimHolder | null>();
  for (const path of paths) result.set(path, null);
  if (result.size === 0) return result;

  const wantedPaths = [...result.keys()];
  const claimsByPath = new Map<string, TaskClaimRow>();
  for (const task of store.storage.listTasks(ALL_TASKS_LIMIT)) {
    for (const path of wantedPaths) {
      const claim = store.storage.getClaim(task.id, path);
      if (!claim) continue;
      const existing = claimsByPath.get(path);
      if (!existing || isNewerClaim(claim, existing)) claimsByPath.set(path, claim);
    }
  }

  const now = options.now ?? Date.now();
  const includeWeak = options.include_weak ?? false;
  for (const [path, claim] of claimsByPath.entries()) {
    const holder = toClaimHolder(claim, {
      now,
      claim_stale_minutes: options.claim_stale_minutes ?? store.settings.claimStaleMinutes,
    });
    if (includeWeak || isStrongClaimAge(holder)) result.set(path, holder);
  }
  return result;
}

/**
 * Return the subset of `intended_paths` that currently have a holder OTHER than the
 * caller's session_id. Empty array means the scope is clear for this session.
 */
export function scopeOverlap(
  store: MemoryStore,
  args: { intended_paths: string[]; my_session_id: string } & ClaimGraphOptions,
): ScopeOverlap[] {
  const overlaps: ScopeOverlap[] = [];
  for (const [file_path, holder] of claimsForPaths(store, args.intended_paths, args).entries()) {
    if (holder && holder.session_id !== args.my_session_id) {
      overlaps.push({ file_path, held_by: holder });
    }
  }
  return overlaps;
}

/**
 * For a set of agents each declaring intended paths, find pairwise overlaps.
 * Used by the partition validator to flag two tasks that touch shared files.
 */
export function pairwiseScopeOverlap(
  declarations: Array<{ session_id: string; agent: string; intended_paths: string[] }>,
): Array<{ a: string; b: string; shared: string[] }> {
  const overlaps: Array<{ a: string; b: string; shared: string[] }> = [];

  for (let i = 0; i < declarations.length; i += 1) {
    const left = declarations[i];
    if (!left) continue;
    for (let j = i + 1; j < declarations.length; j += 1) {
      const right = declarations[j];
      if (!right) continue;
      const shared = intersectPaths(left.intended_paths, right.intended_paths);
      if (shared.length > 0) {
        overlaps.push({ a: left.session_id, b: right.session_id, shared });
      }
    }
  }

  return overlaps;
}

function toClaimHolder(claim: TaskClaimRow, options: ClaimGraphOptions): ClaimHolder {
  const classification = classifyClaimAge(claim.claimed_at, options);
  return {
    session_id: claim.session_id,
    agent: inferIdeFromSessionId(claim.session_id) ?? null,
    task_id: claim.task_id,
    claimed_at: claim.claimed_at,
    age_minutes: classification.age_minutes,
    age_class: classification.age_class,
    ownership_strength: classification.ownership_strength,
  };
}

function isNewerClaim(candidate: TaskClaimRow, existing: TaskClaimRow): boolean {
  if (candidate.claimed_at !== existing.claimed_at)
    return candidate.claimed_at > existing.claimed_at;
  if (candidate.task_id !== existing.task_id) return candidate.task_id > existing.task_id;
  return candidate.session_id > existing.session_id;
}

function intersectPaths(left: string[], right: string[]): string[] {
  const rightPaths = new Set(right);
  const seen = new Set<string>();
  const shared: string[] = [];
  for (const path of left) {
    if (!rightPaths.has(path) || seen.has(path)) continue;
    seen.add(path);
    shared.push(path);
  }
  return shared;
}
