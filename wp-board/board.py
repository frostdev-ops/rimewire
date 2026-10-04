"""Read the work-package tracker (docs/wp/README.md) and the spec files beside it.

Read-only: this module never writes to the repository and only runs read-only git commands.
Agent updates come from the journals described in `journal.py`.
"""

import os
import re
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

import journal

CLASSES = ("done", "active", "spec", "planned", "blocked", "aside")
COUNTED = ("done", "active", "spec", "planned", "blocked")

# Spec files that are packages (WP-1.2, WP-4.8b2a1, WP-W0.2a, WP-C3, P8b, C-P1). Design docs,
# `*.study.md`, `WP-2.43-freeze.md`, rulings and the README are not.
PACKAGE_FILE = re.compile(r"^(WP-(?=[A-Z0-9])[A-Z]{0,3}\d*(?:\.\d+)?[a-z0-9]*|P\d+[a-z]?|C-P\d+)\.md$")
LINK = re.compile(r"\[([^\]]*)\]\(([^)\s]+)\)")
SEPARATOR_CELL = re.compile(r"^:?-{3,}:?$")
DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
GIT_TIMEOUT = 3.0


def plain(text: str) -> str:
    """Markdown inline text with links, emphasis and code marks removed."""
    text = LINK.sub(r"\1", text)
    return text.replace("**", "").replace("`", "").strip()


def classify(status: str) -> str:
    s = plain(status).lower()
    if s.startswith("blocked"):
        return "blocked"
    if s.startswith(("split", "superseded", "cut", "(superseded")):
        return "aside"
    if s.startswith(("merged", "frozen", "design landed", "done", "landed")):
        return "done"
    if re.search(r"\bdone\b", s):
        return "done"
    if s.startswith(("delegated", "in review", "in progress", "review", "implementing")):
        return "active"
    if s.startswith("spec"):
        return "spec"
    return "planned"


def short_status(status: str) -> tuple[str, str]:
    """Split a status cell into its leading words and the rest (`merged (lead)` -> merged, lead)."""
    s = plain(status)
    m = re.match(r"^([^(;]*?)\s*[(;]\s*(.*?)\)?\s*$", s)
    if not m or not m.group(1):
        return s, ""
    return m.group(1).strip(), m.group(2).strip()


def split_row(line: str) -> list[str]:
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|") and not s.endswith("\\|"):
        s = s[:-1]
    cells: list[str] = []
    buf: list[str] = []
    in_code = False
    i = 0
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s) and s[i + 1] == "|":
            buf.append("|")
            i += 2
            continue
        if c == "`":
            in_code = not in_code
        if c == "|" and not in_code:
            cells.append("".join(buf).strip())
            buf = []
        else:
            buf.append(c)
        i += 1
    cells.append("".join(buf).strip())
    return cells


def is_separator(line: str) -> bool:
    if not line.strip().startswith("|"):
        return False
    cells = split_row(line)
    return bool(cells) and all(SEPARATOR_CELL.match(c.replace(" ", "")) for c in cells)


def empty(cell: str) -> bool:
    return plain(cell) in ("", "—", "-", "–")


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", plain(text).lower()).strip("-")[:48] or "lane"


def split_heading(text: str) -> tuple[str, str]:
    """`Phase 2 — E2 v0, started 2026-10-01` -> (`Phase 2 — E2 v0`, `started 2026-10-01`)."""
    text = plain(text)
    m = re.search(r"\s*\(([^()]*\d{4}-\d{2}-\d{2}[^()]*)\)", text)
    if m:
        return (text[: m.start()] + text[m.end() :]).strip(" ,"), m.group(1).strip()
    m = re.search(r",\s*(started\s+\d{4}-\d{2}-\d{2})\s*$", text)
    if m:
        return text[: m.start()].strip(" ,"), m.group(1)
    return text, ""


