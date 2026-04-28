# Tasks

## 1. Inspect Current Hivemind Context

- [x] Inspect `hivemind_context` MCP registration and payload shaping.
- [x] Inspect core lane discovery, file-lock previews, and attention inbox task
      scoping.
- [x] Inspect existing MCP tests for compact memory and hydration behavior.

## 2. Compact Local Defaults

- [x] Scope explicit `repo_root` reads so env roots do not turn the result into
      a global dashboard.
- [x] Default `hivemind_context` lanes to a compact repo-local limit.
- [x] Keep compact default limits for memory hits, claims, hot files, and
      attention observation IDs.
- [x] Add compact ownership and hot-file summaries without observation bodies.
- [x] Add current-session attention counts and observation IDs for hydration.

## 3. Verification

- [x] Run targeted core and MCP tests.
- [x] Run typecheck or the narrowest available compile check for touched
      packages.
- [x] Run OpenSpec validation.

## 4. Completion

- [x] Commit, push, PR, merge.
      Evidence: PR https://github.com/recodeee/colony/pull/157 is `MERGED`;
      merge commit `b9065d24119823fcc89c49bc556325af34c2d07a`.
- [x] Record final `MERGED` evidence and sandbox cleanup.
      Evidence: `gx cleanup --base main` pruned
      `.omx/agent-worktrees/colony__agent-12__compact-hivemind-context-2026-04-28-21-55`;
      `git merge-base --is-ancestor b9065d24119823fcc89c49bc556325af34c2d07a HEAD`
      passed on `main`.
