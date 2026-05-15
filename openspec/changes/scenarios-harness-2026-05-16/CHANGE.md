---
slug: scenarios-harness-2026-05-16
---

# CHANGE · scenarios-harness-2026-05-16

## §P proposal

### Problem

README §v0.x "Multi-runtime confidence" lists "Reproducible test fixture set under `tests/scenarios/`" as the last open item. Today, multi-agent situations (claim-before-edit, cross-runtime handoff, stale-claim sweep, plan claim adoption, pre/post path mismatch) live as ad-hoc smoke tests scattered across `packages/hooks/test/` and `apps/cli/test/`. Each rebuilds its own tempdir + git repo + fake-timer scaffolding inline. Reproducing a regression means hand-porting that scaffolding into a fresh file.

### Proposal

Add a reproducible test-scenarios harness under `tests/scenarios/`. Each scenario is a directory of plaintext artifacts (no binary snapshots):

- `seed.sql` — applied after schema migrations against a fresh tempdir SQLite DB.
- `inputs.jsonl` — one envelope per line: `{kind, at_ms, payload}` where `kind` is `lifecycle | mcp | tick`. Lifecycle flows through the same `runOmxLifecycleEnvelope` that production hooks call.
- `expected.json` — normalized substrate snapshot with subset matchers (`toMatchObject` style), not full-row equality. Paths normalized to `<REPO_ROOT>`.
- Optional `meta.yaml` — runtimes, tags, description.

A shared `_harness/` drives all scenarios via `vi.useFakeTimers` + `vi.setSystemTime(BASE_TS + at_ms)` per envelope so timing is deterministic. Embeddings forced to `provider: none` to remove network. Five canonical scenarios ship in this PR: claim-before-edit, cross-runtime handoff, stale-claim sweep, plan claim adoption, pre/post path mismatch. Two harness self-tests prove the runner fails closed on missing expected and reports a clear diff on mismatch. A separate CI job runs `pnpm scenarios` on Node 20 after `build`, kept out of `pnpm test` so failure attribution stays clean.

### Acceptance criteria

- `pnpm scenarios` runs all five scenarios plus two harness self-tests, all green.
- `pnpm scenarios:filter <slug>` runs a single scenario by name.
- `pnpm scenarios:explain <slug>` prints a human-readable timeline.
- `pnpm scenarios:record <slug>` regenerates `expected.json` from a live run (manual trim still required for subset matcher discipline).
- `.github/workflows/ci.yml` gains a `scenarios` job after `build` running on Node 20 only.
- `pnpm typecheck` and `pnpm build` clean.
