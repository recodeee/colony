---
"@colony/storage": patch
"@imdeadpool/colony-cli": patch
---

Add `colony queen archive <slug>` to dismiss orphan queen plans whose
openspec change directory was never published. The existing `colony plan
close` and `mcp__colony__spec_archive` paths require a `CHANGE.md` and
cannot reach DB-only plans (e.g. duplicate auto-plans), so health stayed
red even after the work was abandoned. The new verb sets `status =
'archived'` on the parent task plus every `spec/<slug>/sub-N` row in one
transaction, records a `plan-archived` observation, and refuses to run
with claimed sub-tasks unless `--force` is set. Idempotent: re-running
on an already-archived plan reports zero rows updated.
