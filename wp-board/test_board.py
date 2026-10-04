"""Tests for the board parser: `python -m unittest scripts/wp-board/test_board.py`."""

import sys

sys.dont_write_bytecode = True

import re  # noqa: E402
import shutil  # noqa: E402
import tempfile  # noqa: E402
import unittest  # noqa: E402
from pathlib import Path  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
import board  # noqa: E402

REPO = Path(__file__).resolve().parent.parent.parent
README = REPO / "docs" / "wp" / "README.md"

SAMPLE = """# Work-package tracker

## Phase 3 — Windows and MVP+ features ([PHASE3](PHASE3.md)), started 2026-10-03

| WP | Title | OS | Depends on | Status | Branch |
|---|---|---|---|---|---|
| [WP-W0.1](WP-W0.1.md) | `crosspane-platform-windows` skeleton | Windows (cross) | — | merged | — |
| [WP-W0.2a](WP-W0.2a.md) | WinEvent → `WindowEvent` table | Windows (model, Linux-tested) | W0.1 | delegated | `wp/W0.2a-winevent` |
| WP-P2 | Protocol: strict varint ranges | any | — | planned (low priority) | — |
| [WP-4.8](WP-4.8.md) | Linux support and dependency detection | Linux | 4.7 | split (4.8a/b/c) | — |
| WP-2.16 (lead) | Cursor shapes | OS-free + agent | 2.14 | merged | — |

**MVP gate (2026-10-03):** the owner's checklist is in
[MVP-gate](MVP-gate.md).

### Schedule

| Wk | Lead | Owner |
|---|---|---|
| 1 | Repo | Mac setup |
"""


def status_tables(text: str) -> list[int]:
    """Row counts of every README table with a Status column under a `##` lane."""
    lines = text.splitlines()
    counts, in_lane = [], False
    for i, line in enumerate(lines):
        if line.startswith("## "):
            in_lane = True
        if not (in_lane and line.startswith("|") and i + 1 < len(lines) and board.is_separator(lines[i + 1])):
            continue
        header = [board.plain(c).lower() for c in board.split_row(line)]
        if "status" not in header:
            continue
        n = 0
        for row in lines[i + 2 :]:
            if not row.startswith("|"):
                break
            n += 1
        counts.append(n)
    return counts


class RealReadme(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = README.read_text(encoding="utf-8")
        cls.readme = board.parse_readme(cls.text)
        cls.items = {i.key: i for lane in cls.readme.lanes for i in lane.items}

    def test_every_status_table_yields_rows(self):
        tables = status_tables(self.text)
        self.assertTrue(tables)
        self.assertTrue(all(n > 0 for n in tables), tables)
        self.assertEqual(sum(tables), sum(len(lane.items) for lane in self.readme.lanes))
        for lane in self.readme.lanes:
            self.assertTrue(lane.items, lane.title)

    def test_schedule_table_is_not_a_package_table(self):
        self.assertFalse(any(i.id.isdigit() for i in self.items.values()))

    def test_foundation_wp_is_done(self):
        self.assertEqual(self.items["WP-0.1"].cls, "done")
        self.assertEqual(self.items["WP-0.1"].file, "WP-0.1.md")

    def test_split_parents_are_aside(self):
        splits = [i for i in self.items.values() if board.plain(i.status).lower().startswith(("split", "superseded", "cut"))]
        self.assertTrue(splits)
        self.assertTrue(all(i.cls == "aside" for i in splits))

    def test_every_row_has_a_known_class(self):
        for item in self.items.values():
            self.assertIn(item.cls, board.CLASSES, item.key)

    def test_real_board_builds_without_git(self):
        snapshot = board.build(REPO, with_git=False)
        t = snapshot["totals"]
        self.assertEqual(t["items"], sum(len(lane["items"]) for lane in snapshot["lanes"]))
        self.assertEqual(t["counted"], t["items"] - t["aside"])
        self.assertGreater(t["percent"], 0)


class Sample(unittest.TestCase):
    def setUp(self):
        self.readme = board.parse_readme(SAMPLE)
        self.items = {i.key: i for lane in self.readme.lanes for i in lane.items}

    def test_delegated_row_is_active_with_branch(self):
        w = self.items["WP-W0.2a"]
        self.assertEqual(w.cls, "active")
        self.assertEqual(w.branch, "wp/W0.2a-winevent")
        self.assertEqual(w.os, "Windows (model, Linux-tested)")
        self.assertEqual(w.depends, "W0.1")

    def test_plain_ids_and_notes(self):
        self.assertEqual(self.items["WP-P2"].cls, "planned")
        self.assertEqual(self.items["WP-P2"].status_short, "planned")
        self.assertEqual(self.items["WP-P2"].status_note, "low priority")
        self.assertEqual(self.items["WP-2.16"].id_note, "lead")
        self.assertIn("lead", self.items["WP-2.16"].tags)

    def test_split_is_aside_and_lane_heading_is_split(self):
        self.assertEqual(self.items["WP-4.8"].cls, "aside")
        lane = self.readme.lanes[0]
        self.assertEqual(lane.title, "Phase 3 — Windows and MVP+ features (PHASE3)")
        self.assertEqual(lane.subtitle, "started 2026-10-03")
        self.assertTrue(lane.notes[0].startswith("**MVP gate"))
        self.assertIn("MVP-gate.md", self.readme.links)
        self.assertEqual(len(self.readme.lanes), 1)

    def test_classify(self):
        cases = {
            "merged (lead)": "done",
            "frozen (lead)": "done",
            "design landed": "done",
            "speaker v0 done (all packages merged)": "done",
            "delegated": "active",
            "in review": "active",
            "spec'd": "spec",
            "planned": "planned",
            "to spec after P8b": "planned",
            "blocked (owner)": "blocked",
            "split (4.8a/b/c)": "aside",
            "superseded": "aside",
            "cut": "aside",
        }
        for status, cls in cases.items():
            self.assertEqual(board.classify(status), cls, status)

    def test_split_row_keeps_pipes_in_code(self):
        self.assertEqual(board.split_row("| a | `x | y` | c |"), ["a", "`x | y`", "c"])


class NewSpecFiles(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="wp-board-"))
        shutil.copytree(REPO / "docs" / "wp", self.tmp / "docs" / "wp")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def untracked(self):
        return {i["key"]: i for i in board.build(self.tmp, with_git=False)["untracked"]}

    def test_new_file_is_reported(self):
        self.assertNotIn("WP-ZZ", self.untracked())
        (self.tmp / "docs" / "wp" / "WP-ZZ.md").write_text("# WP-ZZ — A new package\n\n**Why.** Testing.\n")
        found = self.untracked()
        self.assertIn("WP-ZZ", found)
        self.assertEqual(found["WP-ZZ"]["title"], "A new package")
        self.assertFalse(found["WP-ZZ"]["tracked"])

    def test_design_docs_are_not_packages(self):
        for name in ("README.md", "WP-2.62.study.md", "WP-2.43-freeze.md", "E2-v0.md", "INSTALLER-rulings.md"):
            self.assertIsNone(board.PACKAGE_FILE.match(name), name)
        for name in ("WP-1.2.md", "WP-4.8b2a1.md", "WP-W0.2a.md", "WP-C3.md", "P8b.md", "C-P1.md", "WP-ZZ.md"):
            self.assertIsNotNone(board.PACKAGE_FILE.match(name), name)

    def test_signature_changes_with_a_new_file(self):
        before = board.signature(self.tmp)
        (self.tmp / "docs" / "wp" / "WP-ZZ.md").write_text("# WP-ZZ\n")
        self.assertNotEqual(before, board.signature(self.tmp))


