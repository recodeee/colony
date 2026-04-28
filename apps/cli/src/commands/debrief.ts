import { loadSettings } from '@colony/config';
import type { ClaimCoverageStats, Storage } from '@colony/storage';
import type { Command } from 'commander';
import kleur from 'kleur';
import { withStorage } from '../util/store.js';

/**
 * Default window: last 24h. The "ran it today" common case. Overridable
 * with --hours for zoomed-in post-mortems or multi-day sweeps.
 */
const DEFAULT_HOURS = 24;

// These values are starting guesses based on the Apr 2026 debrief snapshot
// showing ~0.07, and will need tuning after a week of running.
export const COMMIT_RATIO_HEALTHY = 0.3;
export const COMMIT_RATIO_MIXED = 0.1;

interface DebriefContext {
  storage: Storage;
  since: number;
  taskId?: number | undefined;
}

interface CoordinationActivityResult {
  commits: number;
  reads: number;
  commits_by_session: Map<string, number>;
  reads_by_session: Map<string, number>;
}

interface CoordinationActivityStorage {
  coordinationActivity(since: number): CoordinationActivityResult;
}

type ClaimCoverageVerdict =
  | 'safety net carrying load — expected'
  | 'hook integration broken — investigate'
  | 'explicit claiming present — auto-claim supporting'
  | 'mixed claim coverage — monitor'
  | null;

interface ClaimCoveragePayload extends ClaimCoverageStats {
  explicit_claim_to_edit_ratio: number | null;
  auto_claim_to_edit_ratio: number | null;
  verdict: ClaimCoverageVerdict;
}

interface CoordinationRatioPayload {
  commits: number;
  reads: number;
  ratio: number | null;
  verdict: 'healthy' | 'mixed' | 'reading without committing' | null;
  sessions: Array<{
    session_id: string;
    ide: string;
    commits: number;
    reads: number;
    total: number;
    ratio: number | null;
  }>;
}

const COMMIT_RATIO_COMMIT_EXAMPLES = [
  'task_relay',
  'task_hand_off',
  'task_claim_file',
  'task_message',
];
const COMMIT_RATIO_READ_EXAMPLES = ['hivemind_context', 'task_list', 'attention_inbox'];
const MIRROR_ROW_NOTE =
  '*-mirror rows are passive copies of built-in TaskCreate/TaskUpdate calls attached to task threads.';

/**
 * Section 1 — did agents use the task tools at all?
 *
 * Signal: ratio of task-thread-tagged observations to total observations
 * per session. A session with many observations but zero task-thread
 * ones is an agent that memorized nothing from the SessionStart preface.
 */
function sectionToolUsage(ctx: DebriefContext): string[] {
  const lines = [kleur.bold('1. Did agents use the task tools?')];
  const rows = ctx.storage.toolUsageBySession(ctx.since);
  if (rows.length === 0) {
    lines.push(kleur.dim('  No activity in the window.'));
    return lines;
  }
  for (const r of rows) {
    const ratio = r.total_obs > 0 ? Math.round((r.task_tool_obs / r.total_obs) * 100) : 0;
    const marker = ratio >= 10 ? kleur.green('✓') : ratio >= 2 ? kleur.yellow('~') : kleur.red('✗');
    lines.push(
      `  ${marker} ${r.session_id.padEnd(16)} ${r.total_obs} obs, ${r.task_tool_obs} task-tool (${ratio}%)`,
    );
  }
  lines.push(
    kleur.dim(
      '  Interpretation: <2% = tool surface invisible; 2-10% = occasional; >10% = integrated.',
    ),
  );
  return lines;
}

/**
 * Section 2 — did auto-join land?
 *
 * We can't directly see what the agent "saw" in its context, but we CAN
 * check: for each session that started, did a join event land in
 * task_participants within ~2s of session start? If yes, the preface
 * generation fired; if no, something broke the auto-join path.
 */
function sectionAutoJoin(ctx: DebriefContext): string[] {
  const lines = ['', kleur.bold('2. Did auto-join land?')];
  const sessions = ctx.storage
    .listSessions(200)
    .filter((s) => s.started_at >= ctx.since && s.id !== 'observer');
  if (sessions.length === 0) {
    lines.push(kleur.dim('  No sessions started in window.'));
    return lines;
  }
  let joined = 0;
  let missed = 0;
  for (const s of sessions) {
    const joinRow = ctx.storage.participantJoinFor(s.id);
    if (joinRow && joinRow.joined_at - s.started_at < 2000) {
      joined++;
    } else {
      missed++;
      lines.push(`  ${kleur.red('✗')} ${s.id} (${s.ide}) started but did not join a task`);
    }
  }
  lines.push(
    `  ${kleur.green('✓')} ${joined} sessions auto-joined, ${kleur.red(`${missed} missed`)}`,
  );
  if (missed > 0) {
    lines.push(
      kleur.dim(
        '  Missed joins usually mean cwd was outside a git repo or the branch lookup failed.',
      ),
    );
  }
  return lines;
}

