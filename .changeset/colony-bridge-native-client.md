---
"@imdeadpool/colony-cli": minor
---

Native bridge client cuts another 1.5× off the daemon fast path.

`apps/cli/bin/colony.sh` now prefers a tiny native binary at `apps/cli/bin/colony-bridge-<platform>` when one matching the host exists. The binary is `rust/colony-bridge/`: ~340 KB stripped, std-only, raw HTTP/1.1 over TCP. It handles the same daemon POST the curl path does, plus the in-process Node fallback, in ~40 ms mean vs ~60 ms for `sh + curl`.

Three-way bench (`scripts/bench-bridge-fastpath.mjs`, 8 concurrent × 4 iterations):

```
[native (rust)] mean=42.1ms   p95=82.7ms    p99=115.0ms
[curl  (shell)] mean=61.1ms   p95=94.6ms    p99=101.7ms
[node  (legacy)] mean=214.5ms p95=282.7ms   p99=371.7ms

speedup native vs node (mean): 5.1x   saved 172.4ms/event
speedup native vs curl (mean): 1.5x   saved 19.0ms/event
```

This PR ships only `colony-bridge-linux-x64`. macOS and Linux aarch64 binaries are a follow-up via the `optionalDependencies` packaging pattern.

Disable the native path with `COLONY_BRIDGE_NATIVE=0` (falls back to the portable curl path); disable the daemon fast path entirely with `COLONY_BRIDGE_FAST=0`.