class SpecExcerpt(unittest.TestCase):
    def test_why_meta_and_report(self):
        spec = board.parse_spec(
            "# WP-9.9 — Example\n\n**Why.** Because.\n\n- **Branch:** `wp/9.9-x`\n- **Timebox:** 1 day.\n\n"
            "## Acceptance\n\nRun it.\n\n## Report (merged 2026-10-03)\n\nIt merged.\n"
        )
        self.assertEqual(spec.h1, "WP-9.9 — Example")
        self.assertEqual(spec.why, "**Why.** Because.")
        self.assertEqual(spec.meta[0], ["Branch", "`wp/9.9-x`"])
        self.assertEqual(spec.report_title, "Report (merged 2026-10-03)")
        self.assertEqual(spec.report, "It merged.")
        self.assertTrue(spec.has_report)

    def test_heading_fallback_and_goal_bullet(self):
        spec = board.parse_spec("### WP-2.5b — engine fixes\n\n- **Goal:** fix the findings.\n")
        self.assertEqual(spec.h1, "WP-2.5b — engine fixes")
        self.assertEqual(spec.why, "fix the findings.")

    def test_status_line(self):
        spec = board.parse_spec("# WP-W0.2 — models\n\n**Status: spec'd (lead, 2026-10-03).** Body.\n")
        self.assertEqual(board.classify(spec.status), "spec")
        self.assertTrue(re.match(r"^Body", spec.why))


ROADMAP_SAMPLE = """# Work-package tracker

## Phase 1 (started 2026-10-01)

| WP | Title | OS | Depends on | Status | Branch |
|---|---|---|---|---|---|
| WP-1.1 | Codec | OS-free | — | merged | — |
| WP-1.2 | Hyprland capture | Hyprland | — | merged | — |

## Drag across the boundary (DRAG-v0), started 2026-10-03

| WP | Title | OS | Depends on | Status | Branch |
|---|---|---|---|---|---|
| WP-2.55 | Hyprland seat | Linux | — | merged | — |
| WP-2.56 | macOS seat | macOS | — | delegated | `wp/2.56` |
| WP-2.58 | Agent wiring | Linux + agent | — | planned | — |
| WP-2.59 | Both seats | both | — | spec'd | — |
| WP-W0.2a | WinEvent table | Windows (model, Linux-tested) | — | merged | — |
| WP-2.60 | Old plan | Linux, macOS | — | superseded | — |

## Installer (WP-4.x)

| WP | Scope | OS | Depends on | Status | Branch |
|---|---|---|---|---|---|
| WP-4.1 | Core | OS-free | — | merged | — |
| WP-4.19 | Linux repair | Linux | — | in progress: 4.19a merged | — |
| WP-4.17 | Arch package | Linux | — | planned | — |
| WP-4.18 | DMG and notarization | macOS | — | planned | — |
"""