/**
 * Section 3 — claim coverage (proactive vs auto).
 *
 * Splits explicit `claim` observations from automatic `auto-claim`
 * observations so the debrief reports the current safety model honestly.
 */
export function sectionClaimCoverage(ctx: DebriefContext): string[] {
  const lines = ['', kleur.bold('3. Claim coverage (proactive vs auto)')];
  const payload = claimCoveragePayload(ctx);
  lines.push(`  Edits observed:        ${payload.edit_count}`);
  lines.push(
    `  Explicit claim kinds:  ${formatKindCounts(payload.explicit_claim_kinds)}  ${kleur.dim(`(${payload.explicit_claim_count} total)`)}`,
  );
  lines.push(
    `  Auto-claim kinds:      ${formatKindCounts(payload.auto_claim_kinds)}  ${kleur.dim(`(${payload.auto_claim_count} total)`)}`,
  );
  lines.push(
    `  Explicit claim/edit:   ${formatPercentRatio(payload.explicit_claim_to_edit_ratio)}`,
  );
  lines.push(`  Auto-claim/edit:       ${formatPercentRatio(payload.auto_claim_to_edit_ratio)}`);
  lines.push(`  Verdict:               ${colorClaimCoverageVerdict(payload.verdict)}`);
  return lines;
}

/**
 * Section 4 — handoff outcomes.
 *
 * Groups handoffs by final status. >30% expiry suggests either a TTL
 * that's too short or a receiver-side notification that isn't loud
 * enough to land; also reports median accept latency so you can see
 * "how fast did the hand-off baton actually pass" empirically.
 */
function sectionHandoffs(ctx: DebriefContext): string[] {
  const lines = ['', kleur.bold('4. Handoff outcomes')];
  const dist = ctx.storage.handoffStatusDistribution(ctx.since);
  const total = dist.accepted + dist.cancelled + dist.expired + dist.pending;
  if (total === 0) {
    lines.push(kleur.dim('  No handoffs in window.'));
    return lines;
  }
  const pct = (n: number) => `${Math.round((n / total) * 100)}%`;
  lines.push(`  accepted:  ${dist.accepted} (${pct(dist.accepted)})`);
  lines.push(`  cancelled: ${dist.cancelled} (${pct(dist.cancelled)})  ${kleur.dim('(declined)')}`);
  lines.push(`  expired:   ${dist.expired} (${pct(dist.expired)})`);
  lines.push(`  pending:   ${dist.pending} (${pct(dist.pending)})  ${kleur.dim('(still live)')}`);

  const expiryRate = dist.expired / total;
  if (expiryRate > 0.3) {
    lines.push(
      `  ${kleur.yellow('⚠')} ${Math.round(expiryRate * 100)}% expiry rate — shorten TTL, sharpen notification, or rethink the default.`,
    );
  }

  const times = ctx.storage.handoffAcceptLatencies(ctx.since);
  if (times.length > 0) {
    const sorted = [...times].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    lines.push(`  median time-to-accept: ${Math.round(median / 60_000)}m`);
  }
  return lines;
}

/**
 * Section 5 — tool invocation distribution.
 *
 * Counts every `tool_use` observation grouped by tool name. The point is
 * empirical: knowing that `mcp__colony__task_post` fired 8 times while
 * `mcp__colony__task_propose` fired 0 lets the next round of build/cut
 * decisions lean on real call counts instead of intuition. Built-in
 * tools and MCP tools share one list — the `mcp__` prefix discriminates.
 */
