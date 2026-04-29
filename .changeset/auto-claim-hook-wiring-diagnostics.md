---
"@colony/storage": patch
"@colony/installers": patch
"@colony/hooks": patch
"@colony/mcp-server": patch
"@imdeadpool/colony-cli": patch
---

Make PreToolUse auto-claim coverage observable and surface hook-wiring problems instead of agent-discipline ones.

- The Claude installer now scopes PreToolUse and PostToolUse to a write-tool matcher so the hook does not fire (or get blamed) for unrelated tools.
- `colony hook run pre-tool-use` now writes its warning back through Claude Code's PreToolUse `permissionDecision: allow` so the agent sees the missing-claim warning instead of it being silently dropped on stderr.
- The pre-tool-use warning embeds a concrete `next_call` (an exact `mcp__colony__task_claim_file({...})` invocation) and a multi-line actionable `message`, so an agent that hits ACTIVE_TASK_NOT_FOUND / AMBIGUOUS_ACTIVE_TASK / SESSION_NOT_FOUND knows exactly what to do.
- `claimBeforeEditStats` adds a `pre_tool_use_signals` count of `claim-before-edit` telemetry rows in the window. `colony health` and `hivemind_context`'s claim-before-edit nudge use it to distinguish "hook is not firing" from "agent skipped the claim", and emit an install/restart hint in the former case.
- `colony health` also reports explicit/manual vs auto-claim breakdown and reads "had a claim before edit" instead of "explicit claims first".