class Roadmap(unittest.TestCase):
    def setUp(self):
        self.lanes = board.parse_readme(ROADMAP_SAMPLE).lanes
        self.rm = board.roadmap(self.lanes)
        self.platforms = {p["id"]: p for p in self.rm["platforms"]}
        self.milestones = {m["id"]: m for m in self.rm["milestones"]}

    def test_platforms_of(self):
        self.assertEqual(board.platforms_of("Linux, macOS"), {"linux", "macos"})
        self.assertEqual(board.platforms_of("both"), {"linux", "macos"})
        self.assertEqual(board.platforms_of("Linux + agent"), {"linux", "shared"})
        self.assertEqual(board.platforms_of("macOS + agent"), {"macos", "shared"})
        self.assertEqual(board.platforms_of("Hyprland"), {"linux"})
        self.assertEqual(board.platforms_of("Windows (model, Linux-tested)"), {"windows"})
        self.assertEqual(board.platforms_of("Linux + macOS compile"), {"linux", "macos"})
        self.assertEqual(board.platforms_of("OS-free + Linux + macOS"), {"shared", "linux", "macos"})
        for shared in ("any", "OS-free", "all", "render", "", "split"):
            self.assertEqual(board.platforms_of(shared), {"shared"}, shared)

    def test_platform_totals_count_multi_os_rows_and_skip_aside(self):
        linux = self.platforms["linux"]["totals"]
        # 1.2, 2.55, 2.58, 2.59, 4.19, 4.17 counted; the superseded 2.60 is aside.
        self.assertEqual((linux["done"], linux["counted"], linux["aside"]), (2, 6, 1))
        macos = self.platforms["macos"]["totals"]
        self.assertEqual((macos["done"], macos["active"], macos["spec"], macos["counted"]), (0, 1, 1, 3))
        self.assertEqual(self.platforms["shared"]["totals"]["counted"], 3)

    def test_windows_with_few_rows_is_flagged_with_a_note(self):
        win = self.platforms["windows"]
        self.assertEqual(win["totals"]["counted"], 1)
        self.assertTrue(win["few"])
        self.assertIn("Phase 3", win["note"])

    def test_next_rows_put_active_first(self):
        nxt = self.platforms["linux"]["next"]
        self.assertEqual([n["id"] for n in nxt], ["WP-4.19", "WP-2.58", "WP-2.59"])

    def test_workstreams_follow_lanes(self):
        titles = [w["title"] for w in self.rm["workstreams"]]
        self.assertEqual(titles, [lane.title for lane in self.lanes])
        drag = self.rm["workstreams"][1]
        self.assertEqual((drag["totals"]["done"], drag["totals"]["counted"]), (2, 5))

    def test_milestone_states(self):
        m = self.milestones
        self.assertEqual(m["phase-1"]["state"], "done")
        self.assertTrue(m["phase-1"]["derived"])
        self.assertEqual(m["phase-1"]["next"], [])
        self.assertEqual(m["drag-v0a"]["state"], "active")
        self.assertEqual(m["drag-v0a"]["next"][0]["id"], "WP-2.56")
        # No Phase 0 lane in the sample: shown as later with no numbers.
        self.assertEqual(m["phase-0"]["state"], "later")
        self.assertIsNone(m["phase-0"]["totals"])
        self.assertEqual(m["phase-4"]["state"], "later")
        self.assertFalse(m["mvp-gate"]["derived"])

    def test_installer_tiers_split_by_rulings(self):
        t1 = self.milestones["installer-t1"]["totals"]
        t2 = self.milestones["installer-t2"]["totals"]
        self.assertEqual((t1["done"], t1["counted"]), (1, 2))
        self.assertEqual((t2["done"], t2["counted"]), (0, 2))
        self.assertEqual(self.milestones["installer-t2"]["state"], "later")
        self.assertTrue(board.INSTALLER_TIER2.match("WP-4.5b"))
        self.assertFalse(board.INSTALLER_TIER2.match("WP-4.1"))
        self.assertFalse(board.INSTALLER_TIER2.match("WP-4.100"))

    def test_real_board_has_a_roadmap(self):
        rm = board.build(REPO, with_git=False)["roadmap"]
        self.assertEqual([p["id"] for p in rm["platforms"]], ["linux", "macos", "windows", "shared"])
        self.assertTrue(all(p["totals"]["counted"] > 0 for p in rm["platforms"] if p["id"] != "windows"))
        self.assertEqual(len(rm["workstreams"]), len(board.parse_readme(README.read_text(encoding="utf-8")).lanes))
        self.assertTrue(all(m["state"] in ("done", "active", "next", "later") for m in rm["milestones"]))


if __name__ == "__main__":
    unittest.main()
