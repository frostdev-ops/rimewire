"""Agent updates on work packages: notes, progress, blockers and hand-offs.

Each checkout (the main repo or a worktree) keeps an append-only journal at
`target/wp-notes/notes.jsonl`, one JSON object per line. `target/` is gitignored on every branch
and is inside the checkout, so sandboxed workers without network can write their own journal. The
board reads the main repo's journal and every worktree's, and merges them by time.
"""

import fcntl
import json
import os
import re
import secrets
import time
from pathlib import Path

KINDS = ("note", "progress", "blocker", "unblock", "ready")
WP_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$")
MAX_TEXT = 4000
MAX_AUTHOR = 64
JOURNAL_DIR = Path("target") / "wp-notes"
JOURNAL_NAME = "notes.jsonl"


def make(wp: str, kind: str, text: str, percent: int | None = None, author: str = "") -> dict:
    """A validated update. Raises ValueError with a message meant for the caller."""
    wp = (wp or "").strip()
    if not WP_ID.match(wp):
        raise ValueError(f"not a work-package id: {wp!r}")
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {', '.join(KINDS)}")
    text = (text or "").strip()
    if not text and kind in ("note", "blocker"):
        raise ValueError(f"a {kind} needs text")
    if len(text) > MAX_TEXT:
        raise ValueError(f"text is longer than {MAX_TEXT} characters")
    if percent is not None:
        if isinstance(percent, bool) or not isinstance(percent, int) or not 0 <= percent <= 100:
            raise ValueError("percent must be a whole number from 0 to 100")
        if kind not in ("progress", "ready"):
            raise ValueError("only progress and ready updates carry a percent")
    author = (author or "").strip()[:MAX_AUTHOR] or "agent"
    return {
        "id": secrets.token_hex(8),
        "wp": wp,
        "kind": kind,
        "text": text,
        "percent": percent,
        "author": author,
        "time": round(time.time(), 3),
    }


def journal_path(checkout: Path) -> Path:
    return checkout / JOURNAL_DIR / JOURNAL_NAME


def append(checkout: Path, note: dict) -> Path:
    """Append one update to the checkout's journal; safe against concurrent writers."""
    path = journal_path(checkout)
    path.parent.mkdir(parents=True, exist_ok=True)
    line = (json.dumps(note, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        os.write(fd, line)
    finally:
        os.close(fd)
    return path


def clean(raw, source: str) -> dict | None:
    """One journal line as served to the page, or None when it isn't a usable update."""
    if not isinstance(raw, dict):
        return None
    wp, kind, ts = raw.get("wp"), raw.get("kind"), raw.get("time")
    if not isinstance(wp, str) or not WP_ID.match(wp) or not isinstance(ts, (int, float)):
        return None
    percent = raw.get("percent")
    if isinstance(percent, bool) or not isinstance(percent, int) or not 0 <= percent <= 100:
        percent = None
    note_id = raw.get("id")
    return {
        "id": note_id if isinstance(note_id, str) and note_id else f"{source}:{ts}:{wp}",
        "wp": wp,
        "kind": kind if kind in KINDS else "note",
        "text": str(raw.get("text") or "")[:MAX_TEXT],
        "percent": percent,
        "author": str(raw.get("author") or "agent")[:MAX_AUTHOR],
        "time": float(ts),
        "source": source,
    }


def read_journal(path: Path, source: str) -> list[dict]:
    """Every usable line; malformed or half-written lines are skipped."""
    try:
        data = path.read_bytes()
    except OSError:
        return []
    out = []
    for line in data.splitlines():
        try:
            note = clean(json.loads(line), source)
        except (ValueError, UnicodeDecodeError):
            continue
        if note is not None:
            out.append(note)
    return out


def journals(repo: Path, checkouts: list[Path] = ()) -> list[tuple[str, Path]]:
    """(source, journal) for the main repo, `.worktrees/*`, and any other worktree paths given."""
    found: dict[Path, str] = {}
    main = journal_path(repo)
    if main.is_file():
        found[main.resolve()] = "main"
    roots = list(checkouts)
    try:
        roots += [p for p in (repo / ".worktrees").iterdir() if p.is_dir()]
    except OSError:
        pass
    for root in roots:
        path = journal_path(root)
        if path.is_file():
            found.setdefault(path.resolve(), root.name)
    return [(source, path) for path, source in found.items()]


def read_all(repo: Path, checkouts: list[Path] = ()) -> list[dict]:
    """All updates from every journal, oldest first, each id once."""
    seen: dict[str, dict] = {}
    for source, path in journals(repo, checkouts):
        for note in read_journal(path, source):
            seen.setdefault(note["id"], note)
    return sorted(seen.values(), key=lambda n: n["time"])


def summarize(notes: list[dict]) -> dict[str, dict]:
    """Per work package: the latest progress, an open blocker, a ready hand-off, and counts.

    `notes` must be oldest first. A blocker stays open until an unblock or a ready; a ready is
    cleared by later progress or a later blocker.
    """
    out: dict[str, dict] = {}
    for n in notes:
        s = out.setdefault(
            n["wp"],
            {"count": 0, "percent": None, "step": "", "blocker": None, "ready": None, "last": None, "authors": []},
        )
        s["count"] += 1
        s["last"] = {k: n[k] for k in ("kind", "text", "author", "time", "percent")}
        if n["author"] not in s["authors"]:
            s["authors"].append(n["author"])
        if n["kind"] == "progress":
            if n["percent"] is not None:
                s["percent"] = n["percent"]
            if n["text"]:
                s["step"] = n["text"]
            s["ready"] = None
        elif n["kind"] == "blocker":
            s["blocker"] = {k: n[k] for k in ("text", "author", "time")}
            s["ready"] = None
        elif n["kind"] == "unblock":
            s["blocker"] = None
        elif n["kind"] == "ready":
            s["ready"] = {k: n[k] for k in ("text", "author", "time")}
            s["blocker"] = None
            s["percent"] = n["percent"] if n["percent"] is not None else 100
    return out


def signature_parts(repo: Path) -> list[tuple]:
    """Size and mtime of every journal, so the board notices new updates."""
    parts = []
    for source, path in journals(repo):
        try:
            st = path.stat()
        except OSError:
            continue
        parts.append((f"journal:{source}", st.st_mtime_ns, st.st_size))
    return parts
