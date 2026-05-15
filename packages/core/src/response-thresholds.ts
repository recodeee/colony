import type { Storage } from '@colony/storage';
import type { AgentRole } from './types.js';

/**
 * Named capability dimensions. Intentionally small — five is the upper
 * bound of what a human can hold in head while tuning. New dimensions can
 * be added without migrations (capabilities is stored as JSON) but
 * consumers should resist the urge until a concrete routing failure
 * motivates the new dimension.
 */
export interface AgentCapabilities {
  ui_work: number;
  api_work: number;
  test_work: number;
  infra_work: number;
  doc_work: number;
}

export interface AgentProfile {
  agent: string;
  role: AgentRole;
  openProposalCount: number;
  capabilities: AgentCapabilities;
  updated_at: number;
}

interface AgentProfileStorageExtras {
  role?: AgentRole | null;
  open_proposal_count?: number | null;
}

/**
 * Default profile for agents that haven't registered capabilities yet.
 * All dimensions at 0.5 means "no preference either way" — the agent
 * scores the same as anyone else for every work category, which is the
 * right initial behavior (equivalent to random routing) rather than
 * accidentally biasing toward the first registered agent.
 */
export const DEFAULT_CAPABILITIES: AgentCapabilities = {
  ui_work: 0.5,
  api_work: 0.5,
  test_work: 0.5,
  infra_work: 0.5,
  doc_work: 0.5,
};

interface HandoffShape {
  summary: string;
  next_steps?: string[];
  blockers?: string[];
}

interface CapabilityMatch {
  dimension: keyof AgentCapabilities;
  regex: RegExp;
}

/**
 * Keyword patterns per dimension. Deliberately primitive — a real
 * classifier requires training data we don't have yet. For the handoff
 * sizes we see (a few sentences per handoff), a weighted keyword match
 * gives meaningful ordering on obviously-distinct handoffs and
 * roughly-random ordering on ambiguous ones, which is exactly the
 * failure mode we want: helps when it can, doesn't hurt when it can't.
 */
const MATCHERS: readonly CapabilityMatch[] = [
  { dimension: 'ui_work', regex: /\b(ui|component|view|style|layout|viewer|page|css|tsx|jsx)\b/i },
  {
    dimension: 'api_work',
    regex: /\b(api|endpoint|route|handler|request|response|mcp|tool)\b/i,
  },
  { dimension: 'test_work', regex: /\b(test|spec|fixture|mock|vitest|jest|coverage)\b/i },
  {
    dimension: 'infra_work',
    regex: /\b(ci|cd|deploy|build|config|pipeline|docker|release|workflow)\b/i,
  },
  {
    dimension: 'doc_work',
    regex: /\b(readme|doc|docs|comment|explain|writeup|guide|tutorial)\b/i,
  },
];

/**
 * Score a handoff against a single agent's profile. Weighted sum of
 * capability weights for every matching keyword category. Higher is
 * better fit; zero means no match at all (the agent's profile has
 * zeros in every category the handoff text hits).
 */
export function scoreHandoff(handoff: HandoffShape, profile: AgentProfile): number {
  const text = [handoff.summary, ...(handoff.next_steps ?? []), ...(handoff.blockers ?? [])]
    .join(' ')
    .toLowerCase();
  let score = 0;
  for (const { dimension, regex } of MATCHERS) {
    if (regex.test(text)) {
      score += profile.capabilities[dimension] ?? 0;
    }
  }
  return score;
}

export interface CandidateScore {
  agent: string;
  score: number;
}

/**
 * Rank candidates by score descending. Ties preserve input order so
 * the caller can prefer e.g. alphabetical or recency-weighted order
 * upstream. Returns one row per candidate even when score is zero so
 * the preface can render the full ranking if needed.
 */
export function rankCandidates(
  handoff: HandoffShape,
  candidates: AgentProfile[],
): CandidateScore[] {
  return candidates
    .map((profile) => ({ agent: profile.agent, score: scoreHandoff(handoff, profile) }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Hydrate an AgentProfile from storage. Missing profiles fall back to
 * DEFAULT_CAPABILITIES so routing still works for agents that haven't
 * registered explicitly — they just score identically to each other.
 */
export function loadProfile(storage: Storage, agent: string): AgentProfile {
  const row = storage.getAgentProfile(agent);
  if (!row) {
    return {
      agent,
      role: 'executor',
      openProposalCount: 0,
      capabilities: { ...DEFAULT_CAPABILITIES },
      updated_at: 0,
    };
  }
  let caps: AgentCapabilities;
  try {
    const parsed = JSON.parse(row.capabilities) as Partial<AgentCapabilities>;
    caps = { ...DEFAULT_CAPABILITIES, ...parsed };
  } catch {
    caps = { ...DEFAULT_CAPABILITIES };
  }
  const extras = row as typeof row & AgentProfileStorageExtras;
  return {
    agent,
    role: extras.role ?? 'executor',
    openProposalCount: extras.open_proposal_count ?? 0,
    capabilities: caps,
    updated_at: row.updated_at,
  };
}

/** Write a full or partial capability profile for an agent. */
export function saveProfile(
  storage: Storage,
  agent: string,
  capabilities: Partial<AgentCapabilities>,
): AgentProfile {
  const current = loadProfile(storage, agent);
  const merged: AgentCapabilities = { ...current.capabilities, ...capabilities };
  storage.upsertAgentProfile({
    agent,
    capabilities: JSON.stringify(merged),
    updated_at: Date.now(),
  });
  return {
    agent,
    role: current.role,
    openProposalCount: current.openProposalCount,
    capabilities: merged,
    updated_at: Date.now(),
  };
}
