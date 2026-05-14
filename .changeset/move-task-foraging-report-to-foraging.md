---
'@colony/mcp-server': patch
---

Move `task_foraging_report` source location from `attention.ts` to `foraging.ts`

The tool is part of the foraging surface (it wraps `ProposalSystem.foragingReport`
and is conceptually paired with `examples_list` / `examples_query`), not the
attention-inbox surface. It only lived in `attention.ts` as an accident of the
pre-split monolithic `server.ts`.

Pure code-location refactor. The MCP tool name, description, input schema, and
handler body are byte-identical. `server.ts` registers it at the same call-site
slot via a new `registerTaskForagingReport` named export, so the `listTools`
ordering observed by inspectors stays unchanged.
