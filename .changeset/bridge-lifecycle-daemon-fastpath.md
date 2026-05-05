---
"@imdeadpool/colony-cli": minor
---

Daemonize `colony bridge lifecycle` to cut hot-path CPU.

Every IDE tool event triggers `colony bridge lifecycle ...` from external hook integrations (oh-my-codex's `ColonyBridge.spawnSync`, Codex/Claude Code settings). Cold-starting Node + JIT + bundle load on each event pegs ~one core for ~300 ms. Multiplied across concurrent agents this is a measurable CPU storm.

The CLI bin entry is now a POSIX shell wrapper at `apps/cli/bin/colony.sh`. When invoked as `colony bridge lifecycle --json`, the wrapper POSTs the envelope to the long-lived worker daemon at `POST /api/bridge/lifecycle` and exits — no Node startup. Anything else (or any failure on the fast path) execs the Node CLI exactly as before.

Rule #10 in CLAUDE.md is reworded to reflect that writes still complete in-process when the daemon is unavailable: the wrapper buffers stdin and falls back to Node on curl missing, connection refused, timeout (~2s), non-200, unknown flags, or invocation without `--json`. The fallback is regression-tested in `apps/cli/test/bin-shim.test.ts`. The daemon path itself is tested in `apps/worker/test/server.test.ts` (`POST /api/bridge/lifecycle` block).

Opt out at any time with `COLONY_BRIDGE_FAST=0`.
