# colony-omx-lifecycle-v1 fixtures

Saved lifecycle envelopes for the runtime bridge contract. Each `*.pre.json` /
`*.post.json` is a real-shape payload that a runtime (Codex, OMX, or any future
integrator) is expected to produce on the equivalent hook event.

## Replay a fixture offline

Use `colony bridge lifecycle --replay <file> --dry-run --json` to route a saved
envelope through the live Colony lifecycle logic against an ephemeral SQLite
store, leaving your real data dir untouched:

```bash
colony bridge lifecycle --json --dry-run \
  --replay packages/contracts/fixtures/colony-omx-lifecycle-v1/codex-write.pre.json
```

The JSON output includes `ok`, `route`, `event_type`, and `extracted_paths`
when the routed hook produced them. Drive a runtime's CI by piping captured
`.pre.json` files from a real session through the same command and asserting
on these fields. Exit code is `0` when `ok` is `true`, `1` otherwise.

## Capturing a fixture

A runtime that already emits the envelope can save it before sending:

```bash
tee codex-write.pre.json | colony bridge lifecycle
```

Drop the captured file into this directory (or anywhere) and replay later for
debugging without needing the original session.
