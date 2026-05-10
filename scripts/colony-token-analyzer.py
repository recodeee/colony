#!/usr/bin/env python3
"""colony-token-analyzer — bucket Claude Code session tokens into Colony tasks.

Joins:
  ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl  (per-turn message.usage)
  ~/.colony/data.db                                    (sessions, tasks, task_claims)

For a single session, builds task windows from successive `task_claims.claimed_at`
events, buckets each assistant turn into the matching window, and emits both a
per-task token report and a list of improvement suggestions for the next session.

Stdlib only.
"""

from __future__ import annotations

import argparse
import datetime as dt
import glob
import json
import os
import sqlite3
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_DB = Path.home() / ".colony" / "data.db"
DEFAULT_PROJECTS = Path.home() / ".claude" / "projects"
DEFAULT_CODEX = Path.home() / ".codex" / "sessions"


# ---------------------------------------------------------------------------
# Data shapes
# ---------------------------------------------------------------------------


@dataclass
class Turn:
    ts_ms: int
    model: str
    input_tokens: int
    cache_creation: int
    cache_read: int
    output_tokens: int
    tool_calls: list[tuple[str, dict]] = field(default_factory=list)

    @property
    def total(self) -> int:
        return self.input_tokens + self.cache_creation + self.cache_read + self.output_tokens

    @property
    def billable_equivalent(self) -> float:
        # Weights normalized to "input token" units using Anthropic's published
        # ratios for the Opus / Sonnet tier: cache_read ≈ 0.1x input,
        # cache_creation ≈ 1.25x input, output ≈ 5x input. Lets the user rank
        # tasks by *cost*, not just context volume.
        return (
            self.input_tokens * 1.0
            + self.cache_creation * 1.25
            + self.cache_read * 0.1
            + self.output_tokens * 5.0
        )


@dataclass
class TaskWindow:
    task_id: int | str
    title: str
    branch: str
    start_ms: int
    end_ms: int
    claimed_files: list[str] = field(default_factory=list)
    turns: list[Turn] = field(default_factory=list)

    @property
    def total_tokens(self) -> int:
        return sum(t.total for t in self.turns)

    @property
    def billable_equivalent(self) -> float:
        return sum(t.billable_equivalent for t in self.turns)

    @property
    def cache_hit_ratio(self) -> float:
        cr = sum(t.cache_read for t in self.turns)
        cc = sum(t.cache_creation for t in self.turns)
        ip = sum(t.input_tokens for t in self.turns)
        denom = cr + cc + ip
        return cr / denom if denom else 0.0


# ---------------------------------------------------------------------------
# JSONL parsing
# ---------------------------------------------------------------------------


def detect_format(path: Path) -> str:
    """Return 'codex' if the JSONL is a Codex rollout, 'claude' if it's a Claude
    Code session transcript, 'unknown' otherwise. Probes the first few lines."""
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for _ in range(8):
                raw = fh.readline()
                if not raw:
                    break
                try:
                    obj = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if obj.get("type") == "session_meta":
                    return "codex"
                if obj.get("type") in ("last-prompt", "permission-mode", "user", "assistant"):
                    return "claude"
                if "sessionId" in obj:
                    return "claude"
    except OSError:
        pass
    return "unknown"


def codex_session_meta(path: Path) -> dict | None:
    """First line of a Codex rollout is `session_meta` carrying id, cwd, model.
    Returns the payload dict or None."""
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for _ in range(4):
                raw = fh.readline()
                if not raw:
                    break
                try:
                    obj = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if obj.get("type") == "session_meta":
                    return obj.get("payload") or {}
    except OSError:
        return None
    return None


def find_jsonl(session_id: str, projects: Path, codex_root: Path) -> Path | None:
    matches = list(projects.glob(f"*/{session_id}.jsonl"))
    if matches:
        return matches[0]
    cd = list(codex_root.glob(f"**/rollout-*-{session_id}.jsonl"))
    return cd[0] if cd else None


def _repo_ancestors(repo_root: Path) -> list[str]:
    out: list[str] = []
    cur = repo_root.resolve()
    while True:
        out.append(str(cur))
        if cur.parent == cur:
            return out
        cur = cur.parent


