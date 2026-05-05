# Contributing

Colony is a local-first coordination substrate. Contributions should make
agent work easier to observe, claim, hand off, resume, and verify without
turning Colony into a remote control plane.

## Today's contribution flow

1. Start from an isolated `gx` lane:

   ```bash
   gx branch start "<task>" "<agent-name>"
   ```

2. Enter the printed worktree and run the Colony startup loop before editing:

   ```text
   hivemind_context -> attention_inbox -> task_ready_for_agent
   ```

3. Accept or decline pending handoffs. If no plan work is ready, keep the
   change small and record the active task with `task_post` or
   `task_note_working`.

4. Claim every file before mutation:

   ```text
   task_claim_file
   ```

   ```bash
   gx locks claim --branch "<agent/* branch>" <file...>
   ```

5. Make the smallest observable change that solves the problem. Prefer durable
   local traces, explicit receipts, and focused CLI/MCP primitives over central
   orchestration.

6. Run focused verification for the touched behavior. For broad changes, add
   typecheck, lint, tests, and `openspec validate --specs`.

7. Commit, push, and finish through `gx`:

   ```bash
   gx branch finish --branch "<agent/* branch>" --base main --via-pr --wait-for-merge --cleanup
   ```

## Pull request policy

Every PR should be reviewable on its own:

- One problem or behavior change per PR.
- Tests or a clear reason why tests do not apply.
- Documentation updates when commands, workflows, MCP shapes, or user-facing
  behavior change.
- OpenSpec or compact `colony-spec.md` context for behavior changes.
- No new dependency unless the PR explains why existing utilities are not
  enough.
- No hosted service assumption. Colony must remain useful with local SQLite and
  local runtime hooks.
- No hidden agent control. Colony can suggest, route, claim, hand off, and
  record; the runtime still executes the work.

PR descriptions should include:

```md
## Summary
- ...

## Verification
- ...

## Coordination report
- Stale claims:
- Confusing handoffs:
- Missing session context:
- Noisy proposals:
- Stranded sessions:
- Missed hot files:
- Edits before claim:
- Other friction:
```

If nothing felt wrong, write `Coordination friction: none observed`.

## Working on someone else's PR

- Read the PR and the linked Colony task thread before editing.
- Do not reimplement the same fix on a second branch.
- If you take over, record a handoff or takeover note with `branch`, `task`,
  `blocker`, `next`, and `evidence`.
- Claim only the files you will touch.
- Keep review fixes in follow-up commits on the same `agent/*` branch when
  possible.

## Ground rules

- **Respect the invariants in `CLAUDE.md`.** The compression-at-rest contract,
  the `Storage`-only I/O rule, and the progressive-disclosure MCP shape are
  load-bearing.
- **Use Colony on real work.** Report where coordination felt wrong: stale
  claims, confusing handoffs, missing session context, noisy proposals,
  stranded sessions, missed hot files, or edits that should have been claimed
  before mutation.
- **Small PRs.** Prefer a sequence of focused changes over one large one.
- **Conventional Commits.** Use `feat:`, `fix:`, `docs:`, `chore:`,
  `refactor:`, or `test:` when a conventional subject is helpful.

## Running checks

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Use narrower package checks for small changes and report any skipped broader
checks in the PR.

## Adding an IDE integration

1. Implement `Installer` in `packages/installers/src/<ide>.ts`.
2. Register it in `packages/installers/src/registry.ts`.
3. Add a line to the installer table in `README.md`.
4. Add a test in `packages/installers/test/`.

## Adding an MCP tool

1. Register it in `apps/mcp-server/src/server.ts`.
2. Document the contract in `docs/mcp.md`.
3. Add an integration test using `@modelcontextprotocol/inspector`.

## Adding a compression rule

1. Edit `packages/compress/src/lexicon.json`.
2. Add a round-trip fixture in `packages/compress/test/fixtures/`.
3. Run the benchmark in `evals/` and update numbers in `README.md` if the
   aggregate shifted.

## Release

Releases are cut by GitHub Actions on merge to `main` when a changeset file
exists. Do not publish from a local machine.
