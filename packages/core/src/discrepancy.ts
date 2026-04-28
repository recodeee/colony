import type { MemoryStore } from './memory-store.js';
import { MIN_CORPUS_SIZE } from './suggestion-thresholds.js';

export interface DiscrepancyReport {
  window: { since: number; until: number };
  edits_without_claims: {
    count: number;
    rate: number;
    examples: Array<{ session_id: string; file_path: string; edit_ts: number }>;
    truncated: boolean;
  };
  sessions_ended_without_handoff: {
    count: number;
    rate: number;
    examples: Array<{
      session_id: string;
      last_observation_ts: number;
      held_claim_count: number;
    }>;
    truncated: boolean;
  };
  blockers_without_messages: {
    count: number;
    rate: number;
    examples: Array<{ session_id: string; blocker_observation_id: number; blocker_ts: number }>;
    truncated: boolean;
  };
  proposals_without_reinforcement: {
    count: number;
    rate: number;
    examples: Array<{ proposal_id: number; created_ts: number; final_strength: number }>;
    truncated: boolean;
  };
  insufficient_data_reason: string | null;
}

interface DetectorResult<T> {
  count: number;
  rate: number;
  examples: T[];
  truncated: boolean;
  denominator: number;
}

interface EditWithoutClaimRow {
  session_id: string;
  file_path: string;
  edit_ts: number;
  has_sibling_claim_within_window: boolean;
}

interface EndedSessionRow {
  session_id: string;
  last_observation_ts: number;
  held_claim_count: number;
  had_active_claims: boolean;
  had_pending_handoff: boolean;
}

interface ObservationLike {
  id: number;
  session_id: string;
  kind: string;
  ts: number;
}

interface ProposalLike {
  id: number;
  repo_root: string;
  branch: string;
  proposed_by: string;
  proposed_at: number;
  final_strength?: number;
}

interface ReinforcementLike {
  proposal_id: number;
  session_id: string;
  weight: number;
  reinforced_at: number;
}

interface DiscrepancyStorage {
  editsWithoutClaims?: (since: number, sibling_window_ms: number) => EditWithoutClaimRow[];
  sessionsEndedWithoutHandoff?: (since: number, handoff_window_ms: number) => EndedSessionRow[];
  observationsInWindow?: (since: number, until: number) => ObservationLike[];
  listProposalsInWindow?: (since: number, until: number) => ProposalLike[];
  proposalsInWindow?: (since: number, until: number) => ProposalLike[];
  listSessions?: (limit?: number) => Array<{ id: string }>;
  timeline?: (session_id: string, around_id?: number, limit?: number) => ObservationLike[];
  listTasks?: (limit?: number) => Array<{ repo_root: string; branch: string }>;
  listProposalsForBranch?: (repo_root: string, branch: string) => ProposalLike[];
  listReinforcements?: (proposal_id: number) => ReinforcementLike[];
}

const DEFAULT_EXAMPLE_CAP = 10;
const EDIT_SIBLING_CLAIM_WINDOW_MS = 5 * 60_000;
const ENDED_SESSION_HANDOFF_WINDOW_MS = 30 * 60_000;
// Starting guess: a blocker should be followed by a coordination primitive
// quickly enough that another agent can act on it during the same handoff loop.
const BLOCKER_FOLLOW_UP_WINDOW_MS = 10 * 60_000;
const PROPOSAL_TOO_EARLY_MS = 60 * 60_000;
const PROPOSAL_NOISE_FLOOR = 0.3;
const PROPOSAL_HALF_LIFE_MS = 60 * 60_000;
const PROPOSAL_DECAY_RATE = Math.LN2 / PROPOSAL_HALF_LIFE_MS;
const FOLLOW_UP_KINDS = new Set(['task_message', 'task_hand_off', 'message', 'handoff']);

