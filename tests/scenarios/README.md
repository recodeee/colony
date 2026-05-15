# Test scenarios

Reproducible multi-agent situations driven against the same in-process
code path the production runtimes use.

Each scenario is a directory of plaintext artifacts (no binary
snapshots):

- `seed.sql` — applied after schema migrations against a fresh tempdir
  SQLite DB. `<REPO_ROOT>` placeholders are expanded to the live
  tempdir path before execution.
- `inputs.jsonl` — one envelope per line, sorted by `at_ms`. Each
  envelope has shape `{kind, at_ms, payload}`. `kind` is one of:
  - `lifecycle` — funnel `payload` through `runOmxLifecycleEnvelope`
    (same entrypoint production hooks call).
  - `mcp` — record an MCP metric row.
  - `task` — direct `TaskThread` action (`claim_file`, `relay`,
    `accept_relay`, `release_expired_quota`, `join`, `add_observation`).
  - `tick` — advance the fake clock without dispatching anything.
- `expected.json` — normalized substrate snapshot using **subset
  matchers** (vitest `toMatchObject` style). Fields not listed are
  ignored. Paths normalized to `<REPO_ROOT>` so diffs are tempdir-stable.
- `meta.yaml` (optional) — `runtimes`, `tags`, `description`.

## Commands

```bash
pnpm scenarios                                # run all scenarios + harness self-tests
pnpm scenarios:filter 03-stale-claim-sweep    # run one by slug
pnpm scenarios:explain 02-cross-runtime-handoff  # human-readable timeline
pnpm scenarios:record 04-plan-claim-adoption     # regenerate expected.json
```

After `scenarios:record`, hand-trim the generated file down to subset
matchers — leaving the full row in is a defect because tests will then
break on unrelated noise.

## Determinism rules

- `BASE_TS = 2026-05-16T10:00:00.000Z`. Every `at_ms` is an offset from
  this anchor. The runner calls `vi.setSystemTime(BASE_TS + at_ms)` (or
  the equivalent for `scenarios:record`) before each input.
- Embeddings forced to `provider: 'none'` in the harness so no scenario
  reaches for the network or pulls a model.
- Session IDs are explicit in `inputs.jsonl`. Do not call
  `store.startSession()` without an id — randomness would defeat the
  point.
- Paths in `expected.json` use `<REPO_ROOT>` instead of the live
  tempdir.

## Scenarios

| Slug | What it proves |
| --- | --- |
| `01-claim-before-edit` | Codex pre_tool_use auto-claims target before Edit lands; post_tool_use sees the claim. |
| `02-cross-runtime-handoff` | Codex relays out, claude session adopts the relay; claim ownership flips to claude. |
| `03-stale-claim-sweep` | Relay TTL expires; `release_expired_quota` transitions claim to `weak_expired`. |
| `04-plan-claim-adoption` | Seeded queen sub-task gets adopted by a codex agent (`plan-subtask-claim` → `claimed`). |
| `05-path-mismatch-reclaim` | Agent claims wrong file first; pre_tool_use on a different path auto-claims the correct one. |

## Adding a scenario

1. `mkdir tests/scenarios/NN-slug && cd tests/scenarios/NN-slug`
2. Write `seed.sql` (or leave empty) and `inputs.jsonl`.
3. `pnpm scenarios:record NN-slug` to bootstrap `expected.json`.
4. Hand-trim `expected.json` to subset matchers.
5. `pnpm scenarios:filter NN-slug` until green.
6. `pnpm scenarios` to confirm full suite stays green.

## Harness self-tests

`_harness/__tests__/harness.test.ts` proves the runner fails closed:

- Missing `expected.json` throws `ScenarioConfigError`.
- Mismatched `expected.json` throws `ScenarioMismatchError` with the
  scenario slug, offending key path, actual value, and expected value
  in the message.

If you add a new envelope kind or normalizer, extend the self-tests so
the harness can't silently pass against a wrong fixture.