function sectionToolDistribution(ctx: DebriefContext): string[] {
  const lines = ['', kleur.bold('5. Tool invocation distribution')];
  const rows = ctx.storage.toolInvocationDistribution(ctx.since, 20);
  if (rows.length === 0) {
    lines.push(kleur.dim('  No tool_use observations in window.'));
    lines.push(kleur.dim(`  ${MIRROR_ROW_NOTE}`));
    return lines;
  }
  const widest = rows.reduce((w, r) => Math.max(w, r.tool.length), 0);
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  for (const r of rows) {
    const pct = Math.round((r.count / total) * 100);
    const isMcp = r.tool.startsWith('mcp__');
    const name = isMcp ? kleur.cyan(r.tool.padEnd(widest)) : r.tool.padEnd(widest);
    lines.push(`  ${name}  ${String(r.count).padStart(5)}  ${kleur.dim(`(${pct}%)`)}`);
  }
  lines.push(
    kleur.dim(
      `  Top ${rows.length} tools, ${total} invocations total. Cyan = MCP tool. Zero-call tools won't appear — grep code if you suspect a registered tool is unused.`,
    ),
  );
  lines.push(kleur.dim(`  ${MIRROR_ROW_NOTE}`));
  return lines;
}

/**
 * Section 7 — coordination commit ratio.
 *
 * Compares coordination writes with coordination reads. Low ratios mean
 * agents can see Colony state but are not leaving durable coordination behind.
 */
export function sectionCoordinationRatio(ctx: DebriefContext): string[] {
  const lines = ['', kleur.bold('7. Coordination commit ratio')];
  const payload = coordinationRatioPayload(ctx);
  if (payload.commits === 0 && payload.reads === 0) {
    lines.push(kleur.dim('  no coordination activity in window.'));
    return lines;
  }
  lines.push(`  Commits:     ${payload.commits} (${toolExamples(COMMIT_RATIO_COMMIT_EXAMPLES)})`);
  lines.push(`  Reads:       ${payload.reads} (${toolExamples(COMMIT_RATIO_READ_EXAMPLES)})`);
  lines.push(
    `  Ratio:       ${formatRatio(payload.ratio)}  →  ${colorRatioVerdict(payload.verdict)}; ${ratioExplanation(payload)}`,
  );
  lines.push('  Per session (top 5 by total activity):');
  for (const session of payload.sessions) {
    lines.push(
      `    ${coordinationSessionLabel(session).padEnd(16)} commits=${String(session.commits).padEnd(4)} reads=${String(session.reads).padEnd(5)} ratio=${formatRatio(session.ratio)}`,
    );
  }
  if (payload.sessions.length === 0) lines.push(kleur.dim('    none'));
  lines.push(
    kleur.dim('  Interpretation: >0.3 healthy; 0.1-0.3 mixed; <0.1 reading-without-committing.'),
  );
  return lines;
}

/**
 * Section 8 — interleaved timeline.
 *
 * No analysis, just chronology. Observer notes are colored magenta so
 * you can scan for moments where your note sits next to an agent event —
 * those are the coordination failures the numeric sections can't surface.
 */
function sectionTimeline(ctx: DebriefContext): string[] {
  const lines = ['', kleur.bold('8. Timeline (observer notes interleaved with agent activity)')];
  const events = ctx.storage.mixedTimeline(ctx.since, ctx.taskId);
  if (events.length === 0) {
    lines.push(kleur.dim('  No events.'));
    return lines;
  }
  for (const e of events) {
    const ts = new Date(e.ts).toISOString().slice(11, 19);
    const isNote = e.kind === 'observer-note';
    const prefix = isNote ? kleur.magenta('  NOTE ') : `  ${e.kind.padEnd(6)}`;
    const who = kleur.dim(e.session_id.padEnd(10));
    const head = e.content.split('\n')[0]?.slice(0, 70) ?? '';
    lines.push(`${kleur.dim(ts)} ${prefix} ${who} ${head}`);
  }
  return lines;
}

/**
 * Section 9 — bash coordination volume.
 *
 * Bash parser observations are separate from normal tool_use counts: git-op
 * shows branch/rebase/merge/reset coordination; file-op shows shell-level
 * file movement/deletion that can bypass editor-tool intuition.
 */
function sectionBashCoordinationVolume(ctx: DebriefContext): string[] {
  const lines = ['', kleur.bold('9. Bash coordination volume')];
  const volume = ctx.storage.bashCoordinationVolume(ctx.since);
  lines.push(`  git-op count:  ${volume.git_op_count}`);
  lines.push(`  file-op count: ${volume.file_op_count}`);
  lines.push('  Top files by file-op:');
  if (volume.top_files_by_file_op.length === 0) {
    lines.push(kleur.dim('    none'));
  } else {
    for (const row of volume.top_files_by_file_op) {
      lines.push(`    ${row.file_path}  ${row.count}`);
    }
  }
  return lines;
}