export function buildDiscrepancyReport(
  store: MemoryStore,
  options: { since: number; until?: number; example_cap?: number } = { since: 0 },
): DiscrepancyReport {
  const since = options.since;
  const until = options.until ?? Date.now();
  const exampleCap = Math.max(0, Math.floor(options.example_cap ?? DEFAULT_EXAMPLE_CAP));
  const storage = store.storage as unknown as DiscrepancyStorage;

  const edits = detectEditsWithoutClaims(storage, since, until, exampleCap);
  const ended = detectSessionsEndedWithoutHandoff(storage, since, until, exampleCap);
  const blockers = detectBlockersWithoutMessages(storage, since, until, exampleCap);
  const proposals = detectProposalsWithoutReinforcement(storage, since, until, exampleCap);

  return {
    window: { since, until },
    edits_without_claims: stripDenominator(edits),
    sessions_ended_without_handoff: stripDenominator(ended),
    blockers_without_messages: stripDenominator(blockers),
    proposals_without_reinforcement: stripDenominator(proposals),
    insufficient_data_reason: insufficientReason([
      ['edits', edits.denominator],
      ['ended sessions', ended.denominator],
      ['blockers', blockers.denominator],
      ['proposals', proposals.denominator],
    ]),
  };
}

function detectEditsWithoutClaims(
  storage: DiscrepancyStorage,
  since: number,
  until: number,
  cap: number,
): DetectorResult<{ session_id: string; file_path: string; edit_ts: number }> {
  const rows = (storage.editsWithoutClaims?.(since, EDIT_SIBLING_CLAIM_WINDOW_MS) ?? []).filter(
    (row) => inWindow(row.edit_ts, since, until),
  );
  const misses = rows
    .filter((row) => row.has_sibling_claim_within_window === false)
    .sort((a, b) => b.edit_ts - a.edit_ts);
  const examples = misses.map(({ session_id, file_path, edit_ts }) => ({
    session_id,
    file_path,
    edit_ts,
  }));
  return detectorResult(misses.length, rows.length, examples, cap);
}

function detectSessionsEndedWithoutHandoff(
  storage: DiscrepancyStorage,
  since: number,
  until: number,
  cap: number,
): DetectorResult<{ session_id: string; last_observation_ts: number; held_claim_count: number }> {
  const rows = (
    storage.sessionsEndedWithoutHandoff?.(since, ENDED_SESSION_HANDOFF_WINDOW_MS) ?? []
  ).filter((row) => inWindow(row.last_observation_ts, since, until));
  const misses = rows
    .filter((row) => row.had_active_claims && !row.had_pending_handoff)
    .sort((a, b) => b.last_observation_ts - a.last_observation_ts);
  const examples = misses.map(({ session_id, last_observation_ts, held_claim_count }) => ({
    session_id,
    last_observation_ts,
    held_claim_count,
  }));
  return detectorResult(misses.length, rows.length, examples, cap);
}

function detectBlockersWithoutMessages(
  storage: DiscrepancyStorage,
  since: number,
  until: number,
  cap: number,
): DetectorResult<{ session_id: string; blocker_observation_id: number; blocker_ts: number }> {
  const observations = observationsInWindow(storage, since, until + BLOCKER_FOLLOW_UP_WINDOW_MS);
  const blockers = observations.filter(
    (row) => row.kind === 'blocker' && inWindow(row.ts, since, until),
  );
  const misses = blockers
    .filter((blocker) => !hasBlockerFollowUp(blocker, observations))
    .sort((a, b) => b.ts - a.ts);
  const examples = misses.map((row) => ({
    session_id: row.session_id,
    blocker_observation_id: row.id,
    blocker_ts: row.ts,
  }));
  return detectorResult(misses.length, blockers.length, examples, cap);
}

function detectProposalsWithoutReinforcement(
  storage: DiscrepancyStorage,
  since: number,
  until: number,
  cap: number,
): DetectorResult<{ proposal_id: number; created_ts: number; final_strength: number }> {
  const proposals = proposalsInWindow(storage, since, until).filter(
    (proposal) => until - proposal.proposed_at >= PROPOSAL_TOO_EARLY_MS,
  );
  const misses = proposals
    .map((proposal) => proposalWithStrength(storage, proposal, until))
    .filter((proposal) => proposal.final_strength < PROPOSAL_NOISE_FLOOR)
    .filter((proposal) => !hasOtherSessionReinforcement(storage, proposal))
    .sort((a, b) => b.created_ts - a.created_ts);
  const examples = misses.map(({ proposal_id, created_ts, final_strength }) => ({
    proposal_id,
    created_ts,
    final_strength,
  }));
  return detectorResult(misses.length, proposals.length, examples, cap);
}

