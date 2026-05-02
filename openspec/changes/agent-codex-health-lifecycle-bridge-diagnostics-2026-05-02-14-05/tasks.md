# Tasks

- [x] Inspect health payload, formatter, storage counters, and README Health docs.
- [x] Add source-level lifecycle bridge root-cause kinds and structured evidence counters.
- [x] Preserve bridge > quota relay > Queen activation next-fix priority.
- [x] Add fixtures for available-but-silent bridge telemetry with `task_claim_file_calls=492`, `hook_capable_edits=0`, and `pre_tool_use_signals=0`.
- [x] Add focused coverage for unavailable bridge, missing file paths, claim mismatch, and no hook-capable edits.
- [x] Update README Health docs for JSON root causes and install/verify commands.
- [x] Run requested verification:
  - `pnpm --filter @imdeadpool/colony-cli test -- health-next-fixes`
  - `pnpm --filter @imdeadpool/colony-cli test -- health`
  - `pnpm --filter @imdeadpool/colony-cli typecheck`

## Cleanup

- [ ] Finish PR, merge, and sandbox cleanup; record PR URL and `MERGED` evidence.

Evidence:
- Targeted verification passed locally after rebuilding the local `better-sqlite3` native binding generated under `node_modules`.
