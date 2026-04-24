import { join } from 'node:path';
import { loadSettings, resolveDataDir } from '@colony/config';
import { Storage } from '@colony/storage';
import type { Command } from 'commander';
import kleur from 'kleur';

/**
 * Refresh cadence. Three seconds is a compromise: fast enough that new
 * claims show up while you're still looking at the screen, slow enough
 * that the redraw flicker isn't distracting in peripheral vision.
 */
const REFRESH_MS = 3000;

/**
 * "Recent" window for the unclaimed-edits diagnostic. Five minutes
 * matches the conflict-warning window used by `UserPromptSubmit` —
 * keeping them aligned makes the mental math on both tools align.
 */
const RECENT_WINDOW_MS = 5 * 60_000;

function fmtAgo(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

/**
 * Paint one frame. Extracted so the setInterval loop stays one line
 * and so the renderer is easy to invoke from a future snapshot test.
 */
function renderFrame(storage: Storage): string {
  const lines: string[] = [];
  const now = new Date().toISOString().slice(11, 19);
  lines.push(`${kleur.bold('colony observe')}  ${kleur.dim(now)}`);
  lines.push(kleur.dim('─'.repeat(60)));

  const tasks = storage.listTasks(5);
  if (tasks.length === 0) {
    lines.push(kleur.dim('No tasks yet. Start a session in a git repo to auto-create one.'));
    return lines.join('\n');
  }

  for (const task of tasks) {
    lines.push('');
    lines.push(
      `${kleur.cyan(`task #${task.id}`)} ${kleur.bold(task.branch)}  ${kleur.dim(task.repo_root)}`,
    );

    const participants = storage.listParticipants(task.id);
    const participantLine = participants
      .map((p) => `${p.agent} (${fmtAgo(p.joined_at)})`)
      .join(', ');
    lines.push(`  ${kleur.dim('participants:')} ${participantLine || 'none'}`);

    const claims = storage.recentClaims(task.id, Date.now() - RECENT_WINDOW_MS);
    if (claims.length > 0) {
      lines.push(`  ${kleur.dim('claims:')}`);
      for (const c of claims) {
        lines.push(
          `    ${c.file_path.padEnd(40)} ${kleur.yellow(c.session_id.padEnd(10))} ${fmtAgo(c.claimed_at)}`,
        );
      }
    }

    const pending = storage.pendingHandoffs(task.id);
    if (pending.length > 0) {
      lines.push(`  ${kleur.dim('pending handoffs:')}`);
      for (const h of pending) {
        const meta = safeJson(h.metadata) as {
          from_agent?: string;
          to_agent?: string;
          summary?: string;
        };
        const summary = (meta.summary ?? '').slice(0, 50);
        lines.push(`    #${h.id} ${meta.from_agent ?? '?'} → ${meta.to_agent ?? '?'}: ${summary}`);
      }
    }

    const recent = storage.taskTimeline(task.id, 6);
    if (recent.length > 0) {
      lines.push(`  ${kleur.dim('recent:')}`);
      // taskTimeline is DESC — reverse so the most recent line is last,
      // matching "read top-down as a chronological stream".
      for (const r of [...recent].reverse()) {
        const ts = new Date(r.ts).toISOString().slice(11, 19);
        const kindColor = r.kind === 'observer-note' ? kleur.magenta : kleur.cyan;
        lines.push(
          `    ${kleur.dim(ts)}  ${kindColor(r.kind.padEnd(15))} ${r.content.slice(0, 48)}`,
        );
      }
    }
  }

  // Diagnostic footer — the single most valuable piece of the dashboard,
  // placed last where it doesn't scroll off. Only counts edits that lack
  // an explicit `claim`-kind observation; the auto-claim side effect is
  // deliberately not credited here, because the point of this diagnostic
  // is to measure *proactive* behaviour.
  lines.push('');
  const unclaimed = storage.recentEditsWithoutClaims(Date.now() - RECENT_WINDOW_MS);
  if (unclaimed.length === 0) {
    lines.push(kleur.green('edits without proactive claims (last 5m): none'));
  } else {
    lines.push(kleur.yellow(`edits without proactive claims (last 5m): ${unclaimed.length}`));
    for (const e of unclaimed.slice(0, 10)) {
      lines.push(`  ${e.file_path}  ${kleur.dim(`(${e.session_id}, ${fmtAgo(e.ts)})`)}`);
    }
  }

  return lines.join('\n');
}

function safeJson(s: string | null): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function registerObserveCommand(program: Command): void {
  program
    .command('observe')
    .description('Live dashboard of collaboration state. Run in a spare terminal during a session.')
    .option('--interval <ms>', 'Refresh interval in milliseconds', String(REFRESH_MS))
    .action((opts: { interval: string }) => {
      const settings = loadSettings();
      const dbPath = join(resolveDataDir(settings.dataDir), 'data.db');
      const storage = new Storage(dbPath);
      const intervalMs = Math.max(500, Number(opts.interval));

      // \x1b[2J clears the screen; \x1b[H sends the cursor home. Minimal
      // cross-platform approach — avoids heavyweight `blessed`/`ink` deps
      // for what is ultimately a glorified printf loop.
      const paint = () => {
        process.stdout.write('\x1b[2J\x1b[H');
        process.stdout.write(renderFrame(storage));
        process.stdout.write(`\n\n${kleur.dim(`refresh ${intervalMs}ms · ctrl-c to exit`)}\n`);
      };

      paint();
      const handle = setInterval(paint, intervalMs);

      const stop = () => {
        clearInterval(handle);
        storage.close();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
}