@dataclass
class Item:
    key: str
    id: str
    title: str
    status: str
    cls: str
    lane: str
    group: str = ""
    id_note: str = ""
    status_short: str = ""
    status_note: str = ""
    os: str = ""
    depends: str = ""
    branch: str = ""
    file: str = ""
    file_exists: bool = False
    fields: list = field(default_factory=list)
    tags: list = field(default_factory=list)
    h1: str = ""
    has_report: bool = False
    mtime: float | None = None
    worktree: dict | None = None
    in_flight: bool = False
    tracked: bool = True
    arrived_at: float | None = None
    changed_at: float | None = None
    previous_cls: str = ""
    agent: dict | None = None

    def as_dict(self) -> dict:
        return dict(self.__dict__)


@dataclass
class Lane:
    id: str
    title: str
    subtitle: str
    notes: list = field(default_factory=list)
    items: list = field(default_factory=list)


@dataclass
class Readme:
    lanes: list
    owner_actions: list
    links: set


def parse_readme(text: str) -> Readme:
    lines = text.splitlines()
    lanes: list[Lane] = []
    owner_actions: list[dict] = []
    links = {Path(href).name for _, href in LINK.findall(text) if href.endswith(".md")}
    lane: Lane | None = None
    group = ""
    seen_ids: dict[str, int] = {}
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("## "):
            title, subtitle = split_heading(line[3:])
            lane = Lane(id=slug(title), title=title, subtitle=subtitle)
            lanes.append(lane)
            group = ""
            i += 1
            continue
        if line.startswith("### "):
            group = plain(line[4:])
            i += 1
            continue
        if line.strip().startswith("|") and i + 1 < len(lines) and is_separator(lines[i + 1]):
            header = [plain(c).lower() for c in split_row(line)]
            i += 2
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(split_row(lines[i]))
                i += 1
            if lane is not None and any(h == "status" for h in header):
                for cells in rows:
                    item = row_item(header, cells, lane, group, seen_ids)
                    if item:
                        lane.items.append(item)
            continue
        check = re.match(r"^\s*- \[([ xX])\]\s+(.*)$", line)
        if check:
            body = [check.group(2)]
            i += 1
            while i < len(lines) and lines[i].startswith("  ") and lines[i].strip():
                body.append(lines[i].strip())
                i += 1
            owner_actions.append({"done": check.group(1) != " ", "text": " ".join(body)})
            continue
        if line.strip() and lane is not None and not re.match(r"^\s*([-*+]\s|\d+\.\s|\||#)", line):
            para = [line.strip()]
            i += 1
            while i < len(lines) and lines[i].strip() and not lines[i].startswith(("#", "|")):
                para.append(lines[i].strip())
                i += 1
            if len(lane.notes) < 3:
                lane.notes.append(" ".join(para))
            continue
        i += 1
    return Readme(lanes=[lane for lane in lanes if lane.items], owner_actions=owner_actions, links=links)


def row_item(header: list[str], cells: list[str], lane: Lane, group: str, seen_ids: dict) -> Item | None:
    if not cells or empty(cells[0]):
        return None
    cells = cells + [""] * (len(header) - len(cells))
    first = cells[0].strip()
    m = re.match(r"^\[([^\]]+)\]\(([^)\s]+)\)\s*(.*)$", first)
    if m:
        ident, href, rest = plain(m.group(1)), m.group(2), m.group(3).strip()
        file = Path(href).name if href.endswith(".md") and "/" not in href else ""
    else:
        parts = plain(first).split(None, 1)
        ident, rest, file = parts[0], (parts[1] if len(parts) > 1 else ""), ""
    columns: dict[str, str] = {}
    fields: list = []
    for name, cell in zip(header[1:], cells[1:]):
        if name in ("status", "title", "scope", "os", "depends on", "branch"):
            columns[name] = cell
        elif not empty(cell):
            fields.append([name, cell])
    status = columns.get("status", "").strip()
    title = columns.get("title") or columns.get("scope") or ""
    id_note = ""
    if title:
        id_note = plain(rest).strip("() ")
    else:
        title = rest
    count = seen_ids.get(ident, 0) + 1
    seen_ids[ident] = count
    key = ident if count == 1 else f"{ident}~{count}"
    s_short, s_note = short_status(status)
    haystack = f"{title} {status} {id_note}".lower()
    tags = []
    if "(lead" in haystack or "lead only" in haystack or id_note == "lead":
        tags.append("lead")
    if "owner-attended" in haystack:
        tags.append("owner-attended")
    branch = plain(columns.get("branch", ""))
    return Item(
        key=key,
        id=ident,
        title=title.strip(),
        status=status,
        cls=classify(status),
        lane=lane.id,
        group=group,
        id_note=id_note,
        status_short=s_short,
        status_note=s_note,
        os="" if empty(columns.get("os", "")) else plain(columns["os"]),
        depends="" if empty(columns.get("depends on", "")) else columns["depends on"].strip(),
        branch="" if empty(branch) else branch,
        file=file,
        fields=fields,
        tags=tags,
    )


