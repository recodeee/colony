## Why

Agents could call `task_ready_for_agent`, receive a claimable sub-task, and then
call the ready queue again instead of claiming. That made the queue look active
while work stayed unclaimed.

## What Changes

Record a per-session ready-claim obligation when `task_ready_for_agent` returns
`claim_required=true`. A repeated ready call for the same session and still
available sub-task returns the same claim instruction with an explicit
"claim before reading again" response. SessionStart also surfaces the pending
obligation for that session.

## Impact

Affected surfaces are MCP ready queue responses and the SessionStart ready
nudge. Existing auto-claim success paths satisfy the obligation immediately
because the sub-task status changes to claimed for that session.
