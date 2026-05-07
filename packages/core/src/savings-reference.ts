/**
 * Hand-authored estimates of token cost for common dev-loop operations with
 * and without colony's compact-first / progressive-disclosure surfaces.
 *
 * The per-session frequency is illustrative. Runtime comparison surfaces use
 * `mcp_operations` to project live `mcp_metrics` receipts onto this model, so
 * totals move with the requested live window instead of only reporting the
 * static catalog total.
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
  mcp_operations: ReadonlyArray<string>;
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
  mcpOperations: ReadonlyArray<string> = [],
): SavingsReferenceRow {
  return {
    operation,
    frequency_per_session,
    baseline_tokens,
    colony_tokens,
    savings_pct: pct(baseline_tokens, colony_tokens),
    rationale,
    mcp_operations: mcpOperations,
  };
}

export const SAVINGS_REFERENCE_ROWS: ReadonlyArray<SavingsReferenceRow> = [
  row(
    'Recall prior decision',
    5,
    8_000,
    1_500,
    'search → get_observations IDs vs re-reading PR threads + scrollback',
    ['recall_session'],
  ),
  row(
    'Resume task across sessions',
    3,
    15_000,
    2_000,
    'hivemind_context + task_note_working vs re-deriving from 5–10 files',
    ['task_note_working'],
  ),
  row(
    'Startup coordination sweep',
    1,
    25_000,
    2_500,
    'hivemind_context + attention_inbox vs serial git/status/task scans',
    ['hivemind_context', 'attention_inbox', 'startup_panel', 'bridge_status'],
  ),
  row(
    'Coordinate parallel agents',
    10,
    20_000,
    3_000,
    'attention_inbox + task_messages vs duplicate scan + re-grep',
    ['task_message', 'task_message_claim'],
  ),
  row(
    'Why-was-this-changed',
    4,
    8_000,
    1_200,
    'search filename → get_observations vs git log + blame + read file',
    [],
  ),
  row(
    'Find active owner for a file',
    6,
    6_000,
    500,
    'claim index lookup vs repo-wide grep + branch/worktree inspection',
    [],
  ),
  row(
    'Recover stranded lane',
    1,
    18_000,
    1_800,
    'attention_inbox stalled lanes + relays vs manual worktree archaeology',
    ['rescue_stranded_scan', 'rescue_stranded_run'],
  ),
  row(
    'Cross-agent handoff',
    2,
    30_000,
    400,
    'task_hand_off (branch/task/next/evidence) vs full session log dump',
    ['task_hand_off', 'task_accept_handoff', 'task_decline_handoff'],
  ),
  row(
    'Review task timeline',
    4,
    12_000,
    900,
    'task_timeline IDs first, hydrate only selected observations',
    ['task_timeline', 'timeline', 'task_updates_since', 'get_observations'],
  ),
  row(
    'Search result shape',
    8,
    5_000,
    150,
    'compact IDs + snippets vs inline full bodies (hydrate via get_observations)',
    ['search'],
  ),
  row(
    'Ready-work selection',
    3,
    9_000,
    700,
    'task_ready_for_agent returns one claimable next tool instead of browsing task lists',
    ['task_ready_for_agent', 'task_plan_list', 'task_foraging_report'],
  ),
  row(
    'Unread message triage',
    4,
    10_000,
    600,
    'task_messages compact previews + mark_read receipts vs opening every task thread',
    ['task_messages', 'task_message_mark_read', 'task_message_retract'],
  ),
  row(
    'Claim-before-edit check',
    8,
    4_000,
    450,
    'task_claim_file overlap response vs ad hoc owner search before each edit',
    [
      'task_claim_file',
      'task_claim_quota_accept',
      'task_claim_quota_decline',
      'task_claim_quota_release_expired',
    ],
  ),
  row(
    'Plan subtask claim',
    2,
    12_000,
    1_100,
    'task_plan_claim_subtask exact args vs manually matching plan dependencies',
    ['task_plan_claim_subtask', 'task_plan_complete_subtask', 'task_plan_status_for_spec_row'],
  ),
  row(
    'Spec context recall',
    2,
    14_000,
    1_600,
    'spec_build_context scoped rows vs reading the whole spec tree',
    [
      'spec_read',
      'spec_build_context',
      'spec_build_record_failure',
      'spec_change_open',
      'spec_change_add_delta',
      'spec_archive',
      'openspec_sync_status',
    ],
  ),
  row(
    'Health/adoption diagnosis',
    1,
    16_000,
    1_800,
    'startup_panel + health nudges vs reconstructing adoption from raw events',
    ['task_autopilot_tick', 'hivemind', 'list_sessions'],
  ),
  row(
    'Examples pattern lookup',
    2,
    11_000,
    1_000,
    'examples_query compact hits vs cloning and grepping reference projects',
    ['examples_list', 'examples_query', 'examples_integrate_plan'],
  ),
  row(
    'Blocker recurrence',
    2,
    10_000,
    900,
    'search keyed on blocker / failed_approach observations vs cold re-investigation of the same dead end',
    ['task_suggest_approach'],
  ),
  row(
    'Drift / failed-verification recovery',
    2,
    13_000,
    1_400,
    'spec_build_record_failure surfaces the matching §V invariant after a test fails vs re-deriving the constraint from the spec tree',
    ['task_drift_check'],
  ),
  row(
    'Quota-exhausted handoff',
    1,
    22_000,
    500,
    'task_relay quota_exhausted carries claim+next+evidence into the rescuer vs reconstructing from worktree + git log',
    ['task_relay', 'task_accept_relay', 'task_decline_relay'],
  ),
  row(
    'Storage at rest (per observation)',
    1,
    1_000,
    300,
    'caveman compression preserves technical tokens byte-for-byte',
    ['savings_report'],
  ),
  row(
    'Plan publication & goal anchoring',
    2,
    25_000,
    2_500,
    'queen_plan_goal sets the goal once and task_plan_publish ships compact subtasks/edges; without colony each agent re-derives the plan from a multi-page doc and re-validates dependencies by hand',
    ['queen_plan_goal', 'task_plan_publish', 'task_plan_validate', 'task_propose'],
  ),
  row(
    'Task thread note',
    8,
    3_500,
    200,
    'task_post / task_reinforce attach a structured note (branch/blocker/next/evidence) to the task thread; without colony each note re-states context in a PR comment, Slack, and chat scrollback',
    ['task_post', 'task_reinforce'],
  ),
  row(
    'Task dependency linking',
    1,
    6_000,
    600,
    'task_link / task_links / task_unlink record edges between tasks; without colony dependencies live in a freeform TODO doc that has to be re-read on every refresh',
    ['task_link', 'task_links', 'task_unlink'],
  ),
  row(
    'Agent profile sync',
    1,
    4_000,
    350,
    'agent_upsert_profile / agent_get_profile keep agent role, tooling, and tier preferences as one compact record; without colony each new session re-introduces the agent in the prompt',
    ['agent_get_profile', 'agent_upsert_profile'],
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

export interface SavingsLiveMetricRow {
  operation: string;
  calls: number;
  total_tokens: number;
  last_ts?: number | null;
}

export interface SavingsLiveComparisonRow {
  operation: string;
  calls: number;
  baseline_tokens: number;
  colony_tokens: number;
  savings_pct: number;
  matched_operations: ReadonlyArray<string>;
  last_ts: number | null;
}

export interface SavingsLiveUnmatchedOperation {
  operation: string;
  calls: number;
  colony_tokens: number;
}

export interface SavingsLiveComparisonTotals {
  calls: number;
  baseline_tokens: number;
  colony_tokens: number;
  savings_pct: number;
  unmatched_calls: number;
  unmatched_colony_tokens: number;
}

export interface SavingsLiveComparison {
  kind: 'live_window_reference_model';
  note: string;
  rows: SavingsLiveComparisonRow[];
  totals: SavingsLiveComparisonTotals;
  unmatched_operations: SavingsLiveUnmatchedOperation[];
}

export interface SavingsLiveMetricCostRow {
  operation: string;
  total_tokens: number;
  total_cost_usd: number;
}

export interface SavingsLiveComparisonCostRow {
  operation: string;
  calls: number;
  baseline_cost_usd: number;
  colony_cost_usd: number;
  saved_cost_usd: number;
  matched_operations: ReadonlyArray<string>;
}

export interface SavingsLiveComparisonCostTotals {
  calls: number;
  baseline_cost_usd: number;
  colony_cost_usd: number;
  saved_cost_usd: number;
}

export interface SavingsLiveComparisonCost {
  kind: 'estimated_live_window_usd';
  note: string;
  rows: SavingsLiveComparisonCostRow[];
  totals: SavingsLiveComparisonCostTotals;
}

export function savingsLiveComparison(
  metrics: ReadonlyArray<SavingsLiveMetricRow>,
  referenceRows: ReadonlyArray<SavingsReferenceRow> = SAVINGS_REFERENCE_ROWS,
): SavingsLiveComparison {
  const metricByOperation = new Map(metrics.map((metric) => [metric.operation, metric]));
  const claimedOperations = new Set<string>();
  const rows: SavingsLiveComparisonRow[] = [];

  for (const reference of referenceRows) {
    const aliases = reference.mcp_operations.length > 0 ? reference.mcp_operations : [];
    const matchedOperations: string[] = [];
    let calls = 0;
    let colonyTokens = 0;
    let lastTs: number | null = null;

    for (const op of aliases) {
      if (claimedOperations.has(op)) continue;
      const metric = metricByOperation.get(op);
      if (metric === undefined || metric.calls <= 0) continue;
      claimedOperations.add(op);
      matchedOperations.push(op);
      calls += metric.calls;
      colonyTokens += metric.total_tokens;
      if (metric.last_ts !== undefined && metric.last_ts !== null) {
        lastTs = lastTs === null ? metric.last_ts : Math.max(lastTs, metric.last_ts);
      }
    }

    if (calls === 0) continue;
    const baselineTokens = reference.baseline_tokens * calls;
    rows.push({
      operation: reference.operation,
      calls,
      baseline_tokens: baselineTokens,
      colony_tokens: colonyTokens,
      savings_pct: pct(baselineTokens, colonyTokens),
      matched_operations: matchedOperations,
      last_ts: lastTs,
    });
  }

  const unmatchedOperations: SavingsLiveUnmatchedOperation[] = [];
  let unmatchedCalls = 0;
  let unmatchedColonyTokens = 0;
  for (const metric of metrics) {
    if (metric.calls <= 0 || claimedOperations.has(metric.operation)) continue;
    unmatchedOperations.push({
      operation: metric.operation,
      calls: metric.calls,
      colony_tokens: metric.total_tokens,
    });
    unmatchedCalls += metric.calls;
    unmatchedColonyTokens += metric.total_tokens;
  }

  const baseline = rows.reduce((sum, row) => sum + row.baseline_tokens, 0);
  const colony = rows.reduce((sum, row) => sum + row.colony_tokens, 0);
  const calls = rows.reduce((sum, row) => sum + row.calls, 0);

  return {
    kind: 'live_window_reference_model',
    note: 'Observed mcp_metrics calls mapped to reference operation aliases. Baseline is estimated standard tokens for that observed call mix; colony tokens are actual live receipts.',
    rows,
    totals: {
      calls,
      baseline_tokens: baseline,
      colony_tokens: colony,
      savings_pct: pct(baseline, colony),
      unmatched_calls: unmatchedCalls,
      unmatched_colony_tokens: unmatchedColonyTokens,
    },
    unmatched_operations: unmatchedOperations,
  };
}

export function savingsLiveComparisonCost(
  comparison: SavingsLiveComparison,
  metrics: ReadonlyArray<SavingsLiveMetricCostRow>,
): SavingsLiveComparisonCost {
  const metricByOperation = new Map(metrics.map((metric) => [metric.operation, metric]));
  const rows: SavingsLiveComparisonCostRow[] = [];

  for (const row of comparison.rows) {
    let matchedTokens = 0;
    let colonyCost = 0;
    for (const operation of row.matched_operations) {
      const metric = metricByOperation.get(operation);
      if (metric === undefined) continue;
      matchedTokens += metric.total_tokens;
      colonyCost += metric.total_cost_usd;
    }
    if (matchedTokens <= 0) continue;
    const usdPerToken = colonyCost / matchedTokens;
    const baselineCost = roundUsd(row.baseline_tokens * usdPerToken);
    const normalizedColonyCost = roundUsd(colonyCost);
    rows.push({
      operation: row.operation,
      calls: row.calls,
      baseline_cost_usd: baselineCost,
      colony_cost_usd: normalizedColonyCost,
      saved_cost_usd: roundUsd(baselineCost - normalizedColonyCost),
      matched_operations: row.matched_operations,
    });
  }

  const totals = rows.reduce<SavingsLiveComparisonCostTotals>(
    (acc, row) => ({
      calls: acc.calls + row.calls,
      baseline_cost_usd: roundUsd(acc.baseline_cost_usd + row.baseline_cost_usd),
      colony_cost_usd: roundUsd(acc.colony_cost_usd + row.colony_cost_usd),
      saved_cost_usd: roundUsd(acc.saved_cost_usd + row.saved_cost_usd),
    }),
    { calls: 0, baseline_cost_usd: 0, colony_cost_usd: 0, saved_cost_usd: 0 },
  );

  return {
    kind: 'estimated_live_window_usd',
    note: 'Estimated by applying each matched live mcp_metrics operation USD/token rate to the reference-model token delta for the same observed calls.',
    rows,
    totals,
  };
}

function roundUsd(value: number): number {
  return Number(value.toFixed(12));
}
