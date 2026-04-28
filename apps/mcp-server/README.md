# Colony MCP Server

## ToolSearch Heuristics

Tool descriptions are search ranking text. Put the user query phrase in the
first sentence, ideally inside the first 80 characters. Put coordination jargon,
status details, and edge-case rules in the second sentence or later.

| user types | tool that should win |
| --- | --- |
| send message, note to agent, tell another agent | `task_message` |
| what needs my attention, pending, unread, blocking | `attention_inbox` |
| save current working state, active Colony task, no task id | `task_note_working` |
| task-scoped question, answer, decision, blocker, note | `task_post` |
| failed path, blocked approach, do not repeat, reverted solution | `task_post` |
| what should I work on, pick next task, available work | `task_ready_for_agent` |
| give my work to, transfer, pass to another agent | `task_hand_off` |
| before editing, inspect ownership, active ownership, relevant memory | `hivemind_context` |
| search prior memory, prior decisions, old errors, notes, negative warnings | `search` |
| full observation body, read IDs | `get_observations` |
| recent sessions, inspect session history | `list_sessions` |
| task thread history, recent coordination | `task_timeline` |
| unread task changes, updates since | `task_updates_since` |
| claim file, avoid conflict, file ownership, before editing | `task_claim_file` |
| queen workflow, publish goal | `queen_plan_goal` |
| split large task, publish subtasks | `task_plan_publish` |
| plan conflicts, validate parallel split | `task_plan_validate` |
| examples, reference implementation | `examples_query` |
| stranded session, abandoned claims | `rescue_stranded_scan` |

Rules for future descriptions:

- Start with a verb an agent would search for: `Send`, `See`, `Find`, `Give`,
  `Read`, `Claim`, `Check`, `Plan`, `Record`, or `Archive`.
- Keep the first sentence about user intent, not internal data structures.
- Keep the first 80 characters as an imperative verb plus use-case phrase.
- Mention reply chains, urgency, broadcast versus directed, TTLs, and fallback
  rules in the second sentence.
- For avoidance signals, route explicit `failed_approach`, `blocked_path`,
  `conflict_warning`, or `reverted_solution` posts through `task_post`; retrieval
  remains compact through `search`, `hivemind_context`, and
  `task_ready_for_agent`.
- Preserve stable tool names, schemas, and handler behavior when tuning search
  text.
