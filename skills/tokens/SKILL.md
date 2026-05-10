---
name: co-tokens
description: Bucket Claude Code session tokens into Colony tasks and surface improvement suggestions. Use when the user runs `/co:tokens`, asks how many tokens a task spent, why a session got expensive, or what to change next time.
---

# /co:tokens

Per-task token attribution + actionable feedback.

The script joins:
- `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` — per-turn `message.usage`
- `~/.colony/data.db` — `sessions`, `tasks`, `task_claims`

Task windows come from successive `task_claims.claimed_at` events on the
session. A window opens at the first claim for a task and closes when the next
claim names a different task. Turns before the first claim get a synthetic
`pre-claim` bucket.

## Preconditions

- Claude Code session has at least one assistant turn with `message.usage`.
- `~/.colony/data.db` exists. (If not, the report still runs but every turn
  lands in a single uncategorized window.)

## Procedure

1. Pick the session.
   - `--latest` (default) resolves the most recent JSONL under the encoded path
     for the current repo.
   - `--session <id>` runs against a specific session.
2. Run:
   ```bash
   python3 scripts/colony-token-analyzer.py --latest
   python3 scripts/colony-token-analyzer.py --session <uuid>
   python3 scripts/colony-token-analyzer.py --latest --json   # for piping
   ```
3. Read the report. The shape is:
   - **header** — session id, JSONL path, turns, total tokens, wall-clock
   - **per-task** — task id, title, turns, tokens, cache hit %, distinct files
   - **suggestions** — severity-tagged patterns with a one-line fix

## What the patterns mean

| pattern | trigger | why it matters |
| --- | --- | --- |
| `duplicate-reads` | same file Read 3+ times in one task | the second+ read is wasted cache miss; reference line ranges instead |
| `bash-for-content` | Bash starts with `cat`/`head`/`tail`/`grep`/`rg` | Read/Grep/Glob get cached and respect read-before-edit |
| `task_list-overuse` | `task_list` >= 3 and beats `task_ready_for_agent` | task_list is for inventory, not scheduling |
| `cache-miss` | task with 5+ turns and `cache_read` share <30% | context churn; front-load files once per task |
| `fragmentation` | 50%+ of turns produce <50 output tokens | many short replies inflate input via state replay |
| `no-claim-coverage` | 30%+ of tokens spent before first `task_claim_file` | claim earlier so attribution exists for most of the session |

## Output discipline

- One report. No follow-up writes from `/co:tokens` itself.
- If the user asks for fixes, treat the suggestions as the to-do list — the
  report names the task and the file pattern, so the next session can act on
  it directly.
- Don't editorialize the numbers. The script is the source of truth.

## Failure modes

- **No JSONL for that session id** → the user is probably looking at a Codex
  session. Tell them: Codex sessions live elsewhere; this skill is Claude Code
  only for now.
- **No claims for the session** → report runs with one synthetic window. That
  itself is the finding.
- **Session id ≠ Colony session** → can happen if `hivemind_context` was never
  called. Surface it; the report still works on JSONL alone.