@dataclass
class Spec:
    h1: str = ""
    why: str = ""
    meta: list = field(default_factory=list)
    report_title: str = ""
    report: str = ""
    status: str = ""

    @property
    def has_report(self) -> bool:
        return bool(self.report_title)


def paragraphs(lines: list[str]) -> list[str]:
    out, buf = [], []
    for line in lines:
        if line.strip():
            buf.append(line.strip())
        elif buf:
            out.append(" ".join(buf))
            buf = []
    if buf:
        out.append(" ".join(buf))
    return out


def parse_spec(text: str) -> Spec:
    spec = Spec()
    lines = text.splitlines()
    sections: list[tuple[str, list[str]]] = [("", [])]
    in_fence = False
    for line in lines:
        if line.startswith("```"):
            in_fence = not in_fence
        if not in_fence and line.startswith("# ") and not spec.h1:
            spec.h1 = line[2:].strip()
            continue
        if not in_fence and not spec.h1 and len(sections) == 1 and re.match(r"^#{3,6} ", line):
            spec.h1 = line.lstrip("#").strip()
            continue
        if not in_fence and line.startswith("## "):
            sections.append((line[3:].strip(), []))
            continue
        sections[-1][1].append(line)
    preamble = sections[0][1]
    for line in preamble:
        m = re.match(r"^- \*\*([^*]+?):?\*\*:?\s*(.*)$", line)
        if m:
            spec.meta.append([m.group(1).rstrip(":").strip(), m.group(2).strip()])
        elif line.startswith("  ") and spec.meta and line.strip():
            spec.meta[-1][1] += " " + line.strip()
    status = re.search(r"\*\*Status:?\*\*:?\s*([^\n*]+)|\*\*Status:\s*([^*]+)\*\*", "\n".join(preamble))
    if status:
        spec.status = (status.group(1) or status.group(2) or "").strip(" .")
    for name, value in spec.meta:
        if name.lower() == "status" and not spec.status:
            spec.status = plain(value)
        if name.lower() in ("goal", "why") and not spec.why:
            spec.why = value
    paras = [p for p in paragraphs(preamble) if not p.startswith(("-", "|", "```", "*   "))]
    for p in paras:
        if spec.why:
            break
        if re.match(r"^\*\*(Why|Goal)[.:]?\*\*", p):
            spec.why = p
            break
    if not spec.why:
        for name, body in sections[1:]:
            if re.match(r"^(why|goal)\b", name.lower()):
                found = [p for p in paragraphs(body) if not p.startswith(("|", "```"))]
                if found:
                    spec.why = found[0]
                    break
    if not spec.why and paras:
        spec.why = re.sub(r"^\*\*Status:[^*]*\*\*\s*", "", paras[0])
    for name, body in sections[1:]:
        if name.lower().startswith("report"):
            spec.report_title = name
            spec.report = "\n\n".join(paragraphs(body)[:2])
    return spec


