---
slug: bridge-replay-subcommand-2026-05-16
---

# CHANGE · bridge-replay-subcommand-2026-05-16

## §P  proposal

# Promote `colony bridge lifecycle --replay` to first-class `bridge replay` subcommand

## Problem

`colony bridge lifecycle --replay <file>` reads a saved `.pre.json` envelope and
silently writes it to the live SQLite store unless the operator also remembers
`--dry-run`. This is the wrong default for an offline debugging tool: replay is
something you reach for *because* you are investigating, not while normal
hooks are firing. README's v0.x roadmap line `⏳ Bridge replay tool for
offline debugging from a saved .pre.json` tracks the gap.

## What changes

- New `colony bridge replay <file>` subcommand alongside the existing
  `bridge lifecycle` command.
- Default behavior is dry-run: route through an ephemeral SQLite database, do
  not touch the live store.
- `--apply` opts in to writing against the live store and prints a
  `applying to live store` banner to stderr (pretty mode only).
- `--rewrite-root <from>=<to>` rewrites absolute path prefixes in the envelope
  before dispatch, so captures taken on another machine (`/workspace/colony`)
  can be replayed locally (`/tmp/repo`). Repeatable.
- `--json` output extends the existing `OmxLifecycleRunResult` with
  `replay: true`, `applied: <boolean>`, and `input_path: <abs-path>` keys.
- Pretty output adds ` replay=true applied=<bool>` to the one-line summary.
- Existing `bridge lifecycle --replay` keeps working (no removal); the new
  subcommand is the recommended path.
- `apps/cli/bin/colony.sh` requires no change: its fast-path only matches
  `bridge lifecycle`, so `bridge replay` falls through to Node naturally.
  Pinned by a new `bin-shim.test.ts` case.

## Impact

- **Surfaces touched.** `apps/cli/src/commands/bridge.ts`,
  `apps/cli/test/bridge-replay.test.ts` (new),
  `apps/cli/test/bin-shim.test.ts`.
- **Backward compatibility.** Additive. `bridge lifecycle --replay` and
  `--dry-run` flags continue to work unchanged.
- **Fixtures.** Reuses `packages/contracts/fixtures/colony-omx-lifecycle-v1/`.
  No new fixtures.
- **Risk.** Low. Same write path (`runOmxLifecycleEnvelope`), same store
  injection seam, same cleanup. Default flips from "writes to live store" to
  "dry-run" — that is the footgun this fixes.

## §S  delta
op|target|row
-|-|-

## §T  tasks
id|status|task|cites
-|-|-|-

## §B  bugs
id|status|task|cites
-|-|-|-
