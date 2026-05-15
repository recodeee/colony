import type { Settings } from '@colony/config';
import type { ClaimBeforeEditStats, CoachStepRow, Storage, ToolCallRow } from '@colony/storage';
import { listInstalledIdes } from '../lib/installed-ides.js';

const SEVEN_DAYS_MS = 7 * 24 * 3_600_000;
const EARLY_OBSERVATION_THRESHOLD = 50;
const GAIN_REVIEW_OBSERVATION_KIND = 'coach_gain_review';

/**
 * Where on the first-week ladder the repo currently sits. The four buckets
 * map to the renderer's tone: `fresh` greets a new install, `installed_no_signal`
 * nudges the user to actually fire a tool, `early` celebrates first signal and
 * surfaces the next habit, `mid_adoption` thins out into a "you're cruising"
 * banner so the coach doesn't outstay its welcome.
 */
export type CoachStage = 'fresh' | 'installed_no_signal' | 'early' | 'mid_adoption';

/**
 * One rung on the 7-step adoption ladder. `done_when` is encoded in
 * {@link buildCoachPayload} as a predicate against tool calls / observation
 * counts — never as a click. `cmd` and `tool` are surfaced verbatim by the
 * renderer so the user can copy-paste the next move.
 */
export interface CoachStep {
  /** Stable identifier; also the SQLite primary key in coach_progress. */
  id: string;
  /** Short human title for the renderer. */
  title: string;
  /** Concrete CLI command the user should run next. */
  cmd: string;
  /** MCP tool that satisfies the step when fired by the agent. */
  tool: string;
  /** What event the coach observes to mark this step complete. */
  done_when: string;
}

export interface CoachCompletedStep extends CoachStep {
  completed_at: number;
  evidence: string | null;
}

export interface CoachPayload {
  stage: CoachStage;
  /** True iff the coach saw no observations and no installed IDEs. */
  fresh_repo: boolean;
  /** Total observations recorded by the local store. */
  observation_count: number;
  /** IDE names currently flagged installed in settings. */
  installed_ides: string[];
  /** Steps that have already been completed (and persisted to coach_progress). */
  completed_steps: CoachCompletedStep[];
  /** The next incomplete step, or null if the user has finished the ladder. */
  next_step: CoachStep | null;
  /** Remaining steps after `next_step`, in ladder order. */
  upcoming: CoachStep[];
}

export interface BuildCoachPayloadOptions {
  /**
   * Window start for tool-call evidence. Defaults to "since the beginning of
   * time" — the coach is interested in lifetime first-fires, not recent
   * activity, but tests pin this to a fixed cutoff.
   */
  since?: number;
  now?: number;
}

/**
 * The 7-step ladder. Order matters: the renderer surfaces them by index, so
 * step N+1 only shows up after step N is marked complete.
 */
export const COACH_LADDER: readonly CoachStep[] = [
  {
    id: 'install_runtime',
    title: 'Install a colony runtime',
    cmd: 'colony install --ide codex',
    tool: 'colony install',
    done_when: 'any IDE is flagged installed in settings.ides',
  },
  {
    id: 'first_task_post',
    title: 'Post your first task note',
    cmd: 'mcp__colony__task_post({ task_id, session_id, kind: "note", content: "branch=...; task=...; next=..." })',
    tool: 'mcp__colony__task_post',
    done_when: 'any task_post call recorded in tool_calls',
  },
  {
    id: 'first_task_claim_file',
    title: 'Claim a file before editing it',
    cmd: 'mcp__colony__task_claim_file({ task_id, session_id, file_path: "..." })',
    tool: 'mcp__colony__task_claim_file',
    done_when: 'any task_claim_file call OR pre-edit claim observed',
  },
  {
    id: 'first_task_hand_off',
    title: 'Hand off ownership of a lane',
    cmd: 'mcp__colony__task_hand_off({ task_id, session_id, released_files: [...], summary: "..." })',
    tool: 'mcp__colony__task_hand_off',
    done_when: 'any task_hand_off call recorded',
  },
  {
    id: 'first_plan_claim',
    title: 'Claim a plan subtask (close the 0/47 gap)',
    cmd: 'mcp__colony__task_plan_claim_subtask({ plan_id, subtask_id, session_id })',
    tool: 'mcp__colony__task_plan_claim_subtask',
    done_when: 'any task_plan_claim_subtask call recorded',
  },
  {
    id: 'first_quota_release',
    title: 'Accept your first quota relay',
    cmd: 'mcp__colony__task_claim_quota_accept({ task_id, session_id, handoff_observation_id })',
    tool: 'mcp__colony__task_claim_quota_accept',
    done_when: 'any task_claim_quota_accept call recorded',
  },
  {
    id: 'first_gain_review',
    title: 'Review your savings with `colony gain`',
    cmd: 'colony gain --summary',
    tool: 'colony gain',
    done_when: 'a coach_gain_review observation is recorded by colony gain',
  },
];

