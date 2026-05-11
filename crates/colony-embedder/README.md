# colony-embedder

Rust embedder backend boundary for Colony.

`auto_pick()` chooses the first compiled, usable backend in this order:

1. `ort-cuda`
2. `ort-cpu`
3. `tract`
4. `cpu-stub`

The selected backend is logged once at `tracing::info!` as
`colony embedder backend selected`.

`COLONY_EMBEDDER_FORCE=<name>` is available only in debug builds for local
diagnostics. Release builds ignore it and keep the production path on automatic
selection.
