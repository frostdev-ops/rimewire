"""Agent updates: validation, journals in the repo and its worktrees, summaries, the CLI, the board.

  python -m unittest scripts/wp-board/test_journal.py
"""

import sys

sys.dont_write_bytecode = True

import json  # noqa: E402
import os  # noqa: E402
import shutil  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402
import unittest  # noqa: E402
from pathlib import Path  # noqa: E402

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import board  # noqa: E402
import journal  # noqa: E402

REPO = HERE.parent.parent
CLI = HERE / "wp-note"


class Validation(unittest.TestCase):
    def test_a_good_update(self):
        n = journal.make("WP-C1", "progress", " offers done ", 60, "sol-2")
        self.assertEqual((n["wp"], n["kind"], n["text"], n["percent"], n["author"]), ("WP-C1", "progress", "offers done", 60, "sol-2"))
        self.assertEqual(len(n["id"]), 16)

    def test_rejections(self):
        for args in (
            ("WP C1", "note", "x"),
            ("../etc", "note", "x"),
            ("WP-C1", "shout", "x"),
            ("WP-C1", "note", ""),
            ("WP-C1", "blocker", "  "),
            ("WP-C1", "note", "x" * (journal.MAX_TEXT + 1)),
        ):
            with self.assertRaises(ValueError, msg=args):
                journal.make(*args)
        for pct in (-1, 101, True, 50.5):
            with self.assertRaises(ValueError, msg=pct):
                journal.make("WP-C1", "progress", "x", pct)
        with self.assertRaises(ValueError):
            journal.make("WP-C1", "note", "x", 10)

    def test_default_author(self):
        self.assertEqual(journal.make("WP-C1", "ready", "")["author"], "agent")


class Journals(unittest.TestCase):
    def setUp(self):
        self.repo = Path(tempfile.mkdtemp(prefix="wp-notes-"))
        self.wt = self.repo / ".worktrees" / "WP-C1"
        self.wt.mkdir(parents=True)

    def tearDown(self):
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_repo_and_worktree_journals_merge_in_time_order(self):
        a = journal.make("WP-C1", "note", "from the lead", author="lead")
        b = journal.make("WP-C1", "progress", "from the worker", 30, "sol-1")
        a["time"], b["time"] = 200.0, 100.0
        journal.append(self.repo, a)
        journal.append(self.wt, b)
        notes = journal.read_all(self.repo)
        self.assertEqual([n["text"] for n in notes], ["from the worker", "from the lead"])
        self.assertEqual([n["source"] for n in notes], ["WP-C1", "main"])
        self.assertTrue(journal.journal_path(self.wt).is_file())

    def test_bad_lines_are_skipped_and_ids_deduplicated(self):
        n = journal.make("WP-C1", "note", "once", author="lead")
        journal.append(self.repo, n)
        journal.append(self.wt, n)
        with journal.journal_path(self.repo).open("a") as f:
            f.write('not json\n{"wp": "../x", "kind": "note", "time": 1}\n[1, 2]\n{"wp": "WP-C1", "time": 5, "kind": "?", "percent": 900}\n{"wp": "WP-C1", "ti')
        notes = journal.read_all(self.repo)
        self.assertEqual(len(notes), 2)
        odd = next(x for x in notes if x["time"] == 5)
        self.assertEqual((odd["kind"], odd["percent"]), ("note", None))

    def test_signature_sees_a_new_update(self):
        before = journal.signature_parts(self.repo)
        journal.append(self.wt, journal.make("WP-C1", "note", "hi"))
        self.assertNotEqual(before, journal.signature_parts(self.repo))


class Summary(unittest.TestCase):
    def notes(self, *specs):
        out = []
        for t, (kind, text, pct) in enumerate(specs):
            n = journal.make("WP-X1", kind, text, pct, "sol")
            n["time"] = float(t)
            out.append(n)
        return out

    def test_blocker_until_unblock_then_ready(self):
        s = journal.summarize(self.notes(("progress", "a", 20), ("blocker", "needs dep", None)))["WP-X1"]
        self.assertEqual((s["percent"], s["step"], s["blocker"]["text"]), (20, "a", "needs dep"))
        s = journal.summarize(self.notes(("progress", "a", 20), ("blocker", "b", None), ("unblock", "", None)))["WP-X1"]
        self.assertIsNone(s["blocker"])
        s = journal.summarize(self.notes(("blocker", "b", None), ("ready", "all green", None)))["WP-X1"]
        self.assertEqual((s["blocker"], s["ready"]["text"], s["percent"], s["count"]), (None, "all green", 100, 2))

    def test_progress_after_ready_reopens(self):
        s = journal.summarize(self.notes(("ready", "", 100), ("progress", "review round 2", 80)))["WP-X1"]
        self.assertEqual((s["ready"], s["percent"], s["step"]), (None, 80, "review round 2"))

    def test_notes_keep_the_step(self):
        s = journal.summarize(self.notes(("progress", "step one", 10), ("note", "fyi", None)))["WP-X1"]
        self.assertEqual((s["step"], s["last"]["kind"], s["authors"]), ("step one", "note", ["sol"]))


