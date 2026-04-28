import { loadSettings } from '@colony/config';
import { buildAttentionInbox, inferIdeFromSessionId } from '@colony/core';
import type { Command } from 'commander';
import kleur from 'kleur';
import { withStore } from '../util/store.js';

function sessionFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (
    env.CODEX_SESSION_ID?.trim() ||
    env.CLAUDECODE_SESSION_ID?.trim() ||
    env.CLAUDE_SESSION_ID?.trim() ||
    undefined
  );
}

function agentFromSession(sessionId: string): string | undefined {
  const ide = inferIdeFromSessionId(sessionId);
  if (ide === 'claude-code') return 'claude';
  return ide;
}

export function registerInboxCommand(program: Command): void {
  program
    .command('inbox')
    .description(
      'Compact list of attention items for a session: pending handoffs, wakes, stalled lanes, recent claims, hot files',
    )
    .option(
      '--session <id>',
      'your session_id (defaults to CODEX_SESSION_ID/CLAUDECODE_SESSION_ID)',
    )
    .option(
      '--agent <name>',
      'your agent name (e.g. claude, codex); inferred from session when omitted',
    )
    .option('--repo-root <path>', 'repo root to scan for stalled lanes')
    .option('--json', 'emit the full inbox as JSON')
    .action(
      async (opts: { session?: string; agent?: string; repoRoot?: string; json?: boolean }) => {
        const session = opts.session?.trim() || sessionFromEnv();
        if (!session) {
          process.stderr.write(
            `${kleur.red('missing session')} — pass --session or set CODEX_SESSION_ID/CLAUDECODE_SESSION_ID\n`,
          );
          process.exitCode = 1;
          return;
        }
        const agent = opts.agent?.trim() || agentFromSession(session);
        if (!agent) {
          process.stderr.write(
            `${kleur.red('missing agent')} — pass --agent or use a session id prefixed with codex@/claude@\n`,
          );
          process.exitCode = 1;
          return;
        }
        const settings = loadSettings();
        await withStore(settings, (store) => {
          const inbox = buildAttentionInbox(store, {
            session_id: session,
            agent,
            file_heat_half_life_ms: settings.fileHeatHalfLifeMinutes * 60_000,
            ...(opts.repoRoot !== undefined ? { repo_root: opts.repoRoot } : {}),
          });

          if (opts.json) {
            process.stdout.write(`${JSON.stringify(inbox, null, 2)}\n`);
            return;
          }

          const lines: string[] = [];
          lines.push(
            kleur.bold(`Inbox for ${agent}@${session.slice(0, 8)} — ${inbox.summary.next_action}`),
          );
          lines.push(
            `  messages: ${inbox.summary.unread_message_count}  handoffs: ${inbox.summary.pending_handoff_count}  wakes: ${inbox.summary.pending_wake_count}  stalled lanes: ${inbox.summary.stalled_lane_count}  active claims: ${inbox.summary.recent_other_claim_count}  stale claims: ${inbox.summary.stale_other_claim_count}  expired/weak: ${inbox.summary.expired_other_claim_count}  hot files: ${inbox.summary.hot_file_count}`,
          );

          const blockingMessages = inbox.unread_messages.filter((m) => m.urgency === 'blocking');
          const needsReplyMessages = inbox.unread_messages.filter(
            (m) => m.urgency === 'needs_reply',
          );
          const fyiMessages = inbox.unread_messages.filter((m) => m.urgency === 'fyi');
          if (blockingMessages.length > 0 || needsReplyMessages.length > 0) {
            lines.push('');
            lines.push(kleur.red('Unread messages:'));
            for (const m of [...blockingMessages, ...needsReplyMessages]) {
              lines.push(`  #${m.id} task ${m.task_id} from ${m.from_agent} [${m.urgency}]`);
              lines.push(`    ${m.preview.replace(/\s+/g, ' ').trim()}`);
              lines.push(
                `    reply: task_message(task_id=${m.task_id}, session_id="${session}", agent="${agent}", to_agent="any", to_session_id="${m.from_session_id}", reply_to=${m.id}, urgency="fyi", content="...")`,
              );
            }
          }
          if (fyiMessages.length > 0) {
            lines.push(
              `  FYI messages: ${fyiMessages.length} unread collapsed; use --json to expand`,
            );
          }

          if (inbox.pending_handoffs.length > 0) {
            lines.push('');
            lines.push(kleur.cyan('Pending handoffs:'));
            for (const h of inbox.pending_handoffs) {
              const mins = Math.max(0, Math.round((h.expires_at - inbox.generated_at) / 60_000));
              lines.push(
                `  #${h.id} task ${h.task_id} from ${h.from_agent} (${mins}m left): ${h.summary}`,
              );
              lines.push(
                `    accept: task_accept_handoff(handoff_observation_id=${h.id}, session_id="${session}")`,
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
                `    respond: task_message(task_id=${w.task_id}, session_id="${session}", agent="${agent}", to_agent="any", to_session_id="${w.from_session_id}", urgency="fyi", content="...")`,
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
                `  task ${c.task_id}  ${c.file_path}  by ${c.by_session_id.slice(0, 8)}  ${c.age_class}/${c.ownership_strength}  ${c.age_minutes}m`,
              );
            }
          }
          if (inbox.file_heat.length > 0) {
            lines.push('');
            lines.push(kleur.gray('Hot files:'));
            for (const file of inbox.file_heat) {
              lines.push(
                `  task ${file.task_id}  ${file.file_path}  heat ${file.heat.toFixed(3)}  events ${file.event_count}`,
              );
            }
          }

          process.stdout.write(`${lines.join('\n')}\n`);
        });
      },
    );
}