function hasBlockerFollowUp(blocker: ObservationLike, observations: ObservationLike[]): boolean {
  return observations.some(
    (row) =>
      row.session_id === blocker.session_id &&
      FOLLOW_UP_KINDS.has(row.kind) &&
      row.ts > blocker.ts &&
      row.ts <= blocker.ts + BLOCKER_FOLLOW_UP_WINDOW_MS,
  );
}

function observationsInWindow(
  storage: DiscrepancyStorage,
  since: number,
  until: number,
): ObservationLike[] {
  if (storage.observationsInWindow) return storage.observationsInWindow(since, until);
  const sessions = storage.listSessions?.(10_000) ?? [];
  return sessions.flatMap((session) =>
    (storage.timeline?.(session.id, undefined, 10_000) ?? []).filter((row) =>
      inWindow(row.ts, since, until),
    ),
  );
}

function proposalsInWindow(
  storage: DiscrepancyStorage,
  since: number,
  until: number,
): ProposalLike[] {
  if (storage.listProposalsInWindow) {
    return storage
      .listProposalsInWindow(since, until)
      .filter((row) => inWindow(row.proposed_at, since, until));
  }
  if (storage.proposalsInWindow) {
    return storage
      .proposalsInWindow(since, until)
      .filter((row) => inWindow(row.proposed_at, since, until));
  }
  const keys = new Set<string>();
  const rows: ProposalLike[] = [];
  for (const task of storage.listTasks?.(10_000) ?? []) {
    const key = `${task.repo_root}\0${task.branch}`;
    if (keys.has(key)) continue;
    keys.add(key);
    rows.push(...(storage.listProposalsForBranch?.(task.repo_root, task.branch) ?? []));
  }
  return rows.filter((row) => inWindow(row.proposed_at, since, until));
}

function proposalWithStrength(
  storage: DiscrepancyStorage,
  proposal: ProposalLike,
  until: number,
): { proposal_id: number; created_ts: number; final_strength: number; proposed_by: string } {
  return {
    proposal_id: proposal.id,
    created_ts: proposal.proposed_at,
    final_strength: proposal.final_strength ?? proposalStrength(storage, proposal.id, until),
    proposed_by: proposal.proposed_by,
  };
}

function proposalStrength(storage: DiscrepancyStorage, proposalId: number, until: number): number {
  return (storage.listReinforcements?.(proposalId) ?? []).reduce((sum, row) => {
    const elapsed = Math.max(0, until - row.reinforced_at);
    return sum + row.weight * Math.exp(-PROPOSAL_DECAY_RATE * elapsed);
  }, 0);
}

function hasOtherSessionReinforcement(
  storage: DiscrepancyStorage,
  proposal: { proposal_id: number; proposed_by: string },
): boolean {
  return (storage.listReinforcements?.(proposal.proposal_id) ?? []).some(
    (row) => row.session_id !== proposal.proposed_by,
  );
}

function detectorResult<T>(
  count: number,
  denominator: number,
  allExamples: T[],
  cap: number,
): DetectorResult<T> {
  // Reuse the suggestion payload's MIN_CORPUS_SIZE discipline: a 1-of-2
  // coordination miss should stay a count, not become a scary 50% rate.
  return {
    count,
    denominator,
    rate: denominator >= MIN_CORPUS_SIZE ? count / denominator : 0,
    examples: allExamples.slice(0, cap),
    truncated: allExamples.length > cap,
  };
}

function insufficientReason(denominators: Array<[string, number]>): string | null {
  const insufficient = denominators.find(([, denominator]) => denominator < MIN_CORPUS_SIZE);
  if (!insufficient) return null;
  return `fewer than ${MIN_CORPUS_SIZE} ${insufficient[0]} in window`;
}

function stripDenominator<T>(result: DetectorResult<T>): Omit<DetectorResult<T>, 'denominator'> {
  const { denominator: _denominator, ...publicResult } = result;
  return publicResult;
}

function inWindow(ts: number, since: number, until: number): boolean {
  return ts >= since && ts <= until;
}
