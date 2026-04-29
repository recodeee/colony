---
base_root_hash: 3bfe1540
slug: finish-colony-execution-safety-loop
---

# CHANGE · finish-colony-execution-safety-loop

## §P  proposal
# Finish Colony execution-safety loop

## Problem

Coordination adoption is green, but claim-before-edit diagnostics and Queen plan execution are red. Health must explain why task_claim_file calls do not count before edits, and active plan work must become claimable through task_ready_for_agent.

## Acceptance criteria

- claim/edit correlation diagnostics explain why task_claim_file calls do not count before edits.
- active plan exists with claimable subtasks.
- task_ready_for_agent returns task_plan_claim_subtask args for ready work.
- task_plan_claim_subtask is used for the active execution-safety lane.
- targeted tests cover claim miss diagnostics, path normalization, fallback matching, bridge signal distinctions, and Queen readiness.

## Sub-tasks

### Sub-task 0: Claim/edit correlation diagnostics

Explain why task_claim_file calls fail to count before edits, with miss reason buckets and JSON/text health output.

File scope: packages/storage/src/storage.ts, packages/storage/src/types.ts, apps/cli/src/commands/health.ts, packages/storage/test/coordination-activity.test.ts, apps/cli/test/health.test.ts

### Sub-task 1: Path normalization parity

Normalize claim and edit file paths through one shared storage helper, including absolute, relative, worktree, dot-prefix, and pseudo-path cases.

File scope: packages/storage/src/claim-path.ts, packages/storage/src/index.ts, packages/core/src/index.ts, packages/core/src/task-thread.ts, packages/hooks/src/auto-claim.ts, packages/storage/test/tasks.test.ts, packages/hooks/test/auto-claim.test.ts

### Sub-task 2: Session and lane fallback matching

Count health coverage when a prior claim matches repo/branch/file or worktree/file within the window even if session ids differ, while keeping exact-session match source visible.

File scope: packages/storage/src/storage.ts, packages/storage/src/types.ts, packages/storage/test/coordination-activity.test.ts, apps/cli/src/commands/health.ts, apps/cli/test/health.test.ts

### Sub-task 3: Bridge signal instrumentation (depends on: 0)

Separate native PreToolUse, Codex/OMX bridge, late bridge claims, and missing lifecycle signals in health metrics.

File scope: packages/hooks/src/handlers/pre-tool-use.ts, packages/hooks/src/lifecycle-envelope.ts, packages/hooks/test/lifecycle-envelope.test.ts

### Sub-task 4: Execution-safety health verification (depends on: 0, 1, 2, 3)

Verify active plan readiness, claim miss diagnostics, and health output with targeted CLI/storage tests.

File scope: apps/cli/test/queen-health.test.ts, apps/cli/test/health-next-fixes.test.ts, apps/cli/test/health.test.ts


## §S  delta
op|target|row
-|-|-

## §T  tasks
id|status|task|cites
-|-|-|-

## §B  bugs
id|status|task|cites
-|-|-|-
