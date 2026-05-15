---
'colonyq': minor
---

`colony bridge replay <file.pre.json>` is now a first-class subcommand for
offline debugging of captured pre-tool-use envelopes. Default is `--dry-run`
(ephemeral in-memory SQLite, no side effects); pass `--apply` to write to
the live store. A new `--rewrite-root <from>=<to>` flag rewrites absolute
paths in the envelope before dispatch so captures from another machine can
be replayed locally. Reuses the existing
`packages/contracts/fixtures/colony-omx-lifecycle-v1/` fixtures and does not
require the worker daemon. The shell shim at `apps/cli/bin/colony.sh`
short-circuits only `bridge lifecycle` to the daemon, so `bridge replay`
runs in-process automatically.