function claimCoveragePayload(ctx: DebriefContext): ClaimCoveragePayload {
  const stats = ctx.storage.claimCoverageStats(ctx.since);
  const explicitRatio = stats.edit_count > 0 ? stats.explicit_claim_count / stats.edit_count : null;
  const autoRatio = stats.edit_count > 0 ? stats.auto_claim_count / stats.edit_count : null;
  return {
    ...stats,
    explicit_claim_to_edit_ratio: explicitRatio,
    auto_claim_to_edit_ratio: autoRatio,
    verdict: claimCoverageVerdict(explicitRatio, autoRatio),
  };
}

function claimCoverageVerdict(
  explicitRatio: number | null,
  autoRatio: number | null,
): ClaimCoverageVerdict {
  if (explicitRatio === null || autoRatio === null) return null;
  if (autoRatio > 0.95 && explicitRatio < 0.05) return 'safety net carrying load — expected';
  if (autoRatio < 0.5) return 'hook integration broken — investigate';
  if (explicitRatio >= 0.2) return 'explicit claiming present — auto-claim supporting';
  return 'mixed claim coverage — monitor';
}

function coordinationRatioPayload(ctx: DebriefContext): CoordinationRatioPayload {
  const activity = (ctx.storage as Storage & CoordinationActivityStorage).coordinationActivity(
    ctx.since,
  );
  const ideBySession = new Map(
    ctx.storage.listSessions(500).map((session) => [session.id, session.ide]),
  );
  const ids = new Set<string>([
    ...activity.commits_by_session.keys(),
    ...activity.reads_by_session.keys(),
  ]);
  const sessions = Array.from(ids, (session_id) => {
    const commits = activity.commits_by_session.get(session_id) ?? 0;
    const reads = activity.reads_by_session.get(session_id) ?? 0;
    return {
      session_id,
      ide: ideBySession.get(session_id) ?? 'agent',
      commits,
      reads,
      total: commits + reads,
      ratio: reads > 0 ? commits / reads : null,
    };
  })
    .sort((a, b) => b.total - a.total || a.session_id.localeCompare(b.session_id))
    .slice(0, 5);
  const ratio = activity.reads > 0 ? activity.commits / activity.reads : null;
  return {
    commits: activity.commits,
    reads: activity.reads,
    ratio,
    verdict:
      ratio === null
        ? null
        : ratio >= COMMIT_RATIO_HEALTHY
          ? 'healthy'
          : ratio >= COMMIT_RATIO_MIXED
            ? 'mixed'
            : 'reading without committing',
    sessions,
  };
}

function debriefJson(ctx: DebriefContext): Record<string, unknown> {
  const sessions = ctx.storage
    .listSessions(200)
    .filter((s) => s.started_at >= ctx.since && s.id !== 'observer');
  const autoJoin = sessions.reduce(
    (acc, session) => {
      const join = ctx.storage.participantJoinFor(session.id);
      if (join && join.joined_at - session.started_at < 2000) acc.joined++;
      else acc.missed_sessions.push(session.id);
      return acc;
    },
    { joined: 0, missed_sessions: [] as string[] },
  );
  const claimCoverage = claimCoveragePayload(ctx);
  const handoffs = ctx.storage.handoffStatusDistribution(ctx.since);
  const latencies = ctx.storage.handoffAcceptLatencies(ctx.since).sort((a, b) => a - b);
  const toolDistribution = ctx.storage.toolInvocationDistribution(ctx.since, 20);
  const bashCoordinationVolume = ctx.storage.bashCoordinationVolume(ctx.since);
  return {
    tool_usage: ctx.storage.toolUsageBySession(ctx.since),
    auto_join: {
      sessions_started: sessions.length,
      joined: autoJoin.joined,
      missed: autoJoin.missed_sessions.length,
      missed_sessions: autoJoin.missed_sessions,
    },
    claim_coverage: claimCoverage,
    proactive_claims: {
      edit_count: claimCoverage.edit_count,
      claim_count: claimCoverage.explicit_claim_count,
      ratio: claimCoverage.explicit_claim_to_edit_ratio,
    },
    handoffs: {
      ...handoffs,
      total: handoffs.accepted + handoffs.cancelled + handoffs.expired + handoffs.pending,
      median_accept_latency_ms:
        latencies.length > 0 ? (latencies[Math.floor(latencies.length / 2)] ?? 0) : null,
    },
    tool_distribution: toolDistribution,
    coordination_ratio: coordinationRatioPayload(ctx),
    bash_coordination_volume: bashCoordinationVolume,
    timeline: ctx.storage.mixedTimeline(ctx.since, ctx.taskId),
  };
}

