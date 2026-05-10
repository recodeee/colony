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
    def cache_hit_ratio(self) -> float:
        cr = sum(t.cache_read for t in self.turns)
        cc = sum(t.cache_creation for t in self.turns)
        ip = sum(t.input_tokens for t in self.turns)
        denom = cr + cc + ip
        return cr / denom if denom else 0.0


# ---------------------------------------------------------------------------
# JSONL parsing
# ---------------------------------------------------------------------------


def find_jsonl(session_id: str, projects: Path) -> Path | None:
    matches = list(projects.glob(f"*/{session_id}.jsonl"))
    return matches[0] if matches else None


def latest_session_jsonl(repo_root: Path, projects: Path) -> Path | None:
    enc = "-" + str(repo_root).lstrip("/").replace("/", "-")
    candidates = list((projects / enc).glob("*.jsonl"))
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


def iso_to_ms(iso: str) -> int:
    iso = iso.replace("Z", "+00:00")
    return int(dt.datetime.fromisoformat(iso).timestamp() * 1000)


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


def fetch_claims(db: Path, session_id: str) -> list[tuple]:
    """Returns rows: (task_id, title, branch, file_path, claimed_at)."""
    if not db.exists():
        return []
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        rows = con.execute(
            """
            SELECT c.task_id, t.title, t.branch, c.file_path, c.claimed_at
            FROM task_claims c
            JOIN tasks t ON t.id = c.task_id
            WHERE c.session_id = ?
            ORDER BY c.claimed_at ASC
            """,
            (session_id,),
        ).fetchall()
    finally:
        con.close()
    return rows


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


def build_windows(claims: list[tuple], turns: list[Turn]) -> list[TaskWindow]:
    """A window opens at the first claim for a task and closes when the next
    claim names a *different* task. Pre-first-claim turns get bucketed into a
    synthetic 'uncategorized' window."""

    if not turns:
        return []
    end_ms = turns[-1].ts_ms + 1

    windows: list[TaskWindow] = []
    if not claims:
        windows.append(
            TaskWindow(
                task_id="—",
                title="(no Colony claims found in this session)",
                branch="—",
                start_ms=turns[0].ts_ms,
                end_ms=end_ms,
            )
        )
    else:
        first_claim_ms = min(c[4] for c in claims)
        if turns[0].ts_ms < first_claim_ms:
            windows.append(
                TaskWindow(
                    task_id="pre-claim",
                    title="(turns before first task_claim)",
                    branch="—",
                    start_ms=turns[0].ts_ms,
                    end_ms=first_claim_ms,
                )
            )

        # Group successive claims by task_id transitions
        ordered = sorted(claims, key=lambda r: r[4])
        current: TaskWindow | None = None
        for task_id, title, branch, file_path, claimed_at in ordered:
            if current is None or current.task_id != task_id:
                if current is not None:
                    current.end_ms = claimed_at
                    windows.append(current)
                current = TaskWindow(
                    task_id=task_id,
                    title=title or f"task #{task_id}",
                    branch=branch or "—",
                    start_ms=claimed_at,
                    end_ms=end_ms,
                    claimed_files=[file_path],
                )
            else:
                current.claimed_files.append(file_path)
        if current is not None:
            windows.append(current)

    for turn in turns:
        for w in windows:
            if w.start_ms <= turn.ts_ms < w.end_ms:
                w.turns.append(turn)
                break

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

    # 6. Pre-claim token spend (work happening before a task is claimed)
    pre = next((w for w in windows if w.task_id == "pre-claim"), None)
    if pre:
        share = pre.total_tokens / max(1, sum(w.total_tokens for w in windows))
        if share >= 0.30:
            suggestions.append(
                {
                    "kind": "no-claim-coverage",
                    "severity": "high" if share >= 0.60 else "med",
                    "task": "session-wide",
                    "detail": f"{share*100:.0f}% of tokens spent before any task_claim_file",
                    "fix": "Claim files earlier so attribution and ownership exist for the bulk of the session.",
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
    out.append(f"turns    {len(all_turns)}")
    out.append(f"tokens   {fmt_int(total)} total")
    if all_turns:
        first = dt.datetime.fromtimestamp(all_turns[0].ts_ms / 1000, dt.timezone.utc)
        last = dt.datetime.fromtimestamp(all_turns[-1].ts_ms / 1000, dt.timezone.utc)
        dur = (all_turns[-1].ts_ms - all_turns[0].ts_ms) / 1000 / 60
        out.append(f"window   {first.isoformat(timespec='seconds')} → {last.isoformat(timespec='seconds')}  ({dur:.1f} min)")

    out.append("")
    out.append("per-task")
    out.append(f"  {'task':<32}  {'turns':>5}  {'tokens':>8}  {'cache%':>6}  files")
    for w in sorted(windows, key=lambda x: x.total_tokens, reverse=True):
        if not w.turns:
            continue
        label = f"#{w.task_id} {w.title}"[:32]
        out.append(
            f"  {label:<32}  {len(w.turns):>5}  {fmt_int(w.total_tokens):>8}  "
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


def render_json(session_id: str, jsonl: Path, windows: list[TaskWindow], all_turns: list[Turn], suggestions: list[dict]) -> str:
    payload = {
        "session_id": session_id,
        "jsonl": str(jsonl),
        "turns": len(all_turns),
        "total_tokens": sum(t.total for t in all_turns),
        "tasks": [
            {
                "task_id": w.task_id,
                "title": w.title,
                "branch": w.branch,
                "turns": len(w.turns),
                "tokens": w.total_tokens,
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
    p.add_argument("--json", action="store_true", help="Emit JSON instead of human report")
    args = p.parse_args()

    projects = Path(args.projects_dir).expanduser()
    db = Path(args.db).expanduser()

    if args.latest:
        jsonl = latest_session_jsonl(Path(args.repo).resolve(), projects)
        if not jsonl:
            print(f"no JSONL found under {projects} for repo {args.repo}", file=sys.stderr)
            return 2
        session_id = jsonl.stem
    else:
        session_id = args.session
        jsonl = find_jsonl(session_id, projects)
        if not jsonl:
            print(f"no JSONL for session {session_id} under {projects}", file=sys.stderr)
            return 2

    turns = parse_jsonl(jsonl)
    if not turns:
        print(f"no assistant turns with usage in {jsonl}", file=sys.stderr)
        return 3

    claims = fetch_claims(db, session_id)
    windows = build_windows(claims, turns)
    suggestions = detect_patterns(windows, turns)

    if args.json:
        print(render_json(session_id, jsonl, windows, turns, suggestions))
    else:
        print(render_human(session_id, jsonl, windows, turns, suggestions))
    return 0


if __name__ == "__main__":
    sys.exit(main())
