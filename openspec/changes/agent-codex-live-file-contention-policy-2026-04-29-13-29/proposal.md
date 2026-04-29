# Proposal

## Why

Live file contention needs a policy signal that the runtime bridge can enforce.
The existing bridge policy blocks strong claim conflicts, but the conflict code
should be the repo-policy signal `LIVE_FILE_CONTENTION`.

## What

- Emit `LIVE_FILE_CONTENTION` for live claim contention warnings and telemetry.
- Derive `block-on-conflict` denials from that signal plus strong ownership.
- Keep weak and expired claims advisory only.
- Add regression coverage for warn, block-on-conflict, audit-only, and weak or expired claims.

## Impact

- Runtime bridge behavior stays default-warn.
- Repos that opt into `block-on-conflict` can deny edits only when another live
  agent strongly owns the file.
