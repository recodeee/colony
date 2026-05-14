---
'colonyq': minor
---

Add a `Movers` section to `colony gain` that splits the queried window into a
trailing "recent" segment and a "prior" segment, then surfaces operations whose
per-hour call rate, token rate, or error count has shifted materially between
the two. Top 3 risers (▲), top 3 fallers (▼), and top 3 error risers (!) are
listed inline above the existing Operations table. New ops (no prior activity)
are tagged `(new)` and disappeared ops `(gone)`. Two new flags: `--recent-hours
<n>` to override the split (default: `window / 7`) and `--no-movers` to
suppress the section. JSON output gains a `live.movers` payload with the same
shape as the rendered rows.
