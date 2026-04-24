import { join } from 'node:path';
import { loadSettings, resolveDataDir } from '@colony/config';
import { Storage } from '@colony/storage';
import type { Command } from 'commander';
import kleur from 'kleur';

/**
 * Default window: last 24h. The "ran it today" common case. Overridable
 * with --hours for zoomed-in post-mortems or multi-day sweeps.
 */
const DEFAULT_HOURS = 24;

interface DebriefContext {
  storage: Storage;
  since: number;
  taskId?: number | undefined;
}

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
 * Section 5 — interleaved timeline.
 *
 * No analysis, just chronology. Observer notes are colored magenta so
 * you can scan for moments where your note sits next to an agent event —
 * those are the coordination failures the numeric sections can't surface.
 */
function sectionTimeline(ctx: DebriefContext): string[] {
  const lines = ['', kleur.bold('5. Timeline (observer notes interleaved with agent activity)')];
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

export function registerDebriefCommand(program: Command): void {
  program
    .command('debrief')
    .description('End-of-day collaboration post-mortem: 5 structured sections over DB evidence.')
    .option('--hours <n>', 'Window size in hours', String(DEFAULT_HOURS))
    .option('--task <id>', 'Narrow the timeline section to a specific task thread')
    .action((opts: { hours: string; task?: string }) => {
      const settings = loadSettings();
      const dbPath = join(resolveDataDir(settings.dataDir), 'data.db');
      const storage = new Storage(dbPath);
      try {
        const ctx: DebriefContext = {
          storage,
          since: Date.now() - Number(opts.hours) * 3_600_000,
          taskId: opts.task ? Number(opts.task) : undefined,
        };
        const sections = [
          sectionToolUsage(ctx),
          sectionAutoJoin(ctx),
          sectionProactiveClaims(ctx),
          sectionHandoffs(ctx),
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
      } finally {
        storage.close();
      }
    });
}
