# External References

## Symphony

`examples/symphony/SPEC.md` in the recodee monorepo is the canonical source for
Symphony adoption work. `examples/symphony/README.md` is supporting orientation
only.

Do not vendor Symphony reference implementation code into this repository. Keep
external source code read-only and cite the canonical spec path instead.

Imported context lives in `openspec/specs/colony-symphony/context.md`. That
context paraphrases the source SPEC anchors needed by Colony agents and records
which future OpenSpec lanes own normative requirements.

Use these source boundaries when adding or reviewing Symphony adoption work:

- Treat `examples/symphony/SPEC.md` as normative for source intent.
- Treat `examples/symphony/README.md` as non-normative orientation.
- Do not copy upstream Elixir implementation files into Colony paths.
- Map tracker behavior onto Colony task and plan state unless a later
  extension explicitly claims another tracker adapter.
