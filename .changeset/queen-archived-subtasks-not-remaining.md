---
"@imdeadpool/colony-cli": patch
---

`colony health` no longer counts archived sub-tasks as "remaining" when
classifying queen plans. Previously a plan archived through `colony
queen archive` (parent + every sub-task flipped to `status='archived'`)
kept tripping `archived_plans_with_remaining_subtasks` because the
metric subtracted only `completed` rows, leaving archived rows in the
remaining bucket. The plan-state recommendation then prompted operators
to publish a replacement plan even when the work was intentionally
abandoned. Archived sub-tasks are now subtracted alongside completed
ones, so a fully-archived plan reports `remaining_subtask_count: 0`
and stops surfacing in the recommendation list.

The pre-existing case (parent archived, sub-tasks still open) is
unchanged: open sub-tasks remain "remaining" and continue to trigger
the replacement-plan recommendation.