def git(repo: Path, *args: str, cwd: Path | None = None) -> str | None:
    try:
        out = subprocess.run(
            ["git", "--no-optional-locks", *args],
            cwd=cwd or repo,
            capture_output=True,
            text=True,
            timeout=GIT_TIMEOUT,
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout if out.returncode == 0 else None


def worktrees(repo: Path) -> list[dict]:
    out = git(repo, "worktree", "list", "--porcelain")
    if not out:
        return []
    entries, cur = [], {}
    for line in out.splitlines() + [""]:
        if not line:
            if cur.get("path") and Path(cur["path"]) != repo:
                entries.append(cur)
            cur = {}
        elif line.startswith("worktree "):
            cur["path"] = line[9:]
            cur["name"] = Path(line[9:]).name
        elif line.startswith("branch "):
            cur["branch"] = line[7:].removeprefix("refs/heads/")
        elif line.startswith("HEAD "):
            cur["head"] = line[5:12]
    return entries


def match_worktree(item: Item, trees: list[dict]) -> dict | None:
    short = item.id.lower().removeprefix("wp-")
    for wt in trees:
        if item.branch and wt.get("branch") == item.branch:
            return wt
    for wt in trees:
        if wt["name"].lower() == item.id.lower():
            return wt
    for wt in trees:
        m = re.match(r"^(?:wp|spike)/([^-/]+)-", wt.get("branch", ""))
        if m and m.group(1).lower() == short:
            return wt
    return None


def commits(repo: Path, count: int = 14) -> list[dict]:
    out = git(repo, "log", f"-n{count}", "--format=%h%x1f%ct%x1f%s", "master", "--")
    if out is None:
        out = git(repo, "log", f"-n{count}", "--format=%h%x1f%ct%x1f%s", "HEAD", "--") or ""
    result = []
    for line in out.splitlines():
        parts = line.split("\x1f")
        if len(parts) == 3:
            result.append({"sha": parts[0], "time": int(parts[1]), "subject": parts[2]})
    return result


def totals(items: list[Item]) -> dict:
    t = {c: 0 for c in CLASSES}
    for item in items:
        t[item.cls] += 1
    t["items"] = len(items)
    t["counted"] = sum(t[c] for c in COUNTED)
    t["percent"] = round(100.0 * t["done"] / t["counted"], 1) if t["counted"] else 0.0
    return t


# ---------- roadmap ----------

# Platform buckets for a row's OS cell. Parentheticals are dropped first, so
# "Windows (model, Linux-tested)" counts for Windows only.
PLATFORMS = (
    ("linux", "Linux"),
    ("macos", "macOS"),
    ("windows", "Windows"),
    ("shared", "OS-free / shared"),
)
OS_TOKENS = {
    "linux": ("linux",),
    "hyprland": ("linux",),
    "macos": ("macos",),
    "mac": ("macos",),
    "windows": ("windows",),
    "both": ("linux", "macos"),
}
# Fewer counted rows than this and a platform shows its note instead of a headline percent.
FEW_ROWS = 10
# Static: not derivable from the tracker. Windows is Phase 3 (docs/plan 01 D1/D3, docs/wp/PHASE3.md):
# only cross-compiled groundwork exists until a Windows machine does.
PLATFORM_NOTES = {
    "windows": "Phase 3. Only cross-compiled groundwork (W0) exists; the P9 spikes and all runtime "
    "work wait for a Windows machine.",
}

# Installer Tier 2 packages (docs/wp/INSTALLER-rulings.md R7). Every other installer row is Tier 1.
INSTALLER_TIER2 = re.compile(r"^WP-4\.(5b|5c|10|11|17|18)(?![0-9])")

# Phases and tracks in roadmap order. `lane` is a regex on lane titles; a matched lane's completion
# decides the state. Rows with `state` are static (from docs/plan/07-roadmap.md, docs/wp/MVP-gate.md,
# docs/wp/PHASE3.md, DRAG-v0.md, AUDIO-v0.md, INSTALLER-rulings.md) and carry no invented numbers.
MILESTONES = (
    {"id": "phase-0", "kind": "phase", "title": "Phase 0: foundations and risk spikes", "lane": r"^Phase 0\b"},
    {"id": "phase-1", "kind": "phase", "title": "Phase 1: secure link and E1 input sharing", "lane": r"^Phase 1\b"},
    {"id": "phase-2", "kind": "phase", "title": "Phase 2: E2 window projection (2a Hyprland → Mac, 2b Mac → Hyprland)", "lane": r"^Phase 2\b"},
    {
        "id": "mvp-gate",
        "kind": "phase",
        "title": "MVP gate: 05 scenarios 1–6 on the live pair",
        "state": "active",
        "note": "Owner-attended checklist in MVP-gate.md; the lead's unattended runs pass.",
        "doc": "MVP-gate.md",
    },
    {
        "id": "phase-3",
        "kind": "phase",
        "title": "Phase 3: Windows and MVP+ features",
        "lane": r"^Phase 3\b",
        "state": "active",
        "note": "Lane A (clipboard, three nodes, drag) and Windows groundwork run now; Windows E1/E2/parking wait for a Windows machine (P9).",
        "doc": "PHASE3.md",
    },
    {"id": "phase-4", "kind": "phase", "title": "Phase 4: GNOME / KDE (portals), other wlroots, X11", "state": "later"},
    {"id": "phase-5", "kind": "phase", "title": "Phase 5: advanced media and features (M4 hosted apps, HDR, …)", "state": "later"},
    {"id": "installer-t1", "kind": "track", "title": "Installer Tier 1: fresh Mac and Hyprland end fully working", "lane": r"^Installer\b", "filter": "tier1"},
    {
        "id": "installer-t2",
        "kind": "track",
        "title": "Installer Tier 2: distribution (DMG, Developer ID, Arch package, firewalld)",
        "lane": r"^Installer\b",
        "filter": "tier2",
        "state": "later",
        "note": "Starts after Tier 1 passes its attended gates (INSTALLER-rulings.md).",
    },
    {"id": "drag-v0a", "kind": "track", "title": "DRAG v0-a: drags that start on the seat", "lane": r"DRAG-v0"},
    {
        "id": "drag-v0b",
        "kind": "track",
        "title": "DRAG v0-b: drags that start on the peer",
        "state": "later",
        "note": "Specified after v0-a's exit (DRAG-v0.md §6).",
    },
    {"id": "audio-speakers", "kind": "track", "title": "Shared audio v0: speakers (D8)", "lane": r"audio"},
    {
        "id": "audio-mic",
        "kind": "track",
        "title": "Shared audio: microphones",
        "state": "later",
        "note": "Refused in v0 until indicator visibility and virtual-mic reset are designed (AUDIO-v0.md).",
    },
)


def platforms_of(os_cell: str) -> set[str]:
    """The platform buckets a row's OS cell names. Several OSes count toward each one."""
    text = re.sub(r"\([^)]*\)", " ", plain(os_cell).lower())
    found: set[str] = set()
    other = False
    for token in re.split(r"[^a-z0-9-]+", text):
        if not token:
            continue
        if token in OS_TOKENS:
            found.update(OS_TOKENS[token])
        elif token not in ("compile", "tested", "cross", "model"):
            other = True
    if other or not found:
        found.add("shared")
    return found


def next_rows(items: list[Item], limit: int = 3) -> list[dict]:
    """The first unfinished rows: active ones first, then tracker order."""
    open_items = [i for i in items if i.cls not in ("done", "aside")]
    open_items.sort(key=lambda i: 0 if i.cls == "active" else 1)
    return [
        {"key": i.key, "id": i.id, "title": i.title, "cls": i.cls, "status_short": i.status_short}
        for i in open_items[:limit]
    ]


def lane_state(t: dict) -> str:
    if t["counted"] and t["done"] == t["counted"]:
        return "done"
    if t["done"] or t["active"]:
        return "active"
    return "next"


def roadmap(lanes: list[Lane]) -> dict:
    items = [i for lane in lanes for i in lane.items]
    platforms = []
    for pid, label in PLATFORMS:
        rows = [i for i in items if pid in platforms_of(i.os)]
        t = totals(rows)
        platforms.append(
            {
                "id": pid,
                "label": label,
                "totals": t,
                "few": t["counted"] < FEW_ROWS,
                "unlabelled": sum(1 for i in rows if empty(i.os)) if pid == "shared" else 0,
                "note": PLATFORM_NOTES.get(pid, ""),
                "next": next_rows(rows),
            }
        )
    workstreams = [
        {"id": lane.id, "title": lane.title, "totals": totals(lane.items), "next": next_rows(lane.items)}
        for lane in lanes
    ]
    milestones = []
    for m in MILESTONES:
        lane = next((ln for ln in lanes if m.get("lane") and re.search(m["lane"], ln.title, re.I)), None)
        rows = lane.items if lane else []
        if m.get("filter") == "tier1":
            rows = [i for i in rows if not INSTALLER_TIER2.match(i.id)]
        elif m.get("filter") == "tier2":
            rows = [i for i in rows if INSTALLER_TIER2.match(i.id)]
        t = totals(rows) if rows else None
        state = m.get("state") or (lane_state(t) if t else "later")
        milestones.append(
            {
                "id": m["id"],
                "kind": m["kind"],
                "title": m["title"],
                "state": state,
                "derived": "state" not in m and t is not None,
                "lane": lane.id if lane and rows else "",
                "totals": t,
                "note": m.get("note", ""),
                "doc": m.get("doc", ""),
                "next": next_rows(rows) if state != "done" else [],
            }
        )
    return {"platforms": platforms, "workstreams": workstreams, "milestones": milestones}


def build(repo: Path, with_git: bool = True) -> dict:
    """One snapshot of the board. `with_git=False` skips worktrees and commits (tests)."""
    wp_dir = repo / "docs" / "wp"
    readme_path = wp_dir / "README.md"
    readme = parse_readme(readme_path.read_text(encoding="utf-8"))
    files = {p.name: p for p in wp_dir.glob("*.md")}
    trees = worktrees(repo) if with_git else []

    tracked_ids = set()
    all_items: list[Item] = []
    for lane in readme.lanes:
        for item in lane.items:
            tracked_ids.add(item.id)
            if not item.file and f"{item.id}.md" in files:
                item.file = f"{item.id}.md"
            all_items.append(item)

    untracked: list[Item] = []
    for name in sorted(files):
        if not PACKAGE_FILE.match(name) or name in readme.links:
            continue
        ident = name[:-3]
        if ident in tracked_ids:
            continue
        untracked.append(
            Item(
                key=ident,
                id=ident,
                title="",
                status="not in the tracker",
                cls="planned",
                lane="untracked",
                status_short="not in the tracker",
                file=name,
                tracked=False,
            )
        )

    for item in all_items + untracked:
        path = files.get(item.file) if item.file else None
        if path is not None:
            item.file_exists = True
            try:
                stat = path.stat()
                item.mtime = stat.st_mtime
                spec = parse_spec(path.read_text(encoding="utf-8", errors="replace"))
            except OSError:
                spec = Spec()
            item.h1 = spec.h1
            item.has_report = spec.has_report
            if not item.tracked:
                item.title = re.sub(r"^[\w.\-]+(\s*\([^)]*\))?\s*[:—-]\s*", "", spec.h1) or spec.h1
                if spec.has_report:
                    item.status_short = "report filed"
                    item.cls = "done"
                elif spec.status:
                    item.status = spec.status
                    item.status_short, item.status_note = short_status(spec.status)
                    item.cls = classify(spec.status)
        wt = match_worktree(item, trees) if trees else None
        if wt:
            item.worktree = {"name": wt["name"], "branch": wt.get("branch", ""), "head": wt.get("head", "")}
            if not item.branch and wt.get("branch"):
                item.branch = wt["branch"]
        item.in_flight = item.cls == "active" or (wt is not None and item.cls not in ("done", "aside"))

    updates = journal.read_all(repo, [Path(wt["path"]) for wt in trees])
    summary = journal.summarize(updates)
    for item in all_items + untracked:
        item.agent = summary.get(item.id)
        # A merged package can't still be blocked: a retry outside the drain posts no unblock.
        if item.agent and item.cls == "done" and item.agent.get("blocker"):
            item.agent = {**item.agent, "blocker": None}

    recent = sorted(
        (i for i in all_items + untracked if i.mtime),
        key=lambda i: i.mtime or 0,
        reverse=True,
    )[:10]

    lanes_out = []
    for lane in readme.lanes:
        lanes_out.append(
            {
                "id": lane.id,
                "title": lane.title,
                "subtitle": lane.subtitle,
                "notes": lane.notes,
                "totals": totals(lane.items),
                "items": [i.as_dict() for i in lane.items],
            }
        )
    readme_stat = readme_path.stat()
    return {
        "generated": time.time(),
        "readme_mtime": readme_stat.st_mtime,
        "totals": totals(all_items),
        "lanes": lanes_out,
        "roadmap": roadmap(readme.lanes),
        "untracked": [i.as_dict() for i in untracked],
        "owner_actions": readme.owner_actions,
        "docs": sorted(files),
        "recent": [{"key": i.key, "id": i.id, "mtime": i.mtime, "file": i.file} for i in recent],
        "commits": commits(repo) if with_git else [],
        "activity": updates[::-1][:24],
        "activity_total": len(updates),
    }


def every_item(board: dict):
    for lane in board["lanes"]:
        yield from lane["items"]
    yield from board["untracked"]


def find(board: dict, key: str) -> dict | None:
    return next((i for i in every_item(board) if i["key"] == key), None)


def detail(repo: Path, board: dict, key: str) -> dict | None:
    """The card's spec excerpt, full markdown and git state. Only keys on the board are served."""
    item = find(board, key)
    if item is None:
        return None
    out: dict = {"item": item, "spec": None, "markdown": "", "source": "", "git": None}
    checkouts = [repo / ".worktrees" / item["worktree"]["name"]] if item["worktree"] else []
    out["updates"] = [n for n in journal.read_all(repo, checkouts) if n["wp"] == item["id"]][::-1]
    candidates = []
    if item["file"]:
        candidates.append(("docs/wp", repo / "docs" / "wp" / item["file"]))
        if item["worktree"]:
            wt_root = repo / ".worktrees" / item["worktree"]["name"]
            candidates.append((f".worktrees/{item['worktree']['name']}", wt_root / "docs" / "wp" / item["file"]))
    for source, path in candidates:
        if path.is_file():
            text = path.read_text(encoding="utf-8", errors="replace")
            spec = parse_spec(text)
            out["spec"] = spec.__dict__ | {"has_report": spec.has_report}
            out["markdown"] = text
            out["source"] = f"{source}/{item['file']}"
            break
    branch = item.get("branch") or ""
    if branch and not branch.startswith("-") and re.match(r"^[\w./\-]+$", branch):
        info: dict = {"branch": branch}
        log = git(repo, "log", "-1", "--format=%h%x1f%ct%x1f%s", branch, "--")
        if log and "\x1f" in log:
            sha, ts, subject = log.strip().split("\x1f", 2)
            info["last"] = {"sha": sha, "time": int(ts), "subject": subject}
            ahead = git(repo, "rev-list", "--count", f"master..{branch}", "--")
            if ahead is not None and ahead.strip().isdigit():
                info["ahead"] = int(ahead.strip())
        if item["worktree"]:
            wt_path = repo / ".worktrees" / item["worktree"]["name"]
            status = git(repo, "status", "--porcelain", cwd=wt_path) if wt_path.is_dir() else None
            if status is not None:
                info["dirty"] = len([line for line in status.splitlines() if line.strip()])
        out["git"] = info
    return out


def signature(repo: Path) -> tuple:
    """Changes when any tracker input changes: docs/wp files, worktrees, or master."""
    parts = []
    wp_dir = repo / "docs" / "wp"
    try:
        with os.scandir(wp_dir) as it:
            for entry in it:
                if entry.name.endswith(".md"):
                    st = entry.stat()
                    parts.append((entry.name, st.st_mtime_ns, st.st_size))
    except OSError:
        pass
    git_dir = repo / ".git"
    for rel in ("refs/heads/master", "packed-refs", "HEAD"):
        try:
            parts.append((rel, (git_dir / rel).stat().st_mtime_ns))
        except OSError:
            pass
    try:
        parts.append(("worktrees", tuple(sorted(os.listdir(git_dir / "worktrees")))))
    except OSError:
        pass
    parts += journal.signature_parts(repo)
    return tuple(sorted(parts, key=lambda p: p[0]))
