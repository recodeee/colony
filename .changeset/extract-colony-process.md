---
'@colony/hooks': patch
'@colony/mcp-server': patch
'@colony/worker': patch
'@imdeadpool/colony': patch
---

Extract shared `isMainEntry`, pidfile helpers, `isAlive`, and the
`spawn(process.execPath, …)` wrapper into a new `@colony/process`
package. These utilities had divergent copies in four places
(`apps/cli/src/commands/lifecycle.ts`, `apps/cli/src/commands/worker.ts`,
`apps/mcp-server/src/server.ts`, `apps/worker/src/server.ts`, and
`packages/hooks/src/auto-spawn.ts`). The regex that decides whether
Node should be invoked via `execPath` — the Windows EFTYPE guard —
and the realpath-normalized bin-shim check both now live exactly once.

No behavior change. Internal helper refactor only.
