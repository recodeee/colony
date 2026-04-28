import { loadSettings } from '@colony/config';
import type { Storage } from '@colony/storage';
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
 * Section 3 — did agents claim proactively?
 *
 * The critical diagnostic. Compares edit-observations (tool_use with a
 * file_path in metadata) against explicit `claim`-kind observations. If
 * claims << edits, proactive claiming is failing → auto-claim's safety
 * net is doing the work, which argues for keeping it even if flaky.
 */
function sectionProactiveClaims(ctx: DebriefContext): string[] {
  const lines = ['', kleur.bold('3. Did agents claim proactively?')];
  const stats = ctx.storage.editVsClaimStats(ctx.since);
  lines.push(`  Edits observed:  ${stats.edit_count}`);
  lines.push(`  Claims recorded: ${stats.claim_count}`);
  const ratio = stats.edit_count > 0 ? Math.round((stats.claim_count / stats.edit_count) * 100) : 0;
  const verdict =
    ratio >= 70
      ? kleur.green('proactive claiming works — auto-claim is a safety net, not the main path')
      : ratio >= 20
        ? kleur.yellow('partial claiming — consider sharpening the preface wording')
        : kleur.red('proactive claiming failing — auto-claim is carrying the load');
  lines.push(`  Claim/edit ratio: ${ratio}%  →  ${verdict}`);
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
  const claimStats = ctx.storage.editVsClaimStats(ctx.since);
  const handoffs = ctx.storage.handoffStatusDistribution(ctx.since);
  const latencies = ctx.storage.handoffAcceptLatencies(ctx.since).sort((a, b) => a - b);
  const toolDistribution = ctx.storage.toolInvocationDistribution(ctx.since, 20);
  return {
    tool_usage: ctx.storage.toolUsageBySession(ctx.since),
    auto_join: {
      sessions_started: sessions.length,
      joined: autoJoin.joined,
      missed: autoJoin.missed_sessions.length,
      missed_sessions: autoJoin.missed_sessions,
    },
    proactive_claims: {
      ...claimStats,
      ratio: claimStats.edit_count > 0 ? claimStats.claim_count / claimStats.edit_count : null,
    },
    handoffs: {
      ...handoffs,
      total: handoffs.accepted + handoffs.cancelled + handoffs.expired + handoffs.pending,
      median_accept_latency_ms:
        latencies.length > 0 ? (latencies[Math.floor(latencies.length / 2)] ?? 0) : null,
    },
    tool_distribution: toolDistribution,
    coordination_ratio: coordinationRatioPayload(ctx),
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
          sectionProactiveClaims(ctx),
          sectionHandoffs(ctx),
          sectionToolDistribution(ctx),
          sectionCoordinationRatio(ctx),
          sectionTimeline(ctx),
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
