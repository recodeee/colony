/**
 * Static, hand-authored estimates of token cost for common dev-loop operations
 * with and without colony's compact-first / progressive-disclosure surfaces.
 *
 * These rows are illustrative — the source of truth at runtime is the live
 * `mcp_metrics` table. They exist so the README, the CLI `colony gain` table,
 * the MCP `savings_report` tool, and the viewer `/savings` page tell the
 * same story.
 *
 * Update process when these change:
 * 1. Adjust the row(s) in `SAVINGS_REFERENCE_ROWS` here.
 * 2. Re-run the docs snippet generator if one exists; otherwise update the
 *    matching paragraph in README.md by hand.
 *
 * Numbers are token estimates, not bytes.
 */

export interface SavingsReferenceRow {
  operation: string;
  frequency_per_session: number;
  baseline_tokens: number;
  colony_tokens: number;
  savings_pct: number;
  rationale: string;
}

function pct(baseline: number, colony: number): number {
  if (baseline <= 0) return 0;
  return Math.round((1 - colony / baseline) * 100);
}

function row(
  operation: string,
  frequency_per_session: number,
  baseline_tokens: number,
  colony_tokens: number,
  rationale: string,
): SavingsReferenceRow {
  return {
    operation,
    frequency_per_session,
    baseline_tokens,
    colony_tokens,
    savings_pct: pct(baseline_tokens, colony_tokens),
    rationale,
  };
}

export const SAVINGS_REFERENCE_ROWS: ReadonlyArray<SavingsReferenceRow> = [
  row(
    'Recall prior decision',
    5,
    8_000,
    1_500,
    'search → get_observations IDs vs re-reading PR threads + scrollback',
  ),
  row(
    'Resume task across sessions',
    3,
    15_000,
    2_000,
    'hivemind_context + task_note_working vs re-deriving from 5–10 files',
  ),
  row(
    'Startup coordination sweep',
    1,
    25_000,
    2_500,
    'hivemind_context + attention_inbox vs serial git/status/task scans',
  ),
  row(
    'Coordinate parallel agents',
    10,
    20_000,
    3_000,
    'attention_inbox + task_messages vs duplicate scan + re-grep',
  ),
  row(
    'Why-was-this-changed',
    4,
    8_000,
    1_200,
    'search filename → get_observations vs git log + blame + read file',
  ),
  row(
    'Find active owner for a file',
    6,
    6_000,
    500,
    'claim index lookup vs repo-wide grep + branch/worktree inspection',
  ),
  row(
    'Recover stranded lane',
    1,
    18_000,
    1_800,
    'attention_inbox stalled lanes + relays vs manual worktree archaeology',
  ),
  row(
    'Cross-agent handoff',
    2,
    30_000,
    400,
    'task_hand_off (branch/task/next/evidence) vs full session log dump',
  ),
  row(
    'Review task timeline',
    4,
    12_000,
    900,
    'task_timeline IDs first, hydrate only selected observations',
  ),
  row(
    'Search result shape',
    8,
    5_000,
    150,
    'compact IDs + snippets vs inline full bodies (hydrate via get_observations)',
  ),
  row(
    'Ready-work selection',
    3,
    9_000,
    700,
    'task_ready_for_agent returns one claimable next tool instead of browsing task lists',
  ),
  row(
    'Storage at rest (per observation)',
    1,
    1_000,
    300,
    'caveman compression preserves technical tokens byte-for-byte',
  ),
];

export interface SavingsReferenceTotals {
  baseline_tokens: number;
  colony_tokens: number;
  savings_pct: number;
}

export function savingsReferenceTotals(
  rows: ReadonlyArray<SavingsReferenceRow> = SAVINGS_REFERENCE_ROWS,
): SavingsReferenceTotals {
  let baseline = 0;
  let colony = 0;
  for (const r of rows) {
    baseline += r.baseline_tokens * r.frequency_per_session;
    colony += r.colony_tokens * r.frequency_per_session;
  }
  return {
    baseline_tokens: baseline,
    colony_tokens: colony,
    savings_pct: pct(baseline, colony),
  };
}
