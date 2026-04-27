---
"@colony/process": minor
"@colony/config": minor
"@colony/storage": minor
"@colony/core": minor
"@colony/worker": minor
"@colony/mcp-server": minor
---

Smoothness pack: macOS idle-sleep prevention, desktop notifier slot, and
cross-task links.

`@colony/process`:

- New `notify({ level, title, body }, { provider, minLevel, log })` helper.
  `provider: 'desktop'` fans out to `osascript` on darwin / `notify-send` on
  linux; `'none'` is a no-op. Fire-and-forget: never awaits the spawned
  helper, never throws, never blocks a hot path. Spawn failures are reported
  via the optional `log` callback rather than crashing the caller.
- Re-exports `NotifyLevel`, `NotifyMessage`, `NotifyOptions`, plus a
  `buildNotifyArgv` helper for testing.

`@colony/config`:

- New `notify` settings group: `provider: 'desktop' | 'none'` (default
  `'none'` so a fresh install is silent) and `minLevel: 'info' | 'warn' |
  'error'` (default `'warn'`). Picked up automatically by `colony config
  show` and `settingsDocs()`.

`@colony/storage`:

- Schema bumps to v8. New `task_links` table stores cross-task edges as one
  row per unordered pair (`low_id < high_id` enforced via CHECK), with
  `created_by`, `created_at`, and an optional `note`.
- `Storage.linkTasks(p)` is idempotent — re-linking a pair preserves the
  original metadata. `Storage.unlinkTasks(a, b)` returns whether a row was
  removed. `Storage.linkedTasks(task_id)` returns the *other* side of each
  edge with link metadata, regardless of which side originally linked.
- Self-links (`task_id_a === task_id_b`) are rejected as a caller bug.
- New types: `TaskLinkRow`, `NewTaskLink`, `LinkedTask`.

`@colony/core`:

- `TaskThread.linkedTasks()`, `TaskThread.link(other_task_id, created_by,
  note?)`, `TaskThread.unlink(other_task_id)` — symmetric helpers around
  the storage primitives.

`@colony/worker`:

- New `apps/worker/src/caffeinate.ts` holds a `caffeinate -i -w <pid>`
  assertion on darwin while the embed loop is running, so a laptop lid-close
  or system idle doesn't suspend long-running embedding backfills. No-op on
  non-darwin and on missing binary; never started when the embedder failed
  to load (the worker is then just a viewer + state file writer).
- Worker now emits a desktop notification via `@colony/process` when the
  embedder fails to load, so users see a real signal instead of a stderr
  line they may never read. Honours `settings.notify`.

`@colony/mcp-server`:

- New tools: `task_link(task_id, other_task_id, session_id, note?)`,
  `task_unlink(task_id, other_task_id)`, `task_links(task_id)`. Symmetric:
  callers don't need to think about ordering, and re-linking the same pair
  is idempotent.

Inspired by patterns in agent-orchestrator (caffeinate, plugin-style
notifier slot) and hive (worktree connections / cross-task linking).