/**
 * Build the coach payload from local store evidence. This is the single place
 * that knows the ladder ordering, the `done_when` predicates, and the stage
 * classifier. It also persists newly-completed steps to `coach_progress` so
 * the next invocation shows progress without re-deriving from raw evidence.
 */
export function buildCoachPayload(
  storage: Storage,
  settings: Settings,
  options: BuildCoachPayloadOptions = {},
): CoachPayload {
  const now = options.now ?? Date.now();
  const since = options.since ?? 0;
  const installedIdes = listInstalledIdes(settings);
  const observationCount = storage.countObservations();
  const calls = storage.toolCallsSince(since);
  const claimStats = storage.claimBeforeEditStats(since);

  const completedSet = new Set(storage.listCoachSteps().map((row: CoachStepRow) => row.step_id));

  const observe = (stepId: string, evidence: string | null): void => {
    if (completedSet.has(stepId)) return;
    storage.markCoachStep(stepId, evidence);
    completedSet.add(stepId);
  };

  if (installedIdes.length > 0) {
    observe('install_runtime', `ides=${installedIdes.join(',')}`);
  }
  detectToolStep(calls, 'task_post', 'first_task_post', observe);
  if (countTool(calls, 'task_claim_file') > 0 || (claimStats.edits_claimed_before ?? 0) > 0) {
    const fileCount = countTool(calls, 'task_claim_file');
    const claimedBefore = claimStats.edits_claimed_before ?? 0;
    observe(
      'first_task_claim_file',
      `task_claim_file=${fileCount}, edits_claimed_before=${claimedBefore}`,
    );
  }
  detectToolStep(calls, 'task_hand_off', 'first_task_hand_off', observe);
  detectToolStep(calls, 'task_plan_claim_subtask', 'first_plan_claim', observe);
  detectToolStep(calls, 'task_claim_quota_accept', 'first_quota_release', observe);
  if (storage.countObservationsByKindSince(GAIN_REVIEW_OBSERVATION_KIND, 0) > 0) {
    observe('first_gain_review', `kind=${GAIN_REVIEW_OBSERVATION_KIND}`);
  }

  // Re-read after marks so completed_steps reflects the canonical store rows
  // (including completed_at timestamps the predicates above couldn't set).
  const completedRows = storage.listCoachSteps();
  const completedById = new Map(completedRows.map((row) => [row.step_id, row]));

  const completed_steps: CoachCompletedStep[] = [];
  const remaining: CoachStep[] = [];
  for (const step of COACH_LADDER) {
    const row = completedById.get(step.id);
    if (row !== undefined) {
      completed_steps.push({
        ...step,
        completed_at: row.completed_at,
        evidence: row.evidence,
      });
    } else {
      remaining.push(step);
    }
  }
  const [next_step = null, ...upcoming] = remaining;

  const fresh_repo = observationCount === 0 && installedIdes.length === 0;
  const stage = classifyStage(storage, {
    fresh_repo,
    observationCount,
    installedIdes,
    calls,
    claimStats,
    now,
  });

  return {
    stage,
    fresh_repo,
    observation_count: observationCount,
    installed_ides: installedIdes,
    completed_steps,
    next_step,
    upcoming,
  };
}

