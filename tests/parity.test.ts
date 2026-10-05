import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build, detail, roadmap } from "../src/board.js";
import {
  classify,
  parseReadme,
  parseSpec,
  plain,
  shortStatus,
  slug,
  splitHeading,
  splitRow,
} from "../src/tracker.js";
import {
  crosspaneConfig,
  crosspaneRepo,
  fixtureDirectory,
  fixtureGit,
  removeRepo,
  tempRepo,
  textFixture,
  write,
} from "./fixtures/helpers.js";

const repos: string[] = [];
function repo(): string {
  const root = crosspaneRepo();
  repos.push(root);
  return root;
}
afterEach(() => {
  for (const root of repos.splice(0)) removeRepo(root);
});
const config = crosspaneConfig();

function oracle(
  root: string,
  mode: string,
  withGit = false,
  key = "",
  input = "",
): unknown {
  return JSON.parse(
    execFileSync(
      process.env.PYTHON ?? "python3",
      [
        join(fixtureDirectory, "oracle.py"),
        root,
        mode,
        withGit ? "git" : "no-git",
        key,
      ],
      {
        encoding: "utf8",
        input,
        timeout: 20000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    ),
  );
}

/** Only clock noise and the explicit provenance schema change are normalized. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "number" && !Number.isInteger(value))
    return Math.round(value * 1_000_000) / 1_000_000;
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source))
    if (key !== "generated") out[key] = normalize(item);
  // Python source identifies a checkout. TS preserves that as checkout and adds provenance.
  if (typeof out.wp === "string" && "kind" in out && !("checkout" in out)) {
    out.checkout = out.source;
    out.source = "legacy";
  }
  return out;
}

function serializedReadme(text: string) {
  const parsed = parseReadme(text);
  return { ...parsed, links: [...parsed.links].sort() };
}

describe("Python oracle parity", () => {
  it.each(["sample.md", "roadmap.md", "crosspane/docs/wp/README.md"])(
    "matches every parser field in %s",
    (fixture) => {
      const text = textFixture(fixture);
      expect(serializedReadme(text)).toEqual(
        oracle(".", "readme", false, "", text),
      );
    },
  );
  it("matches row edge cases, duplicate IDs, empty cells, notes, and owner actions", () => {
    const text =
      "# Board\r\n\r\n- [ ] Owner action\r\n  continuation\r\n\r\n## First (done 2026-10-03)\r\n\r\nA note.\r\n\r\n### Subgroup\r\n| Package | Scope | Status | Branch | Custom |\r\n|:---|---|---|---|---:|\r\n| [TASK-1](TASK-1.md) (lead) | `x | y` | merged (owner) | — | escaped \\| text |\r\n| TASK-1 same ID | | planned; later |\r\n| — | skip | done | — |\r\n\r\n## Second\r\n| ID | Status |\r\n|---|---|\r\n| TASK-1 | spec'd |\r\n";
    expect(serializedReadme(text)).toEqual(
      oracle(".", "readme", false, "", text),
    );
  });
  it.each([
    "WP-0.1.md",
    "WP-W0.2a.md",
    "WP-C3.md",
    "WP-ZZ.md",
    "WP-W0.2.md",
    "P8b.md",
    "C-P1.md",
  ])("matches every spec field in %s", (name) => {
    const text = textFixture(`crosspane/docs/wp/${name}`);
    expect(parseSpec(text)).toEqual(oracle(".", "spec", false, "", text));
  });
  it("matches unusual metadata, fences, heading fallback, goal sections, and report truncation", () => {
    for (const text of [
      "#### TASK-1 — Example\n\n- **Status**: **spec'd**\n- **Why:** because\n  continuation\n\n## Report\n\nFirst.\n\nSecond.\n\nThird.\n",
      "```md\n# Fake\n## Report fake\n```\n# TASK-1\n\n## Goal of work\n\n| a | b |\n\nBecause.\n\n## Report earlier\n\nOld.\n\n## Report latest\n\nCurrent.\n",
      "# TASK-1\n\n**Status:** merged.\n\nFallback goal.\n",
      "# TASK-1\n\n**Goal:** Reason.\n",
      "",
    ])
      expect(parseSpec(text)).toEqual(oracle(".", "spec", false, "", text));
  });
  it("matches inline helper semantics across representative inputs", () => {
    const values = {
      plain: [
        "**[Text](file.md)** `code`",
        " ordinary *emphasis* ",
        "[x](sub/a.md)",
        "`|`",
      ],
      classify: [
        "blocked done",
        "split done",
        "(superseded by X)",
        "design landed",
        "speaker done",
        "speaker doneé",
        "éDone speaker",
        "in progress",
        "spec'd",
        "unknown",
        "**merged**",
      ],
      split_row: [
        "| a | `x | y` | c |",
        "a|b",
        "| a \\| b | c \\|",
        "| `a\\|b` | x |",
        "||",
        "",
        "| a | `unclosed | y |",
      ],
      short_status: [
        "merged (lead)",
        "planned; after gate",
        "(superseded)",
        "spec (nested (note))",
        "done",
        "done ()",
      ],
      split_heading: [
        "Phase 2 — E2 v0, started 2026-10-01",
        "Lane (closed 2026-10-02) remaining",
        "Lane (ordinary note)",
        "**Lane**",
      ],
      slug: ["Same Lane!", "同じ", "", "x".repeat(64)],
    };
    const actual = {
      plain: values.plain.map(plain),
      classify: values.classify.map((status) => classify(status)),
      split_row: values.split_row.map(splitRow),
      short_status: values.short_status.map(shortStatus),
      split_heading: values.split_heading.map(splitHeading),
      slug: values.slug.map(slug),
    };
    expect(actual).toEqual(
      oracle(".", "helpers", false, "", JSON.stringify(values)),
    );
  });
  it("matches all legacy roadmap constants through the Crosspane config", () => {
    const text = textFixture("roadmap.md");
    expect(roadmap(parseReadme(text).lanes, config)).toEqual(
      oracle(".", "roadmap", false, "", text),
    );
  });
  it("matches complete fixture snapshots without Git", () => {
    const root = repo();
    expect(normalize(build(root, config, false))).toEqual(
      normalize(oracle(root, "build")),
    );
  });
  it.each(["WP-0.1", "WP-P2", "WP-1.1~2", "WP-ZZ", "P8b", "not-present"])(
    "matches complete details for %s",
    (key) => {
      const root = repo();
      const snapshot = build(root, config, false);
      expect(normalize(detail(root, snapshot, key, config))).toEqual(
        normalize(oracle(root, "detail", false, key)),
      );
    },
  );
  it("matches legacy journal summaries, duplicate handling, malformed lines, feed order, and details", () => {
    const root = repo();
    const note = {
      id: "legacy-1",
      wp: "WP-0.1",
      kind: "note",
      text: "Retro",
      percent: null,
      author: "lead",
      time: 1,
    };
    const progress = {
      ...note,
      id: "legacy-2",
      kind: "progress",
      text: "",
      percent: 100,
      time: 2,
    };
    write(
      root,
      "target/wp-notes/notes.jsonl",
      `${JSON.stringify(note)}\n${JSON.stringify(progress)}\nnot json\n{"wp":"../private","time":1}\n{"wp":"WP-0.1","ti`,
    );
    write(
      root,
      ".worktrees/WP-0.1/target/wp-notes/notes.jsonl",
      `${JSON.stringify(note)}\n`,
    );
    const snapshot = build(root, config, false);
    expect(normalize(snapshot)).toEqual(normalize(oracle(root, "build")));
    expect(normalize(detail(root, snapshot, "WP-0.1", config))).toEqual(
      normalize(oracle(root, "detail", false, "WP-0.1")),
    );
  });
  it("matches Git commits, in-flight worktrees, branch inference, detail state, and worktree spec fallback", () => {
    const root = repo();
    fixtureGit(root, "init", "--initial-branch=master");
    fixtureGit(root, "add", "docs");
    fixtureGit(root, "commit", "-m", "Fixture foundation");
    fixtureGit(
      root,
      "worktree",
      "add",
      "-b",
      "wp/1.2-capture",
      ".worktrees/worker",
    );
    fixtureGit(
      root,
      "worktree",
      "add",
      "-b",
      "wp/W0.2a-winevent",
      ".worktrees/WP-W0.2a",
    );
    const snapshot = build(root, config);
    expect(normalize(snapshot)).toEqual(normalize(oracle(root, "build", true)));
    expect(normalize(detail(root, snapshot, "WP-W0.2a~2", config))).toEqual(
      normalize(oracle(root, "detail", true, "WP-W0.2a~2")),
    );
    fixtureGit(
      root,
      "worktree",
      "add",
      "-b",
      "spike/P2-risk",
      ".worktrees/risk",
    );
    const aliasConfig = { ...config, branchAliases: ["spike"] };
    expect(normalize(build(root, aliasConfig))).toEqual(
      normalize(oracle(root, "build", true)),
    );
    write(
      root,
      "docs/wp/README.md",
      "## Tasks\n| WP | Title | Status | Branch |\n|---|---|---|---|\n| [WP-X1](WP-X1.md) | New | delegated | wp/1.2-capture |\n",
    );
    write(
      root,
      ".worktrees/worker/docs/wp/WP-X1.md",
      "# WP-X1 — Worktree only\r\n\r\n**Why.** Testing fallback.\r\n",
    );
    const next = build(root, config);
    expect(normalize(detail(root, next, "WP-X1", config))).toEqual(
      normalize(oracle(root, "detail", true, "WP-X1")),
    );
  });
});

// Explicitly opt in; ordinary CI never depends on a sibling checkout or private project data.
describe.skipIf(!process.env.RIMEWIRE_CROSSPANE_REPO)(
  "real Crosspane checkout parity",
  () => {
    it("matches the real tracker, spec excerpts, and configured roadmap", () => {
      const root = process.env.RIMEWIRE_CROSSPANE_REPO ?? "";
      const text = readFileSync(join(root, "docs/wp/README.md"), "utf8");
      expect(serializedReadme(text)).toEqual(
        oracle(root, "readme", false, "", text),
      );
      expect(
        parseReadme(text, config).lanes.flatMap((lane) => lane.items),
      ).toEqual(parseReadme(text).lanes.flatMap((lane) => lane.items));
      const legacy = oracle(root, "build") as Record<string, unknown>;
      const actual = build(root, config, false);
      // Live journals intentionally change effective classes; compare structural tracker data here.
      expect(actual.docs).toEqual(legacy.docs);
      expect(roadmap(parseReadme(text).lanes, config)).toEqual(
        oracle(root, "roadmap", false, "", text),
      );
      for (const item of actual.lanes
        .flatMap((lane) => lane.items)
        .filter((item) => item.file_exists)
        .slice(0, 10)) {
        const text = readFileSync(join(root, "docs/wp", item.file), "utf8");
        expect(parseSpec(text)).toEqual(oracle(root, "spec", false, "", text));
      }
    });
    it("matches a complete real-document snapshot with live journal transitions isolated", () => {
      const root = tempRepo();
      repos.push(root);
      mkdirSync(join(root, "docs"));
      // Read-only access to Crosspane; only this temporary checkout is written.
      cpSync(
        join(process.env.RIMEWIRE_CROSSPANE_REPO ?? "", "docs/wp"),
        join(root, "docs/wp"),
        { recursive: true },
      );
      for (const [index, file] of readdirSync(join(root, "docs/wp"))
        .sort()
        .entries())
        utimesSync(
          join(root, "docs/wp", file),
          1700000000 + index,
          1700000000 + index,
        );
      expect(normalize(build(root, config, false))).toEqual(
        normalize(oracle(root, "build")),
      );
    });
  },
);
