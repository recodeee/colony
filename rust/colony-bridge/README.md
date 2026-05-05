# colony-bridge

Tiny native client for `colony bridge lifecycle --json` that talks to the worker daemon at `POST /api/bridge/lifecycle` directly, skipping the `sh` + `curl` startup tax. Acts as the platform-specific replacement for the shell wrapper's fast path when one matching the host is shipped in `apps/cli/bin/colony-bridge-<platform>`.

## Why a separate binary

The shell wrapper at `apps/cli/bin/colony.sh` is portable, but every event still pays:

- `sh` cold start (~5–10 ms)
- `curl` process spawn + cold start (~15–20 ms)
- `mktemp` + temp-file dance (~3–5 ms)

Replacing those with a single statically-built native binary cuts per-event mean from ~60 ms to ~40 ms in our local bench (1.5× over `curl`, 5.1× over the legacy in-process Node path). See `scripts/bench-bridge-fastpath.mjs`.

## Behavior

The binary is invoked by the shell wrapper as

```
colony-bridge-<platform> bridge lifecycle --json [--ide X] [--cwd Y]
```

with the envelope JSON on stdin. It:

1. Parses the same flag set the wrapper accepts (`--json`, `--ide`, `--cwd`, plus `--ide=…` / `--cwd=…`). Anything else falls through.
2. Reads stdin into memory.
3. Opens a TCP connection to `127.0.0.1:${COLONY_WORKER_PORT:-37777}` with a 1 s connect timeout, sends a single HTTP/1.1 POST with `Connection: close`, reads the response with a 2 s read timeout.
4. On HTTP 200, writes the response body to stdout and exits 0.
5. On any failure (connect refused, timeout, parse error, non-200), execs `node ../dist/index.js bridge lifecycle [args]` with the buffered envelope re-fed on stdin. Same write path as before — preserves the rule-10 "writes never depend on the daemon" contract.

## Building

```
cargo build --release
```

Produces `target/release/colony-bridge`. Stage it for npm distribution by copying to `apps/cli/bin/colony-bridge-<platform>` (e.g. `colony-bridge-linux-x64`). The shell wrapper auto-detects via `uname -s` / `uname -m`.

## Disabling

Set `COLONY_BRIDGE_NATIVE=0` to force the wrapper onto the portable curl path. Set `COLONY_BRIDGE_FAST=0` to disable the daemon fast path entirely.

## Multi-platform packaging (TODO)

This PR ships only a Linux x86_64 binary. macOS arm64/x64 and Linux aarch64 binaries belong in a follow-up using the `optionalDependencies` pattern (the shape `swc`, `esbuild`, `lightningcss` use): one published npm package per `<os>-<arch>` tuple, the wrapper resolves to whichever the host can install.
