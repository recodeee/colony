---
name: co-tokens
description: Bucket Claude Code and Codex session tokens into Colony tasks and surface improvement suggestions. Use when the user runs `/co:tokens`, asks how many tokens a task spent, why a session got expensive, or what to change next time.
---

# /co:tokens

Per-task token attribution + actionable feedback. Works for both Claude Code
sessions (`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`) and Codex
rollouts (`~/.codex/sessions/**/rollout-*-<sessionId>.jsonl`).

The script joins:
- per-turn token usage from the session JSONL
- `~/.colony/data.db` — `sessions`, `tasks`, `task_claims`,
  `task_participants`, `observations`

Task windows are anchored on the **earliest signal** linking a session to a
task — `min(claimed_at, participant joined_at, first observation ts)`. Turns
before any task signal land in a `pre-task` bucket, and the script then
**retroactively assigns** pre-task turns to a task whose claimed_files appear
in that turn's tool calls (Read/Edit/Write/MultiEdit/Bash). Result: a turn
that read a file before the task was claimed still buckets to that task.

## Preconditions

- Session JSONL exists (Claude Code or Codex).
- `~/.colony/data.db` exists. If missing, the report still runs but every
  turn lands in a single uncategorized window.

## Procedure

1. Pick the session.
   - `--latest` (default) resolves the most recent JSONL under any encoded
     ancestor path of `--repo`. Walks up so a session inside an agent
     worktree still finds the primary checkout's JSONL dir. Searches both
     Claude Code and Codex roots.
   - `--session <id>` runs against a specific session id (matched by JSONL
     filename for Claude Code or by `session_meta.payload.id` for Codex).
   - `--history [N]` aggregates the last N sessions for `--repo` (default 10).
2. Run:
   ```bash
   python3 scripts/colony-token-analyzer.py --latest
   python3 scripts/colony-token-analyzer.py --session <uuid>
   python3 scripts/colony-token-analyzer.py --history 10            # trend report
   python3 scripts/colony-token-analyzer.py --latest --gain         # marketing-style
   python3 scripts/colony-token-analyzer.py --latest --json         # for piping
   ```

   `--gain` mirrors `rtk gain`: hero stats (ctx, billable-eq, savings vs
   no-cache), a TOP TASKS leaderboard with bars, and a WINS / OPPORTUNITIES
   side-by-side. Use it when you want a glanceable session report rather than
   a debug-style table.
3. Read the report. The shape is:
   - **header** — session id, JSONL path, turns, `ctx` tokens (raw context
     volume), `bill-eq` tokens (cost-weighted: cache_read ×0.1, input ×1,
     cache_creation ×1.25, output ×5), wall-clock
   - **per-task** — task id, title, turns, ctx, bill-eq, cache hit %, files
   - **suggestions** — severity-tagged patterns with a one-line fix

Use `bill-eq` to rank by cost; use `ctx` to gauge context pressure. A 60M-ctx
session at 95% cache hit can be cheaper than a 10M-ctx session at 0%.

## What the patterns mean

| pattern | trigger | why it matters |
| --- | --- | --- |
| `duplicate-reads` | same file Read 3+ times in one task | the second+ read is wasted cache miss; reference line ranges instead |
| `bash-for-content` | Bash starts with `cat`/`head`/`tail`/`grep`/`rg` | Read/Grep/Glob get cached and respect read-before-edit |
| `task_list-overuse` | `task_list` >= 3 and beats `task_ready_for_agent` | task_list is for inventory, not scheduling |
| `cache-miss` | task with 5+ turns and `cache_read` share <30% | context churn; front-load files once per task |
| `fragmentation` | 50%+ of turns produce <50 output tokens | many short replies inflate input via state replay |
| `no-claim-coverage` | 60%+ of tokens unattributed (pre-task + protected-branch tasks with no claims) | start an agent lane and claim files early so attribution covers the bulk of the session |

Suggestions are tagged with **streak counts** (`[med ×3]`) when the same
pattern fired in the prior cached session reports. A streak ≥ 2 means the same
issue is recurring across sessions — fix it once, save it forever.

`--history` adds:
- a TREND bar chart of billable-eq across the N sessions
- RECURRING PATTERNS with per-pattern session counts and (for duplicate-reads)
  the most-offended file path
- a single-line CTA naming the most recurring pattern

## Output discipline

- One report. No follow-up writes from `/co:tokens` itself.
- If the user asks for fixes, treat the suggestions as the to-do list — the
  report names the task and the file pattern, so the next session can act on
  it directly.
- Don't editorialize the numbers. The script is the source of truth.

## Cache

Per-session reports are cached at `~/.colony/cache/token-reports/<sid>.json`
with `version: 1` and an `mtime` invalidation key. `--history` reads from
the cache and recomputes only when the JSONL has been touched since the cache
was written.

## Failure modes

- **No JSONL for that session id** → checked both Claude Code and Codex roots
  and found nothing. The session id may be wrong, or the JSONL has been
  pruned.
- **No claims for the session** → claims are ephemeral. Historical sessions
  often have all claims released; the report falls back to participant /
  observation linkage and may show a single catchall window.
- **Session id ≠ Colony session** → happens when `hivemind_context` was never
  called. The token report still works against the JSONL alone.
