## Why

`colony coordination sweep --release-expired-quota` can already downgrade expired quota-pending claims, but operators need a compact audit summary that says how much was released, which tasks were affected most, and the oldest released claim age.

## What Changes

- Add `released_quota_pending_summary` to coordination sweep results.
- Summarize released quota-pending claims by total count, oldest age, and top affected tasks.
- Render the same compact summary in human `colony coordination sweep` output.
- Add focused core and CLI regression coverage.

## Impact

This is additive metadata and display text. Existing JSON consumers keep the existing fields, while operators get clearer proof after applying quota cleanup.
