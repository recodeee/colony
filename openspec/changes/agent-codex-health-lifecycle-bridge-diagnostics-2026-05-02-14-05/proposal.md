# Health lifecycle bridge diagnostics

## Problem

`colony health` can report the runtime bridge as available while edit-path
telemetry remains empty. Operators need the source-level reason, not a generic
claim-before-edit or missing-bridge diagnosis.

## Solution

Split execution-safety root causes for lifecycle bridge failures into specific
kinds: unavailable bridge, silent available bridge, missing file paths, claim
metadata mismatch, and no hook-capable edits in the selected window. Include
structured evidence counters in JSON and command hints for install/verify paths.

## Safety

This is diagnostics-only. It changes health reporting, action-hint wording, and
tests, without mutating claims, bridge state, storage schema, or hook behavior.