function classifyStage(
  storage: Storage,
  ctx: {
    fresh_repo: boolean;
    observationCount: number;
    installedIdes: string[];
    calls: ToolCallRow[];
    claimStats: ClaimBeforeEditStats;
    now: number;
  },
): CoachStage {
  if (ctx.fresh_repo) return 'fresh';
  const hasAnyToolCall = ctx.calls.length > 0;
  const hasAnyMcpReceipt = storage.countMcpMetricsSince(0, ctx.now) > 0;
  if (ctx.installedIdes.length > 0 && !hasAnyToolCall && !hasAnyMcpReceipt) {
    return 'installed_no_signal';
  }
  const firstTs = storage.firstObservationTs();
  const ageMs = firstTs === null ? 0 : ctx.now - firstTs;
  if (ctx.observationCount < EARLY_OBSERVATION_THRESHOLD || ageMs < SEVEN_DAYS_MS) {
    return 'early';
  }
  return 'mid_adoption';
}

function detectToolStep(
  calls: ToolCallRow[],
  toolName: string,
  stepId: string,
  observe: (stepId: string, evidence: string | null) => void,
): void {
  const match = calls.find((call) => isColonyTool(call.tool, toolName));
  if (match !== undefined) {
    observe(stepId, `tool=${match.tool}, call_id=${match.id}`);
  }
}

function countTool(calls: ToolCallRow[], toolName: string): number {
  return calls.filter((call) => isColonyTool(call.tool, toolName)).length;
}

function isColonyTool(tool: string, toolName: string): boolean {
  return tool === toolName || tool === `colony.${toolName}` || tool === `mcp__colony__${toolName}`;
}

export interface FormatCoachOutputOptions {
  json?: boolean;
}

/**
 * Render the coach payload either as compact prose (default) or as JSON.
 * The prose form is intentionally numbered + indented with `cmd:` / `tool:`
 * lines so it's grep-able and copy-paste-friendly.
 */
export function formatCoachOutput(
  payload: CoachPayload,
  options: FormatCoachOutputOptions = {},
): string {
  if (options.json === true) {
    return JSON.stringify(payload, null, 2);
  }

  const lines: string[] = [];
  lines.push('colony health --coach');
  lines.push('');
  lines.push(stageBanner(payload));
  lines.push('');

  if (payload.completed_steps.length > 0) {
    lines.push(`Completed (${payload.completed_steps.length}/${COACH_LADDER.length}):`);
    for (const step of payload.completed_steps) {
      const index = COACH_LADDER.findIndex((s) => s.id === step.id) + 1;
      lines.push(`  ${index}. [x] ${step.title}`);
      if (step.evidence !== null) {
        lines.push(`     evidence: ${step.evidence}`);
      }
    }
    lines.push('');
  }

  if (payload.next_step !== null) {
    const index = COACH_LADDER.findIndex((s) => s.id === payload.next_step?.id) + 1;
    lines.push('Next habit:');
    lines.push(`  ${index}. ${payload.next_step.title}`);
    lines.push(`     cmd:  ${payload.next_step.cmd}`);
    lines.push(`     tool: ${payload.next_step.tool}`);
    lines.push(`     done_when: ${payload.next_step.done_when}`);
    lines.push('');
  } else {
    lines.push('You finished the first-week ladder. Coach has nothing left to teach.');
    lines.push('');
  }

  if (payload.upcoming.length > 0) {
    lines.push('Upcoming:');
    for (const step of payload.upcoming) {
      const index = COACH_LADDER.findIndex((s) => s.id === step.id) + 1;
      lines.push(`  ${index}. ${step.title}`);
    }
  }

  return lines.join('\n');
}

function stageBanner(payload: CoachPayload): string {
  switch (payload.stage) {
    case 'fresh':
      return 'stage: fresh repo (no observations, no installed IDEs). Start at step 1.';
    case 'installed_no_signal':
      return `stage: installed but quiet (ides=${payload.installed_ides.join(',') || 'none'}). Fire one tool to wake colony up.`;
    case 'early':
      return `stage: early adoption (${payload.observation_count} observations). Keep the habit going.`;
    case 'mid_adoption':
      return `stage: cruising (${payload.observation_count} observations). Coach will step aside soon.`;
  }
}
