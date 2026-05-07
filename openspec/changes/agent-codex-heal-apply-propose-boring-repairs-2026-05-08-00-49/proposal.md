# Add reversible Colony heal apply command

## Problem

The roadmap's v0 to v1 jump needs a repair surface that feels safe enough to run. Existing health and coordination commands can report or sweep pieces of the state, but operators do not have a single `colony heal --apply` path that proposes specific changes, asks for approval action-by-action, and leaves searchable repair evidence.

## Solution

Add `colony heal` as the Propose & Apply surface. It proposes boring, low-contention repairs first: expired quota-pending claim release and protected-base claim redirect to an existing single matching `agent/*` task. `--apply` asks before each action, while `--yes` supports non-interactive automation.

## Safety

The command does not run contention auto-resolution. Every applied action records a `repair` observation whose content includes `repair:` so `colony search "repair"` can audit the loop without reading code.