def latest_session_jsonl(repo_root: Path, projects: Path, codex_root: Path) -> Path | None:
    # Walk up from repo_root so a session running inside an agent worktree
    # still finds the JSONL dir for the primary checkout. Search both Claude
    # Code projects and Codex rollouts (filtered by session_meta.cwd).
    candidates: list[Path] = []
    for ancestor in _repo_ancestors(repo_root):
        enc = "-" + ancestor.lstrip("/").replace("/", "-")
        candidates.extend((projects / enc).glob("*.jsonl"))

    ancestors_set = set(_repo_ancestors(repo_root))
    if codex_root.is_dir():
        recent = __import__("time").time() - 30 * 86400
        for rollout in codex_root.glob("**/rollout-*.jsonl"):
            try:
                if rollout.stat().st_mtime < recent:
                    continue
            except OSError:
                continue
            meta = codex_session_meta(rollout)
            if not meta:
                continue
            if meta.get("cwd") in ancestors_set:
                candidates.append(rollout)

    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


def iso_to_ms(iso: str) -> int:
    iso = iso.replace("Z", "+00:00")
    return int(dt.datetime.fromisoformat(iso).timestamp() * 1000)


def parse_codex_jsonl(path: Path) -> list[Turn]:
    """Codex rollouts emit token_count `event_msg` events with both
    `last_token_usage` (per-call delta) and `total_token_usage` (cumulative).
    Each event seems to be logged twice consecutively, so we dedupe by
    cumulative-total stagnation. Cached input is reported as a subset of the
    input bucket; we split it into our (input_tokens, cache_read) shape."""
    turns: list[Turn] = []
    last_total_in = -1
    last_total_out = -1
    try:
        fh = path.open("r", encoding="utf-8", errors="replace")
    except OSError:
        return turns
    with fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if obj.get("type") != "event_msg":
                continue
            payload = obj.get("payload") or {}
            if payload.get("type") != "token_count":
                continue
            info = payload.get("info") or {}
            if not info:
                continue
            total = info.get("total_token_usage") or {}
            t_in = int(total.get("input_tokens", 0) or 0)
            t_out = int(total.get("output_tokens", 0) or 0)
            if t_in == last_total_in and t_out == last_total_out:
                continue
            last_total_in, last_total_out = t_in, t_out
            ts = obj.get("timestamp")
            if not ts:
                continue
            try:
                ts_ms = iso_to_ms(ts)
            except ValueError:
                continue
            last = info.get("last_token_usage") or {}
            input_total = int(last.get("input_tokens", 0) or 0)
            cached = int(last.get("cached_input_tokens", 0) or 0)
            output = int(last.get("output_tokens", 0) or 0)
            reasoning = int(last.get("reasoning_output_tokens", 0) or 0)
            turns.append(
                Turn(
                    ts_ms=ts_ms,
                    model="codex",
                    input_tokens=max(0, input_total - cached),
                    cache_creation=0,
                    cache_read=cached,
                    output_tokens=output + reasoning,
                    tool_calls=[],
                )
            )
    turns.sort(key=lambda t: t.ts_ms)
    return turns


def parse_session(path: Path) -> tuple[list[Turn], str]:
    fmt = detect_format(path)
    if fmt == "codex":
        return parse_codex_jsonl(path), "codex"
    return parse_jsonl(path), "claude"


def session_id_for(path: Path, fmt: str) -> str:
    if fmt == "codex":
        meta = codex_session_meta(path)
        if meta and meta.get("id"):
            return meta["id"]
    return path.stem


def parse_jsonl(path: Path) -> list[Turn]:
    turns: list[Turn] = []
    with path.open("r", encoding="utf-8", errors="replace") as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if obj.get("type") != "assistant":
                continue
            msg = obj.get("message") or {}
            usage = msg.get("usage")
            if not usage:
                continue
            ts = obj.get("timestamp")
            if not ts:
                continue
            try:
                ts_ms = iso_to_ms(ts)
            except ValueError:
                continue
            tool_calls: list[tuple[str, dict]] = []
            for block in msg.get("content") or []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    tool_calls.append((block.get("name", "?"), block.get("input") or {}))
            turns.append(
                Turn(
                    ts_ms=ts_ms,
                    model=msg.get("model", "?"),
                    input_tokens=int(usage.get("input_tokens", 0) or 0),
                    cache_creation=int(usage.get("cache_creation_input_tokens", 0) or 0),
                    cache_read=int(usage.get("cache_read_input_tokens", 0) or 0),
                    output_tokens=int(usage.get("output_tokens", 0) or 0),
                    tool_calls=tool_calls,
                )
            )
    turns.sort(key=lambda t: t.ts_ms)
    return turns