class Cli(unittest.TestCase):
    def setUp(self):
        self.repo = Path(tempfile.mkdtemp(prefix="wp-cli-"))
        (self.repo / ".git").mkdir()
        (self.repo / "docs" / "wp").mkdir(parents=True)
        (self.repo / "docs" / "wp" / "README.md").write_text("| [WP-C1](WP-C1.md) | x | any | — | delegated | — |\n")
        self.wt = self.repo / ".worktrees" / "WP-C1"
        (self.wt / "src").mkdir(parents=True)
        (self.repo / ".git" / "worktrees" / "WP-C1").mkdir(parents=True)
        (self.wt / ".git").write_text(f"gitdir: {self.repo / '.git' / 'worktrees' / 'WP-C1'}\n")
        self.env = {k: v for k, v in os.environ.items() if k != "CROSSPANE_AGENT"}

    def tearDown(self):
        shutil.rmtree(self.repo, ignore_errors=True)

    def run_cli(self, *args, cwd, stdin=None):
        return subprocess.run([sys.executable, str(CLI), *args], cwd=cwd, input=stdin, capture_output=True, text=True, env=self.env, timeout=20)

    def test_worker_posts_into_its_own_worktree(self):
        out = self.run_cli("progress", "WP-C1", "-p", "40", "engine", "offers", "done", cwd=self.wt / "src")
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out.stderr, "")
        self.assertFalse(journal.journal_path(self.repo).exists())
        [note] = journal.read_journal(journal.journal_path(self.wt), "WP-C1")
        self.assertEqual((note["text"], note["percent"], note["author"]), ("engine offers done", 40, "WP-C1"))

    def test_stdin_json_and_list(self):
        out = self.run_cli("blocker", "WP-C1", "-", "--json", "--author", "sol-3", cwd=self.repo, stdin="needs a new dep\n\nfoo 1.2\n")
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(json.loads(out.stdout)["text"], "needs a new dep\n\nfoo 1.2")
        self.run_cli("note", "WP-C1", "from the worktree", cwd=self.wt)
        listed = self.run_cli("list", "WP-C1", "--json", cwd=self.wt)
        self.assertEqual([n["source"] for n in json.loads(listed.stdout)], ["main", "WP-C1"])

    def test_unknown_id_warns_and_bad_input_fails(self):
        out = self.run_cli("note", "WP-ZZ9", "hello", cwd=self.repo)
        self.assertEqual(out.returncode, 0)
        self.assertIn("warning", out.stderr)
        self.assertEqual(self.run_cli("note", "WP-C1", cwd=self.repo).returncode, 2)
        self.assertEqual(self.run_cli("progress", "WP-C1", "-p", "140", "x", cwd=self.repo).returncode, 2)
        self.assertEqual(self.run_cli("progress", "WP-C1", cwd=self.repo).returncode, 2)


class BoardIntegration(unittest.TestCase):
    def setUp(self):
        self.repo = Path(tempfile.mkdtemp(prefix="wp-board-notes-"))
        shutil.copytree(REPO / "docs" / "wp", self.repo / "docs" / "wp")

    def tearDown(self):
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_cards_carry_the_summary_and_the_feed_lists_updates(self):
        journal.append(self.repo, journal.make("WP-0.1", "note", "retro: CI was quick", author="lead"))
        journal.append(self.repo, journal.make("WP-0.1", "progress", "", 100, "lead"))
        snapshot = board.build(self.repo, with_git=False)
        item = board.find(snapshot, "WP-0.1")
        self.assertEqual((item["agent"]["count"], item["agent"]["percent"]), (2, 100))
        self.assertEqual([n["kind"] for n in snapshot["activity"]], ["progress", "note"])
        self.assertEqual(snapshot["activity_total"], 2)
        detail = board.detail(self.repo, snapshot, "WP-0.1")
        self.assertEqual(len(detail["updates"]), 2)
        self.assertIsNone(board.find(snapshot, "WP-0.2")["agent"])


if __name__ == "__main__":
    unittest.main()
