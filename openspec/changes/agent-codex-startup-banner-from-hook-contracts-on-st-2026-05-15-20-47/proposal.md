## Why

OMX lifecycle SessionStart refreshes active-session telemetry before the normal
SessionStart attention contract renders. When the refreshed lane was previously
stale or dead, the startup context could lose the stalled-lane signal that told
the agent it was resuming a risky lane.

## What Changes

Capture stalled-lane attention before routing lifecycle SessionStart through the
hook runner, then prepend a bounded startup banner to the returned context. Add a
focused lifecycle-envelope regression that proves the stale-lane signal survives
the telemetry refresh.

## Impact

Affected surface is the OMX lifecycle SessionStart route. Output is bounded to
three stalled lanes and falls back silently if attention collection is
unavailable, matching existing hook best-effort behavior.
