# Bump Colony CLI release for npm publish

Plan slug: `bump-colony-cli-patch-release-for-npm-pu`

## Problem

Prepare @imdeadpool/colony-cli for the next unpublished npm release with matching release notes so the maintainer can publish.

## Acceptance Criteria

- @imdeadpool/colony-cli version is bumped to the next Changesets-computed version above npm latest.
- Release notes/changelog describe the publishable package change for that version.
- Package artifacts are dry-run verified for npm publish readiness.
- Changes are committed on an agent branch with PR-ready evidence.

## Roles

- [planner](./planner.md)
- [architect](./architect.md)
- [critic](./critic.md)
- [executor](./executor.md)
- [writer](./writer.md)
- [verifier](./verifier.md)

## Operator Flow

1. Refine this workspace until scope, risks, and tasks are explicit.
2. Publish the plan with `colony plan publish bump-colony-cli-patch-release-for-npm-pu` or the `task_plan_publish` MCP tool.
3. Claim subtasks through Colony plan tools before editing files.
4. Close only when all subtasks are complete and `checkpoints.md` records final evidence.
