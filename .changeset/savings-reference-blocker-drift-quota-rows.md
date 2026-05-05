---
'@colony/core': patch
---

Add 3 reference rows to `SAVINGS_REFERENCE_ROWS`: **Blocker recurrence** (search-keyed lookup of prior `failed_approach` notes vs cold re-investigation), **Drift / failed-verification recovery** (`spec_build_record_failure` surfacing the matching §V invariant after a test fails vs re-deriving the constraint), and **Quota-exhausted handoff** (`task_relay` carrying claim+next+evidence to the rescuer vs reconstructing from worktree + git log). README savings table updated to match.
