---
base_root_hash: 3bfe1540
slug: repo-without-spec-plan-publish-fallback
---

# CHANGE · repo-without-spec-plan-publish-fallback

## §P  proposal
# Allow plan publication for repos without Colony SPEC.md

## Problem

Colony ready-task guard stranded multiple recodee static prompt lanes because task_plan_publish and queen_plan_goal fail hard when target repo root lacks SPEC.md. Operators need live Colony plans to be publishable for coordination even when a product repo has OpenSpec but no Colony SPEC.md.

## Acceptance criteria

- task_plan_publish can publish claimable work for a repo root that lacks SPEC.md, or returns a repairable result that preserves ready-task flow without marking static prompts done.
- queen_plan_goal follows the same behavior and does not strand agents behind OBSERVATION_NOT_ON_TASK for missing SPEC.md alone.
- Existing spec-backed behavior remains intact for repos that do have SPEC.md.
- Focused MCP server tests cover no-SPEC repo publication and ready queue claimability.
- Task #3 records the fix and the PH12 Agent 84 plan can be published/claimed after the Colony repair is available or an exact reload/retry step is recorded.

## Sub-tasks

### Sub-task 0: Patch and test no-SPEC plan publication

Inspect MCP plan/queen/spec handling and patch the narrow behavior that turns missing target repo SPEC.md into a hard OBSERVATION_NOT_ON_TASK failure during live plan publication. Add focused tests for task_plan_publish and queen_plan_goal without SPEC.md while preserving existing spec-backed behavior.

File scope: apps/mcp-server/src/tools/plan.ts, apps/mcp-server/src/tools/queen.ts, apps/mcp-server/src/tools/spec.ts, apps/mcp-server/test/plan.test.ts, apps/mcp-server/test/queen.test.ts, apps/mcp-server/test/ready-queue.test.ts, packages/core/src

### Sub-task 1: Record task #3 recovery evidence (depends on: 0)

Post evidence on recodee task #3 and republish/claim the PH12 Agent 84 live plan if the running Colony MCP server sees the fix. If the live server is not reloaded, record exact reload/retry next step.

File scope: openspec/changes, SPEC.md


## §S  delta
op|target|row
-|-|-

## §T  tasks
id|status|task|cites
-|-|-|-

## §B  bugs
id|status|task|cites
-|-|-|-
