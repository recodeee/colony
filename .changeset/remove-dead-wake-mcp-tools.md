---
"@colony/mcp-server": patch
---

Remove the dead `task_wake`, `task_ack_wake`, and `task_cancel_wake` MCP surface after `ScheduleWakeup` won the coordination fight. The wake storage substrate stays in place so a future `ScheduleWakeup` interception can still reuse `wake_request` observations.