# ---------------------------------------------------------------------------
# Colony DB queries
# ---------------------------------------------------------------------------


def fetch_session_tasks(db: Path, session_id: str) -> list[dict]:
    """One row per task linked to this session, anchored at the earliest signal:
    claim_at, participant joined_at, or observation ts. The richer linkage is
    what lets us retroactively attribute pre-claim turns by file path."""
    if not db.exists():
        return []
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        rows = con.execute(
            """
            WITH events AS (
              SELECT task_id, claimed_at AS ts FROM task_claims WHERE session_id = ?
              UNION ALL
              SELECT task_id, joined_at FROM task_participants WHERE session_id = ?
              UNION ALL
              SELECT task_id, ts FROM observations
              WHERE session_id = ? AND task_id IS NOT NULL
            ),
            anchors AS (
              SELECT task_id, MIN(ts) AS started_ms FROM events GROUP BY task_id
            )
            SELECT a.task_id, t.title, t.branch, a.started_ms
            FROM anchors a JOIN tasks t ON t.id = a.task_id
            ORDER BY a.started_ms ASC
            """,
            (session_id, session_id, session_id),
        ).fetchall()
        files: dict[int, list[str]] = {}
        for tid, fp in con.execute(
            "SELECT task_id, file_path FROM task_claims WHERE session_id = ?",
            (session_id,),
        ).fetchall():
            files.setdefault(tid, []).append(fp)
    finally:
        con.close()
    return [
        {
            "task_id": r[0],
            "title": r[1],
            "branch": r[2],
            "started_ms": r[3],
            "files": files.get(r[0], []),
        }
        for r in rows
    ]


