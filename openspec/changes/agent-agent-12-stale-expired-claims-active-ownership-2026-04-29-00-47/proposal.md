## Why

Expired and weak claim classifiers exist, but stale rows can still be presented as if they were live ownership in downstream resume and health surfaces.

## What Changes

- Keep health claim counts split between fresh active, stale weak, and expired/weak rows.
- Ensure relay resume metadata inherits only fresh active ownership.
- Document that stale and expired claims remain auditable but do not act as strong ownership.

## Impact

Agents see current ownership without old claim pheromones blocking or transferring work, while stale records remain available for cleanup and audit.
