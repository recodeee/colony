import { describe, expect, it } from 'vitest';
import { buildDiscrepancyReport } from '../src/discrepancy.js';

type Store = Parameters<typeof buildDiscrepancyReport>[0];

interface EditRow {
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

interface ObservationRow {
  id: number;
  session_id: string;
  kind: string;
  ts: number;
}

interface ProposalRow {
  id: number;
  repo_root: string;
  branch: string;
  proposed_by: string;
  proposed_at: number;
  final_strength?: number;
}

interface ReinforcementRow {
  proposal_id: number;
  session_id: string;
  weight: number;
  reinforced_at: number;
}

function storeWith(seed: {
  edits?: EditRow[];
  endedSessions?: EndedSessionRow[];
  observations?: ObservationRow[];
  proposals?: ProposalRow[];
  reinforcements?: ReinforcementRow[];
}): Store {
  const observations = seed.observations ?? [];
  const proposals = seed.proposals ?? [];
  const sessions = Array.from(new Set(observations.map((row) => row.session_id))).map((id) => ({
    id,
  }));
  const tasks = Array.from(
    new Map(proposals.map((row) => [`${row.repo_root}\0${row.branch}`, row])).values(),
  ).map(({ repo_root, branch }) => ({ repo_root, branch }));

  return {
    storage: {
      editsWithoutClaims: () => seed.edits ?? [],
      sessionsEndedWithoutHandoff: () => seed.endedSessions ?? [],
      listSessions: () => sessions,
      timeline: (session_id: string) => observations.filter((row) => row.session_id === session_id),
      listTasks: () => tasks,
      listProposalsForBranch: (repo_root: string, branch: string) =>
        proposals.filter((row) => row.repo_root === repo_root && row.branch === branch),
      listReinforcements: (proposal_id: number) =>
        (seed.reinforcements ?? []).filter((row) => row.proposal_id === proposal_id),
    },
  } as unknown as Store;
}

describe('buildDiscrepancyReport', () => {
  it('returns honest empty structure for an empty store', () => {
    const report = buildDiscrepancyReport(storeWith({}), { since: 0, until: 10_000 });

    expect(report.edits_without_claims.count).toBe(0);
    expect(report.sessions_ended_without_handoff.count).toBe(0);
    expect(report.blockers_without_messages.count).toBe(0);
    expect(report.proposals_without_reinforcement.count).toBe(0);
    expect(report.edits_without_claims.examples).toEqual([]);
    expect(report.sessions_ended_without_handoff.examples).toEqual([]);
    expect(report.blockers_without_messages.examples).toEqual([]);
    expect(report.proposals_without_reinforcement.examples).toEqual([]);
    expect(report.insufficient_data_reason).toBe('fewer than 10 edits in window');
  });

  it('counts edits without sibling claims and computes rate over total edits', () => {
    const edits = Array.from({ length: 10 }, (_, index) => ({
      session_id: `S${index}`,
      file_path: `src/${index}.ts`,
      edit_ts: 1_000 + index,
      has_sibling_claim_within_window: index < 5,
    }));

    const report = buildDiscrepancyReport(storeWith({ edits }), { since: 0, until: 2_000 });

    expect(report.edits_without_claims.count).toBe(5);
    expect(report.edits_without_claims.rate).toBe(0.5);
    expect(report.edits_without_claims.examples).toHaveLength(5);
    expect(report.edits_without_claims.examples[0]?.edit_ts).toBe(1_009);
  });

  it('keeps counts but skips rates when denominator is too small', () => {
    const report = buildDiscrepancyReport(
      storeWith({
        edits: [
          {
            session_id: 'S1',
            file_path: 'src/x.ts',
            edit_ts: 1_000,
            has_sibling_claim_within_window: false,
          },
        ],
      }),
      { since: 0, until: 2_000 },
    );

    expect(report.edits_without_claims.count).toBe(1);
    expect(report.edits_without_claims.rate).toBe(0);
    expect(report.insufficient_data_reason).toBe('fewer than 10 edits in window');
  });

  it('finds sessions that ended with claims and no pending handoff', () => {
    const report = buildDiscrepancyReport(
      storeWith({
        endedSessions: [
          {
            session_id: 'quiet',
            last_observation_ts: 2_000,
            held_claim_count: 2,
            had_active_claims: true,
            had_pending_handoff: false,
          },
          {
            session_id: 'handed-off',
            last_observation_ts: 3_000,
            held_claim_count: 2,
            had_active_claims: true,
            had_pending_handoff: true,
          },
        ],
      }),
      { since: 0, until: 4_000 },
    );

    expect(report.sessions_ended_without_handoff.count).toBe(1);
    expect(report.sessions_ended_without_handoff.examples).toEqual([
      { session_id: 'quiet', last_observation_ts: 2_000, held_claim_count: 2 },
    ]);
  });

  it('ignores blockers with a coordination follow-up inside 10 minutes', () => {
    const report = buildDiscrepancyReport(
      storeWith({
        observations: [
          { id: 1, session_id: 'A', kind: 'blocker', ts: 1_000 },
          { id: 2, session_id: 'A', kind: 'task_message', ts: 1_000 + 5 * 60_000 },
          { id: 3, session_id: 'B', kind: 'blocker', ts: 2_000 },
        ],
      }),
      { since: 0, until: 3_000 },
    );

    expect(report.blockers_without_messages.count).toBe(1);
    expect(report.blockers_without_messages.examples).toEqual([
      { session_id: 'B', blocker_observation_id: 3, blocker_ts: 2_000 },
    ]);
  });

  it('finds old weak proposals without another session reinforcement', () => {
    const twoHours = 2 * 60 * 60_000;
    const report = buildDiscrepancyReport(
      storeWith({
        proposals: [
          {
            id: 1,
            repo_root: '/r',
            branch: 'b',
            proposed_by: 'A',
            proposed_at: 1_000,
            final_strength: 0.1,
          },
          {
            id: 2,
            repo_root: '/r',
            branch: 'b',
            proposed_by: 'A',
            proposed_at: 2_000,
            final_strength: 0.1,
          },
          {
            id: 3,
            repo_root: '/r',
            branch: 'b',
            proposed_by: 'A',
            proposed_at: twoHours - 30 * 60_000,
            final_strength: 0.1,
          },
        ],
        reinforcements: [{ proposal_id: 2, session_id: 'B', weight: 1, reinforced_at: 3_000 }],
      }),
      { since: 0, until: twoHours },
    );

    expect(report.proposals_without_reinforcement.count).toBe(1);
    expect(report.proposals_without_reinforcement.examples).toEqual([
      { proposal_id: 1, created_ts: 1_000, final_strength: 0.1 },
    ]);
  });

  it('marks examples truncated when findings exceed the cap', () => {
    const edits = Array.from({ length: 12 }, (_, index) => ({
      session_id: `S${index}`,
      file_path: `src/${index}.ts`,
      edit_ts: 1_000 + index,
      has_sibling_claim_within_window: false,
    }));

    const report = buildDiscrepancyReport(storeWith({ edits }), {
      since: 0,
      until: 2_000,
      example_cap: 5,
    });

    expect(report.edits_without_claims.count).toBe(12);
    expect(report.edits_without_claims.examples).toHaveLength(5);
    expect(report.edits_without_claims.truncated).toBe(true);
  });
});
