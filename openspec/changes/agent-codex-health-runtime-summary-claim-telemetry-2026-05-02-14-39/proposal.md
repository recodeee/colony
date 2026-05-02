# Runtime summary claim telemetry join

## Problem

`colony health` can see a fresh OMX runtime summary and recent edit paths, but claim-before-edit health still reads only storage-backed PreToolUse/PostToolUse rows. When the runtime summary is the only fresh lifecycle surface, health reports missing lifecycle telemetry even though the bridge is available.

## Change

- Parse lifecycle PreToolUse/PostToolUse event metadata from fresh runtime summaries.
- Join ordered PreToolUse-before-PostToolUse evidence into claim-before-edit measurement.
- Diagnose fresh summaries with edit paths but no lifecycle event join as `lifecycle_summary_not_joined`.

## Verification

- `pnpm --filter @imdeadpool/colony-cli test -- health health-next-fixes`
- `pnpm --filter @colony/core test -- omx-runtime-summary`
- `pnpm --filter @colony/hooks test -- codex-omx-pretool`
- `pnpm smoke:codex-omx-pretool`
- `node apps/cli/dist/index.js health --hours 1 --repo-root /home/deadpool/Documents/recodee/colony --json | jq '.omx_runtime_bridge.status, .omx_runtime_bridge.claim_before_edit, .task_claim_file_before_edits'`
