## Problem

Stranded sessions can stay idle for days while still holding advisory claim rows. Operators can see the problem in the viewer, but cleanup requires piecemeal rescue paths instead of one safe bulk command.

## Scope

- Add `colony rescue stranded --older-than <duration> --dry-run`.
- Add `colony rescue stranded --older-than <duration> --apply`.
- Keep dry-run read-only.
- On apply, release stranded claim rows, mark the session ended/rescued, and write an audit observation.
- Never delete historical observations.

## Out Of Scope

- Automatic background cleanup policy changes.
- Deleting old observation, summary, pheromone, or task rows.
