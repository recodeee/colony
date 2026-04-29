# Add execution-safety recovery plan command

## Problem

Operators currently run `colony health`, `colony coordination sweep`, `colony queen sweep`, and the Codex/OMX pre-tool smoke as separate daily workflow steps. When health shows the combined execution-safety state of `pre_tool_use_missing`, stale claims, and live contentions, there is no single guided dry-run command that spells out the safe recovery order.

## Solution

Add `colony health --fix-plan` as the guided operator surface. It reads current health, prints a dry-run recovery plan by default, suggests reinstall/restart when `pre_tool_use_missing` dominates, and only runs coordination/queen sweeps when `--apply` is passed.

## Safety

The command never releases claims and never installs hooks. `--apply` only runs the reporting sweeps and prints verification commands.