def session_window(db: Path, session_id: str) -> tuple[int, int] | None:
    if not db.exists():
        return None
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        row = con.execute(
            "SELECT started_at, ended_at FROM sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
    finally:
        con.close()
    if not row:
        return None
    started, ended = row
    return int(started or 0), int(ended or 0) if ended else 0


# ---------------------------------------------------------------------------
# Window construction
# ---------------------------------------------------------------------------


def build_windows(session_tasks: list[dict], turns: list[Turn]) -> list[TaskWindow]:
    """One window per (session, task), anchored at the task's first signal in
    this session. Turns before the first signal go to a 'pre-task' bucket that
    is then deflated by retroactive file-path attribution: any pre-task turn
    that touches a later-claimed file gets reassigned to that task."""

    if not turns:
        return []
    end_ms = turns[-1].ts_ms + 1

    if not session_tasks:
        only = TaskWindow(
            task_id="—",
            title="(no Colony task links found in this session)",
            branch="—",
            start_ms=turns[0].ts_ms,
            end_ms=end_ms,
        )
        only.turns.extend(turns)
        return [only]

    windows: list[TaskWindow] = []
    first_started = session_tasks[0]["started_ms"]
    pre: TaskWindow | None = None
    if turns[0].ts_ms < first_started:
        pre = TaskWindow(
            task_id="pre-task",
            title="(turns before any task link)",
            branch="—",
            start_ms=turns[0].ts_ms,
            end_ms=first_started,
        )
        windows.append(pre)

    for i, st in enumerate(session_tasks):
        next_start = (
            session_tasks[i + 1]["started_ms"] if i + 1 < len(session_tasks) else end_ms
        )
        windows.append(
            TaskWindow(
                task_id=st["task_id"],
                title=st["title"] or f"task #{st['task_id']}",
                branch=st["branch"] or "—",
                start_ms=st["started_ms"],
                end_ms=next_start,
                claimed_files=list(st["files"]),
            )
        )

    for turn in turns:
        for w in windows:
            if w.start_ms <= turn.ts_ms < w.end_ms:
                w.turns.append(turn)
                break

    if pre and pre.turns:
        # Build path -> task_id map (first claim wins on overlap).
        file_to_task: dict[str, int] = {}
        base_to_task: dict[str, int] = {}
        windows_by_id: dict[int, TaskWindow] = {
            w.task_id: w for w in windows if isinstance(w.task_id, int)
        }
        for w in windows:
            if not isinstance(w.task_id, int):
                continue
            for fp in w.claimed_files:
                file_to_task.setdefault(fp, w.task_id)
                base = os.path.basename(fp)
                if len(base) >= 6:
                    base_to_task.setdefault(base, w.task_id)

        unassigned: list[Turn] = []
        for turn in pre.turns:
            target: int | None = None
            for name, inp in turn.tool_calls:
                inp = inp or {}
                candidates: list[str] = []
                if name in ("Read", "Edit", "Write", "MultiEdit"):
                    fp = inp.get("file_path")
                    if fp:
                        candidates.append(fp)
                elif name == "Bash":
                    cmd = inp.get("command") or ""
                    for fp in file_to_task:
                        if fp in cmd:
                            candidates.append(fp)
                            break
                    else:
                        for base, tid in base_to_task.items():
                            if base in cmd:
                                target = tid
                                break
                for fp in candidates:
                    tid = file_to_task.get(fp) or base_to_task.get(os.path.basename(fp))
                    if tid and tid in windows_by_id:
                        target = tid
                        break
                if target:
                    break
            if target is not None and target in windows_by_id:
                windows_by_id[target].turns.append(turn)
            else:
                unassigned.append(turn)
        pre.turns = unassigned
        if not pre.turns:
            windows.remove(pre)

    return windows


# ---------------------------------------------------------------------------
# Pattern detectors
# ---------------------------------------------------------------------------


def detect_patterns(windows: list[TaskWindow], all_turns: list[Turn]) -> list[dict]:
    suggestions: list[dict] = []

    # 1. Duplicate Read calls within a task window
    for w in windows:
        reads = Counter()
        for turn in w.turns:
            for name, inp in turn.tool_calls:
                if name == "Read":
                    fp = (inp or {}).get("file_path")
                    if fp:
                        reads[fp] += 1
        dupes = [(fp, n) for fp, n in reads.items() if n >= 3]
        if dupes:
            suggestions.append(
                {
                    "kind": "duplicate-reads",
                    "severity": "high" if any(n >= 5 for _, n in dupes) else "med",
                    "task": f"{w.task_id} · {w.title}",
                    "detail": ", ".join(f"{Path(fp).name} ×{n}" for fp, n in dupes[:5]),
                    "fix": "Read once into context; reference by line range on follow-ups instead of re-reading.",
                }
            )

    # 2. Bash for file content (cat / head / tail / grep / find) instead of Read / Grep / Glob
    bash_for_content_hits: Counter = Counter()
    for turn in all_turns:
        for name, inp in turn.tool_calls:
            if name != "Bash":
                continue
            cmd = (inp or {}).get("command", "")
            for tool in ("cat ", "head ", "tail ", "rg ", "grep "):
                if cmd.lstrip().startswith(tool) or f"\n{tool}" in cmd:
                    bash_for_content_hits[tool.strip()] += 1
                    break
    if bash_for_content_hits:
        suggestions.append(
            {
                "kind": "bash-for-content",
                "severity": "med",
                "task": "session-wide",
                "detail": ", ".join(f"{t}×{n}" for t, n in bash_for_content_hits.most_common(5)),
                "fix": "Use Read / Grep / Glob tools instead of shelling cat/head/tail/grep — they get cached and respect read-before-edit.",
            }
        )

    # 3. task_list overuse (should use task_ready_for_agent)
    task_list_calls = sum(
        1
        for turn in all_turns
        for name, _ in turn.tool_calls
        if name.endswith("task_list")
    )
    task_ready_calls = sum(
        1
        for turn in all_turns
        for name, _ in turn.tool_calls
        if name.endswith("task_ready_for_agent")
    )
    if task_list_calls >= 3 and task_list_calls > task_ready_calls:
        suggestions.append(
            {
                "kind": "task_list-overuse",
                "severity": "med",
                "task": "session-wide",
                "detail": f"task_list ×{task_list_calls} vs task_ready_for_agent ×{task_ready_calls}",
                "fix": "task_list is an inventory tool. Use task_ready_for_agent to pick claimable work.",
            }
        )

    # 4. Low cache hit ratio on substantive tasks
    for w in windows:
        if len(w.turns) < 5:
            continue
        ratio = w.cache_hit_ratio
        if ratio < 0.30:
            suggestions.append(
                {
                    "kind": "cache-miss",
                    "severity": "high" if ratio < 0.15 else "med",
                    "task": f"{w.task_id} · {w.title}",
                    "detail": f"cache_read share = {ratio*100:.1f}%, {len(w.turns)} turns",
                    "fix": "Front-load context once per task. Avoid bouncing into unrelated files mid-task; that invalidates cache breakpoints.",
                }
            )

    # 5. Output fragmentation (many tiny replies)
    tiny_turns = sum(1 for t in all_turns if t.output_tokens > 0 and t.output_tokens < 50)
    if len(all_turns) >= 20 and tiny_turns / len(all_turns) >= 0.5:
        suggestions.append(
            {
                "kind": "fragmentation",
                "severity": "med",
                "task": "session-wide",
                "detail": f"{tiny_turns}/{len(all_turns)} turns produced <50 output tokens",
                "fix": "Batch reads/edits per phase. A long chain of micro-replies inflates input tokens via repeated state replay.",
            }
        )

    # 6. Unattributed token spend. Counts pre-task turns AND turns on
    # protected-branch tasks (dev/main/etc.) that carry zero file claims —
    # both mean "work happened but Colony has no specific ownership for it."
    PROTECTED_BRANCHES = {"main", "master", "dev", "develop", "production", "release"}
    total_window_tokens = sum(w.total_tokens for w in windows) or 1
    unattributed_tokens = 0
    unattributed_turns = 0
    for w in windows:
        is_pre = w.task_id == "pre-task"
        is_protected_unclaimed = w.branch in PROTECTED_BRANCHES and not w.claimed_files
        if is_pre or is_protected_unclaimed:
            unattributed_tokens += w.total_tokens
            unattributed_turns += len(w.turns)
    share = unattributed_tokens / total_window_tokens
    if share >= 0.60:
        suggestions.append(
            {
                "kind": "no-claim-coverage",
                "severity": "high" if share >= 0.85 else "med",
                "task": "session-wide",
                "detail": f"{share*100:.0f}% of tokens unattributed (no file claims, {unattributed_turns} turns)",
                "fix": "Start an agent lane and task_claim_file early so attribution covers the bulk of the session.",
            }
        )

    return suggestions


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def fmt_int(n: int) -> str:
    if n >= 1_000_000:
        return f"{n/1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n/1_000:.1f}k"
    return str(n)


def render_human(session_id: str, jsonl: Path, windows: list[TaskWindow], all_turns: list[Turn], suggestions: list[dict]) -> str:
    out: list[str] = []
    total = sum(t.total for t in all_turns)
    out.append(f"session  {session_id}")
    out.append(f"jsonl    {jsonl}")
    billable = sum(t.billable_equivalent for t in all_turns)
    out.append(f"turns    {len(all_turns)}")
    out.append(f"tokens   {fmt_int(total)} ctx · {fmt_int(int(billable))} billable-eq")
    if all_turns:
        first = dt.datetime.fromtimestamp(all_turns[0].ts_ms / 1000, dt.timezone.utc)
        last = dt.datetime.fromtimestamp(all_turns[-1].ts_ms / 1000, dt.timezone.utc)
        dur = (all_turns[-1].ts_ms - all_turns[0].ts_ms) / 1000 / 60
        out.append(f"window   {first.isoformat(timespec='seconds')} → {last.isoformat(timespec='seconds')}  ({dur:.1f} min)")

    out.append("")
    out.append("per-task")
    out.append(f"  {'task':<32}  {'turns':>5}  {'ctx':>8}  {'bill-eq':>8}  {'cache%':>6}  files")
    for w in sorted(windows, key=lambda x: x.billable_equivalent, reverse=True):
        if not w.turns:
            continue
        label = f"#{w.task_id} {w.title}"[:32]
        out.append(
            f"  {label:<32}  {len(w.turns):>5}  {fmt_int(w.total_tokens):>8}  "
            f"{fmt_int(int(w.billable_equivalent)):>8}  "
            f"{w.cache_hit_ratio*100:>5.1f}%  {len(set(w.claimed_files))}"
        )

    out.append("")
    out.append("suggestions")
    if not suggestions:
        out.append("  (no patterns detected — looks clean)")
    else:
        for s in suggestions:
            out.append(f"  [{s['severity']}] {s['kind']} · {s['task']}")
            out.append(f"        {s['detail']}")
            out.append(f"    fix→ {s['fix']}")
    return "\n".join(out)


def render_gain(session_id: str, jsonl: Path, windows: list[TaskWindow], all_turns: list[Turn], suggestions: list[dict]) -> str:
    # Marketing-style "colony gain" report — same data as render_human, framed
    # around savings + leaderboard. Mirrors `rtk gain`.
    out: list[str] = []
    if not all_turns:
        return "  no assistant turns to report"

    input_t = sum(t.input_tokens for t in all_turns)
    cc_t = sum(t.cache_creation for t in all_turns)
    cr_t = sum(t.cache_read for t in all_turns)
    out_t = sum(t.output_tokens for t in all_turns)
    ctx_total = input_t + cc_t + cr_t + out_t

    bill = input_t * 1.0 + cc_t * 1.25 + cr_t * 0.1 + out_t * 5.0
    no_cache_bill = (input_t + cc_t + cr_t) * 1.0 + out_t * 5.0
    saved = max(0.0, no_cache_bill - bill)
    saved_pct = (saved / no_cache_bill * 100) if no_cache_bill else 0.0
    cache_share = (cr_t / max(1, cr_t + cc_t + input_t)) * 100

    duration_min = (all_turns[-1].ts_ms - all_turns[0].ts_ms) / 60000

    out.append("")
    out.append("  ╭───────────────────────────────────────────────────────────────╮")
    out.append("  │  COLONY · session gain                                        │")
    out.append("  ╰───────────────────────────────────────────────────────────────╯")
    out.append("")
    out.append(f"   {fmt_int(ctx_total):>9}  ctx tokens routed       {duration_min:>6.1f}  min wall-clock")
    out.append(f"   {fmt_int(int(bill)):>9}  billable-equivalent     {len(all_turns):>6}  assistant turns")
    out.append(f"   {fmt_int(int(saved)):>9}  saved by cache hits     {saved_pct:>5.1f}%  vs no-cache")
    out.append("")

    sorted_w = sorted([w for w in windows if w.turns], key=lambda x: x.billable_equivalent, reverse=True)
    total_bill = sum(w.billable_equivalent for w in sorted_w) or 1
    if sorted_w:
        out.append("  TOP TASKS · by cost")
        max_bill = sorted_w[0].billable_equivalent or 1
        for i, w in enumerate(sorted_w[:5]):
            mark = "★" if i < 2 else "·"
            label = f"#{w.task_id} {w.title}"[:38]
            bar_w = int(w.billable_equivalent / max_bill * 18)
            bar = "█" * bar_w + "░" * (18 - bar_w)
            pct = w.billable_equivalent / total_bill * 100
            out.append(
                f"   {mark}  {label:<38}  {fmt_int(int(w.billable_equivalent)):>7}  "
                f"{bar} {pct:>4.0f}%"
            )
        out.append("")

    wins: list[str] = []
    if cache_share >= 80:
        wins.append(f"{cache_share:.0f}% cache reuse, well-warmed prompts")
    elif cache_share >= 50:
        wins.append(f"{cache_share:.0f}% cache reuse")
    high_cache = [w for w in sorted_w if w.cache_hit_ratio >= 0.95 and len(w.turns) >= 5]
    if high_cache:
        wins.append(f"{len(high_cache)} task(s) at 95%+ cache hit")
    files_total = sum(len(set(w.claimed_files)) for w in sorted_w)
    if files_total >= 5:
        wins.append(f"{files_total} files cleanly attributed")
    if saved >= 500_000:
        wins.append(f"{fmt_int(int(saved))} input-equiv saved by cache")

    opps = [f"[{s['severity']}] {s['detail']}" for s in suggestions]

    if wins or opps:
        out.append(f"  {'WINS':<34}  {'OPPORTUNITIES':<32}")
        rows = max(len(wins), len(opps))
        for i in range(rows):
            w = wins[i] if i < len(wins) else ""
            o = opps[i] if i < len(opps) else ""
            w_line = (f"✓ {w}")[:34] if w else ""
            o_line = (f"→ {o}")[:36] if o else ""
            out.append(f"   {w_line:<34}   {o_line}")
        out.append("")

    if suggestions:
        out.append(f"  next session → {suggestions[0]['fix']}")
    else:
        out.append("  next session → no patterns detected; keep going")
    out.append("")
    return "\n".join(out)


def render_json(session_id: str, jsonl: Path, windows: list[TaskWindow], all_turns: list[Turn], suggestions: list[dict]) -> str:
    payload = {
        "session_id": session_id,
        "jsonl": str(jsonl),
        "turns": len(all_turns),
        "total_tokens": sum(t.total for t in all_turns),
        "billable_equivalent": int(sum(t.billable_equivalent for t in all_turns)),
        "tasks": [
            {
                "task_id": w.task_id,
                "title": w.title,
                "branch": w.branch,
                "turns": len(w.turns),
                "tokens": w.total_tokens,
                "billable_equivalent": int(w.billable_equivalent),
                "cache_hit_ratio": round(w.cache_hit_ratio, 4),
                "claimed_files": sorted(set(w.claimed_files)),
            }
            for w in windows
            if w.turns
        ],
        "suggestions": suggestions,
    }
    return json.dumps(payload, indent=2)


# ---------------------------------------------------------------------------
# Entry
# ---------------------------------------------------------------------------


def main() -> int:
    p = argparse.ArgumentParser(description="Bucket Claude Code session tokens into Colony tasks.")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--session", help="Claude Code session id (matches JSONL filename)")
    g.add_argument("--latest", action="store_true", help="Use the most-recent session for --repo")
    p.add_argument("--repo", default=os.getcwd(), help="Repo root for --latest (default: cwd)")
    p.add_argument("--db", default=str(DEFAULT_DB), help=f"Colony SQLite path (default: {DEFAULT_DB})")
    p.add_argument("--projects-dir", default=str(DEFAULT_PROJECTS), help="Claude Code projects dir")
    p.add_argument("--codex-dir", default=str(DEFAULT_CODEX), help="Codex rollouts dir")
    p.add_argument("--json", action="store_true", help="Emit JSON instead of human report")
    p.add_argument("--gain", action="store_true", help="Render marketing-style gain report (mirrors `rtk gain`)")
    args = p.parse_args()

    projects = Path(args.projects_dir).expanduser()
    codex_root = Path(args.codex_dir).expanduser()
    db = Path(args.db).expanduser()

    if args.latest:
        jsonl = latest_session_jsonl(Path(args.repo).resolve(), projects, codex_root)
        if not jsonl:
            print(f"no JSONL found for repo {args.repo}", file=sys.stderr)
            return 2
        fmt = detect_format(jsonl)
        session_id = session_id_for(jsonl, fmt)
    else:
        session_id = args.session
        jsonl = find_jsonl(session_id, projects, codex_root)
        if not jsonl:
            print(f"no JSONL for session {session_id}", file=sys.stderr)
            return 2
        fmt = detect_format(jsonl)

    turns, _ = parse_session(jsonl)
    if not turns:
        print(f"no usage events in {jsonl}", file=sys.stderr)
        return 3

    session_tasks = fetch_session_tasks(db, session_id)
    windows = build_windows(session_tasks, turns)
    suggestions = detect_patterns(windows, turns)

    if args.json:
        print(render_json(session_id, jsonl, windows, turns, suggestions))
    elif args.gain:
        print(render_gain(session_id, jsonl, windows, turns, suggestions))
    else:
        print(render_human(session_id, jsonl, windows, turns, suggestions))
    return 0


if __name__ == "__main__":
    sys.exit(main())
