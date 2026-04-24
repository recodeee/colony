import { join } from 'node:path';
import { loadSettings, resolveDataDir } from '@colony/config';
import { MemoryStore, buildAttentionInbox } from '@colony/core';
import type { Command } from 'commander';
import kleur from 'kleur';

export function registerInboxCommand(program: Command): void {
  program
    .command('inbox')
    .description('Compact list of attention items for a session: pending handoffs, wakes, stalled lanes, recent claims')
    .requiredOption('--session <id>', 'your session_id')
    .requiredOption('--agent <name>', 'your agent name (e.g. claude, codex)')
    .option('--repo-root <path>', 'repo root to scan for stalled lanes')
    .option('--json', 'emit the full inbox as JSON')
    .action(async (opts: { session: string; agent: string; repoRoot?: string; json?: boolean }) => {
      const settings = loadSettings();
      const dbPath = join(resolveDataDir(settings.dataDir), 'data.db');
      const store = new MemoryStore({ dbPath, settings });
      try {
        const inbox = buildAttentionInbox(store, {
          session_id: opts.session,
          agent: opts.agent,
          ...(opts.repoRoot !== undefined ? { repo_root: opts.repoRoot } : {}),
        });

        if (opts.json) {
          process.stdout.write(`${JSON.stringify(inbox, null, 2)}\n`);
          return;
        }

        const lines: string[] = [];
        lines.push(
          kleur.bold(
            `Inbox for ${opts.agent}@${opts.session.slice(0, 8)} — ${inbox.summary.next_action}`,
          ),
        );
        lines.push(
          `  handoffs: ${inbox.summary.pending_handoff_count}  wakes: ${inbox.summary.pending_wake_count}  stalled lanes: ${inbox.summary.stalled_lane_count}  recent other claims: ${inbox.summary.recent_other_claim_count}`,
        );

        if (inbox.pending_handoffs.length > 0) {
          lines.push('');
          lines.push(kleur.cyan('Pending handoffs:'));
          for (const h of inbox.pending_handoffs) {
            const mins = Math.max(0, Math.round((h.expires_at - inbox.generated_at) / 60_000));
            lines.push(
              `  #${h.id} task ${h.task_id} from ${h.from_agent} (${mins}m left): ${h.summary}`,
            );
            lines.push(
              `    accept: task_accept_handoff(handoff_observation_id=${h.id}, session_id="${opts.session}")`,
            );
          }
        }
        if (inbox.pending_wakes.length > 0) {
          lines.push('');
          lines.push(kleur.yellow('Pending wakes:'));
          for (const w of inbox.pending_wakes) {
            const mins = Math.max(0, Math.round((w.expires_at - inbox.generated_at) / 60_000));
            lines.push(
              `  #${w.id} task ${w.task_id} from ${w.from_agent} (${mins}m left): ${w.reason}`,
            );
            if (w.next_step) lines.push(`    next: ${w.next_step}`);
            lines.push(
              `    ack: task_ack_wake(wake_observation_id=${w.id}, session_id="${opts.session}")`,
            );
          }
        }
        if (inbox.stalled_lanes.length > 0) {
          lines.push('');
          lines.push(kleur.magenta('Stalled lanes:'));
          for (const lane of inbox.stalled_lanes) {
            lines.push(
              `  ${lane.branch} [${lane.activity}] ${lane.owner}: ${lane.activity_summary}`,
            );
          }
        }
        if (inbox.recent_other_claims.length > 0) {
          lines.push('');
          lines.push(kleur.gray('Recent other-session claims:'));
          for (const c of inbox.recent_other_claims) {
            lines.push(
              `  task ${c.task_id}  ${c.file_path}  by ${c.by_session_id.slice(0, 8)}`,
            );
          }
        }

        process.stdout.write(`${lines.join('\n')}\n`);
      } finally {
        store.close();
      }
    });
}
