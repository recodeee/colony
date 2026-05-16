## Why

- Make Spec-Driven Development (SDD) skills available to Claude sessions running in the colony repo, mirroring the same install just done in recodee.
- Speckit skills (`/speckit-constitution`, `/speckit-specify`, `/speckit-plan`, `/speckit-tasks`, `/speckit-implement`, plus optional `/speckit-clarify`, `/speckit-analyze`, `/speckit-checklist`, and bundled `/speckit-git-*`) give a structured artifact flow alongside colony's existing OpenSpec workflow.

## What Changes

- Add `.specify/` (workflows, templates, scripts, integration manifests, constitution skeleton) — tracked.
- Add 14 `.claude/skills/speckit-*` skill prompt files — tracked (colony's `.claude/` is not gitignored, unlike recodee's symlinked layout).
- Append a 3-line `<!-- SPECKIT START -->` marker to `CLAUDE.md` so spec-kit-aware agents know to read the active plan.
- No source, build, or runtime changes. Pure tooling/skill install.

## Impact

- No production behavior or runtime surface changes.
- New skills become invocable in any Claude session run from the colony root.
- No conflicts with the existing OpenSpec workflow — speckit slash skills sit alongside as an SDD shortcut for change-driven work.
