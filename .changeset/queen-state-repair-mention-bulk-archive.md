---
"@imdeadpool/colony-cli": patch
---

`colony health` Queen plan state repair hint now mentions `colony coordination sweep --archive-completed-plans` in its `inspect` field alongside the existing `colony queen sweep --json` reference. The new bulk flag (added in PR #423) is the operator path that clears all completed-but-unarchived plans without requiring per-plan opt-in; surfacing it in the hint makes it discoverable when the dashboard fires the repair signal.