export function registerDebriefCommand(program: Command): void {
  program
    .command('debrief')
    .description('End-of-day collaboration post-mortem over structured DB evidence.')
    .option('--hours <n>', 'Window size in hours', String(DEFAULT_HOURS))
    .option('--task <id>', 'Narrow the timeline section to a specific task thread')
    .option('--json', 'Emit structured section payloads as JSON')
    .action(async (opts: { hours: string; task?: string; json?: boolean }) => {
      const settings = loadSettings();
      await withStorage(settings, (storage) => {
        const ctx: DebriefContext = {
          storage,
          since: Date.now() - Number(opts.hours) * 3_600_000,
          taskId: opts.task ? Number(opts.task) : undefined,
        };
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(debriefJson(ctx), null, 2)}\n`);
          return;
        }
        const sections = [
          sectionToolUsage(ctx),
          sectionAutoJoin(ctx),
          sectionClaimCoverage(ctx),
          sectionHandoffs(ctx),
          sectionToolDistribution(ctx),
          sectionCoordinationRatio(ctx),
          sectionTimeline(ctx),
          sectionBashCoordinationVolume(ctx),
        ];
        for (const s of sections) process.stdout.write(`${s.join('\n')}\n`);

        // Hard-coded reflection prompts — the debrief's point is to pick
        // one concrete next thing, not to admire the data.
        process.stdout.write(`\n${kleur.bold('Next-action prompts:')}\n`);
        process.stdout.write('  • Was collaboration meaningfully better than no-hivemind?\n');
        process.stdout.write(
          '  • Which failures were missing-tool vs. tool-not-called vs. structural?\n',
        );
        process.stdout.write('  • What was the most valuable moment the system created?\n');
      });
    });
}

function formatRatio(ratio: number | null): string {
  return ratio === null ? 'n/a' : ratio.toFixed(2);
}

function formatPercentRatio(ratio: number | null): string {
  return ratio === null ? 'n/a' : `${Math.round(ratio * 100)}%`;
}

function formatKindCounts(rows: ClaimCoverageStats['explicit_claim_kinds']): string {
  return rows.map((row) => `${row.kind}=${row.count}`).join(', ');
}

function colorClaimCoverageVerdict(verdict: ClaimCoverageVerdict): string {
  if (verdict === 'safety net carrying load — expected') return kleur.green(verdict);
  if (verdict === 'hook integration broken — investigate') return kleur.red(verdict);
  if (verdict === 'explicit claiming present — auto-claim supporting') {
    return kleur.green(verdict);
  }
  if (verdict === 'mixed claim coverage — monitor') return kleur.yellow(verdict);
  return kleur.dim('n/a');
}

function colorRatioVerdict(verdict: CoordinationRatioPayload['verdict']): string {
  if (verdict === 'healthy') return kleur.green('healthy');
  if (verdict === 'mixed') return kleur.yellow('mixed');
  if (verdict === 'reading without committing') return kleur.red('reading without committing');
  return kleur.dim('n/a');
}

function ratioExplanation(payload: CoordinationRatioPayload): string {
  if (payload.commits === 0 && payload.reads > 0) {
    return 'agents reading colony without commits; primitives invisible';
  }
  if (payload.reads === 0) return 'no coordination reads recorded';
  const readsPerCommit =
    payload.commits > 0 ? Math.max(1, Math.round(payload.reads / payload.commits)) : 0;
  const suffix =
    payload.ratio !== null && payload.ratio < COMMIT_RATIO_MIXED ? '; primitives invisible' : '';
  return `agents reading colony ${readsPerCommit}x for every commit${suffix}`;
}

function toolExamples(tools: string[]): string {
  return `${tools.join(', ')}, ...`;
}

function coordinationSessionLabel(session: CoordinationRatioPayload['sessions'][number]): string {
  if (session.session_id.includes('@')) return shortSession(session.session_id);
  return `${session.ide}@${shortSession(session.session_id)}`;
}

function shortSession(sessionId: string): string {
  const parts = sessionId.includes('@') ? sessionId.split('@', 2) : ['', sessionId];
  const agent = parts[0] ?? '';
  const id = parts[1] ?? sessionId;
  const short = id.length > 6 ? `${id.slice(0, 6)}...` : id;
  return agent ? `${agent}@${short}` : short;
}
