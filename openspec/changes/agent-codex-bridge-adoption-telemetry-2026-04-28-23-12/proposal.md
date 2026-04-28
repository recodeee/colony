# Bridge Adoption Telemetry

## Problem

Generic debrief telemetry shows overall tool reads and writes, but it does not
answer whether OMX coordination fallbacks are being replaced by Colony bridge
surfaces.

## Change

- Add bridge-specific local telemetry metrics to `colony debrief`.
- Track startup loop conversion from `hivemind_context` to `attention_inbox` to
  `task_ready_for_agent`.
- Compare `task_list` inventory reads against ready-work selection.
- Compare OMX notepad/status reads with Colony working notes and bridge status
  reads when local OMX telemetry is available.

## Scope

Local SQLite observations only. No hosted analytics or external telemetry.
