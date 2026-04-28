# Colony MCP Server

## ToolSearch Description Strategy

Tool descriptions are search ranking text. Put the phrase an agent would type in
the first sentence, ideally inside the first 80 characters. Put coordination
jargon, status details, and edge-case rules in later sentences.

| Agent search intent | Tool that should win | Lead with |
| --- | --- | --- |
| send message, note to other agent | `task_message` | Send a message or note |
| what needs my attention, pending, unread | `attention_inbox` | See what needs your attention |
| what should I work on, available work, pick a task | `task_ready_for_agent` | Find work to claim |
| give my work to, transfer, pass to another agent | `task_hand_off` | Give work to another agent |
| who is working, active agents, before editing | `hivemind_context` | Use this BEFORE editing |
| search memory, prior decisions, old errors | `search` | Search memory |
| full observation body, read IDs | `get_observations` | Read full observation bodies |
| recent sessions, inspect session history | `list_sessions` | Find recent sessions |
| task thread history, recent coordination | `task_timeline` | See recent task-thread activity |
| unread task changes, updates since | `task_updates_since` | Check unread task updates |
| claim file, file ownership, before editing | `task_claim_file` | Claim a file before editing |
| split large task, publish subtasks | `task_plan_publish` | Split a large task |
| plan conflicts, validate parallel split | `task_plan_validate` | Check a multi-agent plan |
| examples, reference implementation | `examples_query` | Search example code patterns |
| stranded session, abandoned claims | `rescue_stranded_scan` | Find stranded sessions |

Rules for future descriptions:

- Start with a verb an agent would search for: `Send`, `See`, `Find`, `Give`,
  `Read`, `Claim`, `Check`, `Plan`, `Record`, or `Archive`.
- Keep the first sentence about user intent, not internal data structures.
- Mention reply chains, urgency, broadcast versus directed, TTLs, and fallback
  rules after the first sentence.
- Preserve stable tool names, schemas, and handler behavior when tuning search
  text.
