# Tasks

- [x] Inspect lifecycle envelope, PreToolUse, PostToolUse, storage, and claim-path flows.
- [x] Normalize Codex/OMX `file_path`, `path`, `paths[].path`, and patch-derived edit targets.
- [x] Persist pathless PreToolUse mutation envelopes as warning `claim-before-edit` telemetry.
- [x] Persist PostToolUse extracted paths and warning metadata on `tool_use` observations.
- [x] Skip pseudo paths, directories, and known out-of-repo absolute paths.
- [x] Extend smoke and path normalization tests for Write, MultiEdit, apply_patch/Patch, absolute paths, and repo-relative paths.
- [x] Run focused verification:
  - `pnpm --filter @colony/hooks test -- lifecycle-envelope codex-omx-pretool`
  - `pnpm --filter @colony/storage test -- claim-path coordination-activity`
- [ ] Finish PR, merge, and sandbox cleanup; record PR URL and `MERGED` evidence.
