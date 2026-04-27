import { spawn } from 'node:child_process';

export type NotifyLevel = 'info' | 'warn' | 'error';

export interface NotifyMessage {
  level: NotifyLevel;
  title: string;
  body: string;
}

export interface NotifyOptions {
  /** 'desktop' fans out to the platform-native facility (osascript /
   *  notify-send). 'none' is a no-op. Anything else is treated as
   *  'none' for forward compatibility. */
  provider: 'desktop' | 'none';
  /** Drop messages below this level. Defaults to 'warn'. */
  minLevel?: NotifyLevel;
  /** Optional logger for diagnostic output (e.g. spawn failures). */
  log?: (line: string) => void;
}

const LEVEL_ORDER: Record<NotifyLevel, number> = { info: 0, warn: 1, error: 2 };

/**
 * Fire-and-forget desktop notification. Returns immediately — never awaits the
 * spawned helper, never throws, and never blocks a hot path. Designed so
 * callers can sprinkle `notify()` next to a structured-stderr log line
 * without thinking about the cost.
 *
 * Platform mapping:
 *   - darwin: `osascript -e 'display notification "body" with title "title"'`
 *   - linux:  `notify-send -u <urgency> <title> <body>`
 *   - other:  no-op (no portable system tray worth depending on)
 *
 * Spawn errors are swallowed but reported via `opts.log` so a missing
 * `notify-send` on a headless box doesn't degrade into a crash loop.
 */
export function notify(msg: NotifyMessage, opts: NotifyOptions): void {
  if (opts.provider !== 'desktop') return;
  const minLevel = opts.minLevel ?? 'warn';
  if (LEVEL_ORDER[msg.level] < LEVEL_ORDER[minLevel]) return;

  const argv = buildNotifyArgv(msg);
  if (!argv) return;
  const cmd = argv[0];
  if (cmd === undefined) return;

  try {
    const child = spawn(cmd, argv.slice(1), { stdio: 'ignore', detached: false });
    child.on('error', (err: Error) => {
      opts.log?.(`[colony notify] spawn error: ${err.message}`);
    });
  } catch (err) {
    opts.log?.(`[colony notify] failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function buildNotifyArgv(msg: NotifyMessage): string[] | null {
  const title = sanitize(msg.title);
  const body = sanitize(msg.body);
  if (process.platform === 'darwin') {
    const script = `display notification "${body}" with title "${title}"`;
    return ['osascript', '-e', script];
  }
  if (process.platform === 'linux') {
    const urgency = msg.level === 'error' ? 'critical' : msg.level === 'warn' ? 'normal' : 'low';
    return ['notify-send', '-u', urgency, title, body];
  }
  return null;
}

/**
 * Drop control chars and shell-sensitive quoting before the title/body hit
 * argv. Notifications are diagnostic, not data — we'd rather lose a stray
 * quote than risk a malformed osascript call.
 */
function sanitize(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) {
      out += ' ';
      continue;
    }
    if (ch === '"' || ch === '\\') continue;
    out += ch;
  }
  return out;
}
