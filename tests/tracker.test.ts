import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  build,
  detail,
  everyItem,
  find,
  laneState,
  nextRows,
  platformsOf,
  roadmap,
  signature,
} from "../src/board.js";
import { CLASSES, parseConfig } from "../src/config.js";
import {
  branchDetail,
  commits,
  git,
  matchWorktree,
  parseCommits,
  parseWorktrees,
  worktrees,
} from "../src/gitinfo.js";
import { append, make } from "../src/journal.js";
import {
  classify,
  empty,
  isSeparator,
  parseReadme,
  parseSpec,
  plain,
  shortStatus,
  slug,
  splitHeading,
  splitRow,
  totals,
} from "../src/tracker.js";
import {
  crosspaneConfig,
  crosspaneRepo,
  fixtureGit,
  removeRepo,
  tempRepo,
  textFixture,
  write,
} from "./fixtures/helpers.js";

const repos: string[] = [];
function repo(fixture = true): string {
  const root = fixture ? crosspaneRepo() : tempRepo();
  repos.push(root);
  return root;
}
afterEach(() => {
  for (const root of repos.splice(0)) removeRepo(root);
});
const config = crosspaneConfig();

describe("tracker parser: ported Python cases", () => {
  const parsed = parseReadme(textFixture("sample.md"));
  const items = new Map(
    parsed.lanes.flatMap((lane) => lane.items).map((item) => [item.key, item]),
  );
  it("keeps delegated branch, OS, and dependencies", () => {
    expect(items.get("WP-W0.2a")).toMatchObject({
      cls: "active",
      branch: "wp/W0.2a-winevent",
      os: "Windows (model, Linux-tested)",
      depends: "W0.1",
    });
  });
  it("parses plain IDs, lead notes, and status notes", () => {
    expect(items.get("WP-P2")).toMatchObject({
      cls: "planned",
      status_short: "planned",
      status_note: "low priority",
    });
    expect(items.get("WP-2.16")).toMatchObject({
      id_note: "lead",
      tags: ["lead"],
    });
  });
  it("splits lane headings, keeps notes and links, and ignores schedule tables", () => {
    expect(items.get("WP-4.8")?.cls).toBe("aside");
    expect(parsed.lanes).toHaveLength(1);
    expect(parsed.lanes[0]).toMatchObject({
      title: "Phase 3 — Windows and MVP+ features (PHASE3)",
      subtitle: "started 2026-10-03",
    });
    expect(parsed.lanes[0].notes[0]).toMatch(/^\*\*MVP gate/);
    expect(parsed.links.has("MVP-gate.md")).toBe(true);
    expect([...items.values()].some((item) => /^\d+$/.test(item.id))).toBe(
      false,
    );
  });
  it.each([
    ["merged (lead)", "done"],
    ["frozen (lead)", "done"],
    ["design landed", "done"],
    ["speaker v0 done (all packages merged)", "done"],
    ["delegated", "active"],
    ["in review", "active"],
    ["in progress", "active"],
    ["review", "active"],
    ["implementing", "active"],
    ["spec'd", "spec"],
    ["planned", "planned"],
    ["to spec after P8b", "planned"],
    ["blocked (owner)", "blocked"],
    ["split (4.8a/b/c)", "aside"],
    ["superseded", "aside"],
    ["(superseded by X)", "aside"],
    ["cut", "aside"],
  ])("classifies %s as %s", (status, expected) =>
    expect(classify(status)).toBe(expected),
  );
  it("handles escaped pipes and pipes inside code", () => {
    expect(splitRow("| a | `x | y` | c |")).toEqual(["a", "`x | y`", "c"]);
    expect(splitRow("| a \\| b | c \\|")).toEqual(["a | b", "c |"]);
    expect(splitRow("a|b")).toEqual(["a", "b"]);
    expect(isSeparator("| :---: | -- - |")).toBe(true);
    expect(isSeparator("---|---")).toBe(false);
  });
  it.each(["WP", "ID", "Package", "Task"])(
    "accepts %s headers and tracker IDs without a project prefix",
    (header) => {
      const parsed = parseReadme(
        `## Tasks\n\n| ${header} | Status |\n|---|---|\n| TASK-1 Example | planned |\n`,
      );
      expect(parsed.lanes[0].items[0]).toMatchObject({
        id: "TASK-1",
        title: "Example",
      });
    },
  );
  it("preserves duplicate keys, groups, custom fields, and owner checkboxes", () => {
    const parsed = parseReadme(textFixture("crosspane/docs/wp/README.md"));
    const items = parsed.lanes.flatMap((lane) => lane.items);
    expect(
      items.filter((item) => item.id === "WP-1.1").map((item) => item.key),
    ).toEqual(["WP-1.1", "WP-1.1~2"]);
    expect(items.find((item) => item.id === "WP-0.1")?.fields).toEqual([
      ["reviewer", "lead"],
    ]);
    expect(items.find((item) => item.id === "WP-C3")).toMatchObject({
      group: "Speakers",
      title: "owner-attended speaker tests",
      tags: ["lead", "owner-attended"],
    });
    expect(parsed.owner_actions).toEqual([
      { done: false, text: "Attend the device gate with a second person." },
      { done: true, text: "Agree on package names." },
    ]);
    expect(parsed.lanes[0].notes).toHaveLength(3);
    expect(parsed.lanes.every((lane) => lane.items.length)).toBe(true);
    expect(items.every((item) => CLASSES.includes(item.cls))).toBe(true);
  });
  it("pads short rows, skips empty IDs, and refuses nested file links", () => {
    const parsed = parseReadme(
      "## Tasks\n| ID | Title | Status | Branch |\n|---|---|---|---|\n| — | nothing | done |\n| TASK-1 | short |\n| [TASK-2](sub/TASK-2.md) | linked | done |\n",
    );
    expect(parsed.lanes[0].items).toHaveLength(2);
    expect(parsed.lanes[0].items[0]).toMatchObject({
      cls: "planned",
      branch: "",
    });
    expect(parsed.lanes[0].items[1].file).toBe("");
  });
  it("uses configurable status regexes with stable precedence", () => {
    const custom = parseConfig({
      statuses: {
        done: ["^shipped"],
        active: ["^coding"],
        blocked: ["^waiting"],
        aside: ["^retired"],
        spec: ["^designed"],
      },
    });
    expect(classify("**shipped** (owner)", custom)).toBe("done");
    expect(classify("merged", custom)).toBe("planned");
    expect(classify("coding", custom)).toBe("active");
    expect(classify("waiting: done", custom)).toBe("blocked");
    expect(classify("retired", custom)).toBe("aside");
    expect(classify("designed", custom)).toBe("spec");
    expect(classify("blocked but done")).toBe("blocked");
    expect(classify("superseded, done")).toBe("aside");
  });
  it("rejects unsafe, overlong, and out-of-pattern IDs in tracker rows", () => {
    const custom = parseConfig({ idPattern: "TASK-[A-Za-z0-9:]+" });
    const parsed = parseReadme(
      `## Tasks\n| ID | Status |\n|---|---|\n| TASK-1 | planned |\n| TASK:1 | planned |\n| TASK-2:evil | planned |\n| ../private | planned |\n| TASK-${"x".repeat(44)} | planned |\n| OTHER-1 | planned |\n`,
      custom,
    );
    expect(parsed.lanes[0].items.map((item) => item.id)).toEqual(["TASK-1"]);
  });
  it("cleans inline Markdown and splits punctuation without stripping ordinary parentheses", () => {
    expect(plain(" **[Task](TASK-1.md)** `code` ")).toBe("Task code");
    expect(shortStatus("merged (lead)")).toEqual(["merged", "lead"]);
    expect(shortStatus("spec; owner")).toEqual(["spec", "owner"]);
    expect(shortStatus("(superseded)")).toEqual(["(superseded)", ""]);
    expect(splitHeading("Phase 1 (started 2026-10-01)")).toEqual([
      "Phase 1",
      "started 2026-10-01",
    ]);
    expect(slug("**同じ**")).toBe("lane");
    for (const value of ["", "—", "-", "–", "`—`"])
      expect(empty(value)).toBe(true);
  });
});

describe("spec excerpts: ported Python cases", () => {
  it("extracts why, metadata, and report", () => {
    const spec = parseSpec(textFixture("crosspane/docs/wp/WP-0.1.md"));
    expect(spec).toMatchObject({
      h1: "WP-0.1 — Foundation",
      why: "**Why.** Keep the link dependable.",
      report_title: "Report (merged 2026-09-30)",
      report: "It merged.\n\nTests pass.",
      has_report: true,
    });
    expect(spec.meta[0]).toEqual(["Branch", "`wp/0.1-foundation`"]);
  });
  it("falls back to a third-level title and a goal bullet", () => {
    const spec = parseSpec(
      "### WP-2.5b — engine fixes\n\n- **Goal:** fix the findings.\n",
    );
    expect(spec.h1).toBe("WP-2.5b — engine fixes");
    expect(spec.why).toBe("fix the findings.");
  });
  it("extracts bold status and removes it from the fallback body", () => {
    const spec = parseSpec(textFixture("crosspane/docs/wp/WP-W0.2.md"));
    expect(classify(spec.status)).toBe("spec");
    expect(spec.why).toBe("Body.");
  });
  it("handles continuations, goal sections, code fences, and the last report", () => {
    const spec = parseSpec(
      "```md\n# Not the title\n## Report fake\n```\n# TASK-1 — Actual\n\n- **Branch**: work/task\n  continued branch note\n\n## Why\n\nBecause tests.\n\n## Report one\n\nEarlier.\n\n## Report two\n\nFirst.\n\nSecond.\n\nThird.\n",
    );
    expect(spec).toMatchObject({
      h1: "TASK-1 — Actual",
      why: "Because tests.",
      report_title: "Report two",
      report: "First.\n\nSecond.",
    });
    expect(spec.meta).toEqual([["Branch", "work/task continued branch note"]]);
  });
});

describe("roadmap: ported Python cases", () => {
  const lanes = parseReadme(textFixture("roadmap.md")).lanes;
  const rm = roadmap(lanes, config);
  const platforms = new Map(
    rm.platforms.map((platform) => [platform.id, platform]),
  );
  const milestones = new Map(
    rm.milestones.map((milestone) => [milestone.id, milestone]),
  );
  it.each([
    ["Linux, macOS", ["linux", "macos"]],
    ["both", ["linux", "macos"]],
    ["Linux + agent", ["linux", "shared"]],
    ["macOS + agent", ["macos", "shared"]],
    ["Hyprland", ["linux"]],
    ["Windows (model, Linux-tested)", ["windows"]],
    ["Linux + macOS compile", ["linux", "macos"]],
    ["OS-free + Linux + macOS", ["shared", "linux", "macos"]],
    ...["any", "OS-free", "all", "render", "", "split"].map((value) => [
      value,
      ["shared"],
    ]),
  ])("buckets %s", (value, expected) =>
    expect(platformsOf(value as string, config)).toEqual(
      new Set(expected as string[]),
    ),
  );
  it("counts each named OS, excluding aside from counted totals", () => {
    expect(platforms.get("linux")?.totals).toMatchObject({
      done: 2,
      counted: 6,
      aside: 1,
    });
    expect(platforms.get("macos")?.totals).toMatchObject({
      done: 0,
      active: 1,
      spec: 1,
      counted: 3,
    });
    expect(platforms.get("shared")?.totals.counted).toBe(3);
    expect(platforms.get("windows")).toMatchObject({
      totals: { counted: 1 },
      few: true,
    });
    expect(platforms.get("windows")?.note).toContain("Phase 3");
  });
  it("puts active rows first and derives workstreams from lanes", () => {
    expect(platforms.get("linux")?.next.map((item) => item.id)).toEqual([
      "WP-4.19",
      "WP-2.58",
      "WP-2.59",
    ]);
    expect(rm.workstreams.map((stream) => stream.title)).toEqual(
      lanes.map((lane) => lane.title),
    );
    expect(rm.workstreams[1].totals).toMatchObject({ done: 2, counted: 5 });
  });
  it("derives lane states while preserving static state and missing-lane totals", () => {
    expect(milestones.get("phase-1")).toMatchObject({
      state: "done",
      derived: true,
      next: [],
    });
    expect(milestones.get("drag-v0a")?.state).toBe("active");
    expect(milestones.get("drag-v0a")?.next[0].id).toBe("WP-2.56");
    expect(milestones.get("phase-0")).toMatchObject({
      state: "later",
      totals: null,
    });
    expect(milestones.get("phase-4")?.state).toBe("later");
    expect(milestones.get("mvp-gate")?.derived).toBe(false);
  });
  it("splits installer tiers entirely through configured ID filters", () => {
    expect(milestones.get("installer-t1")?.totals).toMatchObject({
      done: 1,
      counted: 2,
    });
    expect(milestones.get("installer-t2")).toMatchObject({
      totals: { done: 0, counted: 2 },
      state: "later",
    });
    const rule = config.roadmap.milestones.find(
      (milestone) => milestone.id === "installer-t2",
    )?.include;
    expect(new RegExp(rule ?? "").test("WP-4.5b")).toBe(true);
    expect(new RegExp(rule ?? "").test("WP-4.100")).toBe(false);
  });
  it("allows other platform names, overlap, few-row thresholds, and ID rules", () => {
    const custom = parseConfig({
      roadmap: {
        platforms: [
          { id: "mobile", label: "Mobile", tokens: ["android", "both"] },
          { id: "desktop", label: "Desktop", tokens: ["desktop", "both"] },
          { id: "common", label: "Common", tokens: [] },
        ],
        fewRows: 1,
        milestones: [
          {
            id: "deliver",
            title: "Delivery",
            lane: "^Tasks",
            include: "^TASK-",
            exclude: "2$",
          },
        ],
      },
    });
    const lanes = parseReadme(
      "## Tasks\n| Task | OS | Status |\n|---|---|---|\n| TASK-1 | both | done |\n| TASK-2 | android | planned |\n| TASK-3 | | planned |\n",
    ).lanes;
    expect(platformsOf("android + agent", custom)).toEqual(
      new Set(["mobile", "common"]),
    );
    const result = roadmap(lanes, custom);
    expect(result.platforms[0]).toMatchObject({
      totals: { counted: 2, done: 1 },
      few: false,
    });
    expect(result.platforms[2].unlabelled).toBe(1);
    expect(result.milestones[0]).toMatchObject({
      kind: "phase",
      state: "active",
      totals: { counted: 2 },
    });
  });
  it("counts aside separately and handles empty and blocked lanes", () => {
    expect(totals([]).percent).toBe(0);
    expect(totals([{ cls: "done" }, { cls: "aside" }])).toMatchObject({
      counted: 1,
      items: 2,
      percent: 100,
    });
    expect(laneState(totals([{ cls: "blocked" }]))).toBe("next");
    expect(nextRows(lanes[0].items)).toEqual([]);
    expect(
      totals([
        { cls: "done" },
        ...Array.from({ length: 15 }, () => ({ cls: "planned" as const })),
      ]).percent,
    ).toBe(6.2);
    expect(
      totals([
        ...Array.from({ length: 23 }, () => ({ cls: "done" as const })),
        ...Array.from({ length: 1977 }, () => ({ cls: "planned" as const })),
      ]).percent,
    ).toBe(1.1);
  });
});

describe("fixture board and discovery", () => {
  it("ports fixture foundation, split parents, counts, and roadmap checks", () => {
    const snapshot = build(repo(), config, false);
    expect(find(snapshot, "WP-0.1")).toMatchObject({
      cls: "done",
      file: "WP-0.1.md",
      file_exists: true,
      has_report: true,
    });
    expect(snapshot.totals.items).toBe(
      snapshot.lanes.reduce((count, lane) => count + lane.items.length, 0),
    );
    expect(snapshot.totals.counted).toBe(
      snapshot.totals.items - snapshot.totals.aside,
    );
    expect(snapshot.totals.percent).toBeGreaterThan(0);
    expect(snapshot.roadmap.platforms.map((platform) => platform.id)).toEqual([
      "linux",
      "macos",
      "windows",
      "shared",
    ]);
    expect(snapshot.roadmap.workstreams).toHaveLength(snapshot.lanes.length);
    expect(
      snapshot.roadmap.milestones.every((milestone) =>
        ["done", "active", "next", "later"].includes(milestone.state),
      ),
    ).toBe(true);
  });
  it("discovers new packages and excludes linked packages and design documents", () => {
    const root = repo();
    let snapshot = build(root, config, false);
    expect(snapshot.untracked.map((item) => item.id)).toEqual([
      "C-P1",
      "P8b",
      "WP-W0.2",
      "WP-ZZ",
    ]);
    expect(find(snapshot, "WP-ZZ")).toMatchObject({
      title: "A new package",
      tracked: false,
    });
    expect(find(snapshot, "WP-W0.2")?.cls).toBe("spec");
    expect(find(snapshot, "P8b")).toMatchObject({
      cls: "done",
      status_short: "report filed",
      title: "Input risk",
    });
    write(root, "docs/wp/WP-Z9.md", "# WP-Z9 — Added now\n");
    snapshot = build(root, config, false);
    expect(find(snapshot, "WP-Z9")?.title).toBe("Added now");
    expect([...everyItem(snapshot)]).toHaveLength(
      snapshot.totals.items + snapshot.untracked.length,
    );
  });
  it("uses a custom tracker filename and anchored ID pattern for spec discovery", () => {
    const root = repo(false);
    const custom = parseConfig({
      tracker: "planning/tasks.md",
      idPattern: "^TASK-\\d+$",
      branchPrefix: "task",
    });
    write(
      root,
      custom.tracker,
      "## Tasks\n| ID | Status |\n|---|---|\n| TASK-1 | planned |\n",
    );
    write(root, "planning/TASK-1.md", "# TASK-1 — Main\n");
    write(root, "planning/TASK-2.md", "# TASK-2 — New\n");
    write(root, "planning/decisions.md", "# Decisions\n");
    const snapshot = build(root, custom, false);
    expect(find(snapshot, "TASK-1")?.file).toBe("TASK-1.md");
    expect(snapshot.untracked.map((item) => item.id)).toEqual(["TASK-2"]);
    expect(detail(root, snapshot, "TASK-1", custom)?.source).toBe(
      "planning/TASK-1.md",
    );
    expect(detail(root, snapshot, "../secrets", custom)).toBeNull();
  });
  it("rejects specs and tracker directories symlinked outside their allowed root", () => {
    const root = repo(),
      outside = repo(false);
    write(outside, "secret.md", "# private material\n");
    symlinkSync(join(outside, "secret.md"), join(root, "docs/wp/WP-X9.md"));
    const snapshot = build(root, config, false);
    expect(find(snapshot, "WP-X9")).toMatchObject({
      file_exists: false,
      h1: "",
      mtime: null,
    });
    expect(detail(root, snapshot, "WP-X9", config)).toMatchObject({
      spec: null,
      markdown: "",
      source: "",
    });
    write(root, "other/inside.md", "# outside tracker directory\n");
    symlinkSync(join(root, "other/inside.md"), join(root, "docs/wp/WP-X8.md"));
    expect(find(build(root, config, false), "WP-X8")?.file_exists).toBe(false);
    write(
      outside,
      "docs/wp/README.md",
      readFileSync(join(root, "docs/wp/README.md"), "utf8"),
    );
    symlinkSync(join(outside, "docs/wp"), join(root, "linked"));
    expect(() =>
      build(
        root,
        parseConfig({ ...config, tracker: "linked/README.md" }),
        false,
      ),
    ).toThrow("outside the project");
  });
  it("permits a spec symlink whose target remains inside the tracker directory", () => {
    const root = repo();
    symlinkSync(join(root, "docs/wp/WP-ZZ.md"), join(root, "docs/wp/WP-X7.md"));
    expect(find(build(root, config, false), "WP-X7")).toMatchObject({
      file_exists: true,
      title: "A new package",
    });
  });
});

describe("journal effective state: intentional differences from Python", () => {
  function post(
    root: string,
    wp: string,
    kind: string,
    text: string,
    time: number,
    percent: number | null = null,
  ): void {
    const note = make(wp, kind, text, percent, "worker", "cli", config);
    note.time = time;
    append(root, note, config);
  }
  it("marks explicit ready done and later progress or blocker reopens, including merged tracker rows", () => {
    const root = repo();
    post(root, "WP-P2", "ready", "Tests passed", 1);
    let snapshot = build(root, config, false);
    expect(find(snapshot, "WP-P2")).toMatchObject({
      cls: "done",
      status_short: "ready",
      in_flight: false,
      agent: { percent: 100 },
    });
    expect(
      snapshot.lanes.find((lane) => lane.id === find(snapshot, "WP-P2")?.lane)
        ?.totals.done,
    ).toBe(3);
    post(root, "WP-P2", "progress", "Review round two", 2, 80);
    snapshot = build(root, config, false);
    expect(find(snapshot, "WP-P2")).toMatchObject({
      cls: "active",
      in_flight: true,
      agent: { ready: null, percent: 80 },
    });
    post(root, "WP-P2", "blocker", "Needs dependency", 3);
    expect(find(build(root, config, false), "WP-P2")?.cls).toBe("blocked");
    post(root, "WP-P2", "unblock", "", 4);
    expect(find(build(root, config, false), "WP-P2")?.cls).toBe("active");
    post(root, "WP-0.1", "ready", "Complete", 5);
    post(root, "WP-0.1", "blocker", "Regression", 6);
    expect(find(build(root, config, false), "WP-0.1")?.cls).toBe("blocked");
    post(root, "WP-0.1", "ready", "Fixed", 7);
    expect(find(build(root, config, false), "WP-0.1")?.cls).toBe("done");
  });
  it("keeps legacy merged rows done, clears stale blockers, and exposes summaries/feed/details", () => {
    const root = repo();
    post(root, "WP-0.1", "note", "retro: CI was quick", 1);
    post(root, "WP-0.1", "progress", "", 2, 100);
    post(root, "WP-0.1", "blocker", "Old dependency", 3);
    const snapshot = build(root, config, false);
    expect(find(snapshot, "WP-0.1")).toMatchObject({
      cls: "done",
      agent: { count: 3, percent: 100, blocker: null },
    });
    expect(snapshot.activity.map((note) => note.kind)).toEqual([
      "blocker",
      "progress",
      "note",
    ]);
    expect(snapshot.activity_total).toBe(3);
    expect(detail(root, snapshot, "WP-0.1", config)?.updates).toHaveLength(3);
    expect(find(snapshot, "WP-0.2")?.agent).toBeNull();
  });
  it("does not infer completion from progress 100 or a hook", () => {
    const root = repo();
    post(root, "WP-P2", "progress", "End of run", 1, 100);
    expect(find(build(root, config, false), "WP-P2")?.cls).toBe("active");
    write(
      root,
      "target/wp-notes/notes.jsonl",
      readFileSync(join(root, "target/wp-notes/notes.jsonl"), "utf8") +
        JSON.stringify({
          id: "hook",
          wp: "WP-P2",
          kind: "ready",
          text: "exit",
          time: 2,
          source: "hook:SessionEnd",
        }) +
        "\n",
    );
    expect(find(build(root, config, false), "WP-P2")?.cls).toBe("active");
  });
});

describe("Git discovery and external worktrees", () => {
  it("parses detached worktrees and prioritizes explicit branches, directory IDs, then prefixes", () => {
    const trees = parseWorktrees(
      "worktree /tmp/main\nHEAD 1234567890\nbranch refs/heads/main\n\nworktree /tmp/worker\nHEAD abcdef0123\nbranch refs/heads/task/TASK-1-impl\n\nworktree /tmp/TASK-1\nHEAD 9999999999\ndetached\n\n",
      "/tmp/main",
    );
    expect(trees).toEqual([
      {
        path: "/tmp/worker",
        name: "worker",
        head: "abcdef0",
        branch: "task/TASK-1-impl",
      },
      { path: "/tmp/TASK-1", name: "TASK-1", head: "9999999" },
    ]);
    expect(
      matchWorktree({ id: "TASK-1", branch: "task/TASK-1-impl" }, trees, {
        branchPrefix: "task",
      })?.name,
    ).toBe("worker");
    expect(
      matchWorktree({ id: "TASK-1", branch: "" }, trees, {
        branchPrefix: "task",
      })?.name,
    ).toBe("TASK-1");
    expect(
      matchWorktree(
        { id: "WP-1.2", branch: "" },
        [{ path: "/worker", name: "worker", branch: "wp/1.2-x" }],
        config,
      )?.name,
    ).toBe("worker");
    expect(
      matchWorktree({ id: "TASK-10", branch: "" }, trees, {
        branchPrefix: "task",
      }),
    ).toBeNull();
    expect(
      matchWorktree(
        { id: "WP-1.2", branch: "" },
        [{ path: "/spike", name: "spike", branch: "spike/1.2-risk" }],
        { branchPrefix: "wp", branchAliases: ["spike"] },
      )?.name,
    ).toBe("spike");
  });
  it("returns no Git data for non-repositories and unsafe branch names", () => {
    const root = repo(false);
    expect(git(root, ["log", "-1"])).toBeNull();
    expect(commits(root)).toEqual([]);
    expect(worktrees(root)).toEqual([]);
    expect(branchDetail(root, "--all")).toBeNull();
    expect(branchDetail(root, "main; echo private")).toBeNull();
    expect(parseCommits("aaa\x1f123\x1fsubject\nbad\n")).toEqual([
      { sha: "aaa", time: 123, subject: "subject" },
    ]);
  });
  it("reads external specs, dirty state, all external journals, and main-branch commits", () => {
    const root = repo(),
      external = repo(false),
      other = repo(false);
    fixtureGit(root, "init", "--initial-branch=main");
    fixtureGit(root, "add", "docs");
    fixtureGit(root, "commit", "-m", "Foundation fixture");
    fixtureGit(
      root,
      "worktree",
      "add",
      "-b",
      "wp/W0.2a-winevent",
      join(external, "worker"),
    );
    fixtureGit(
      root,
      "worktree",
      "add",
      "-b",
      "wp/elsewhere",
      join(other, "other"),
    );
    write(
      root,
      "docs/wp/README.md",
      "## Tasks\n| WP | Title | Status | Branch |\n|---|---|---|---|\n| [WP-X1](WP-X1.md) | New spec | delegated | wp/W0.2a-winevent |\n",
    );
    write(
      join(external, "worker"),
      "docs/wp/WP-X1.md",
      "# WP-X1 — External specification\n\n**Why.** Worktree only.\n",
    );
    const note = make(
      "WP-X1",
      "note",
      "Other checkout update",
      null,
      "worker",
      "cli",
      config,
    );
    append(join(other, "other"), note, config);
    const snapshot = build(root, config);
    expect(find(snapshot, "WP-X1")).toMatchObject({
      worktree: { name: "worker" },
      in_flight: true,
    });
    expect(snapshot.commits[0].subject).toBe("Foundation fixture");
    const found = detail(root, snapshot, "WP-X1", config);
    expect(found).toMatchObject({
      spec: { h1: "WP-X1 — External specification" },
      git: { branch: "wp/W0.2a-winevent", ahead: 0 },
    });
    expect(found?.git?.dirty).toBeGreaterThan(0);
    expect(found?.source).toContain("worker/WP-X1.md");
    expect(found?.updates.map((update) => update.text)).toContain(
      "Other checkout update",
    );
  });
});

describe("change signatures", () => {
  it("tracks new specs, config files, loose main/current refs, and external journals and specs", () => {
    const root = repo(),
      external = repo(false);
    const changed = (action: () => void) => {
      const before = signature(root, config);
      action();
      expect(signature(root, config)).not.toBe(before);
    };
    changed(() => write(root, "docs/wp/WP-Z9.md", "# New package\n"));
    changed(() => write(root, ".rimewire/config.toml", 'name = "Updated"\n'));
    changed(() =>
      write(root, ".rimewire/config.toml", 'name = "Updated again"\n'),
    );
    fixtureGit(root, "init", "--initial-branch=main");
    fixtureGit(root, "add", "docs");
    fixtureGit(root, "commit", "-m", "Fixture");
    changed(() => fixtureGit(root, "branch", "current"));
    changed(() => fixtureGit(root, "switch", "current"));
    changed(() =>
      fixtureGit(
        root,
        "worktree",
        "add",
        "-b",
        "wp/W0.2a-winevent",
        join(external, "worker"),
      ),
    );
    changed(() =>
      append(
        join(external, "worker"),
        make("WP-W0.2a", "note", "External", null, "worker", "cli", config),
        config,
      ),
    );
    changed(() =>
      write(
        join(external, "worker"),
        "docs/wp/WP-W0.2a.md",
        "# Changed external spec\n",
      ),
    );
    changed(() =>
      fixtureGit(root, "commit", "--allow-empty", "-m", "Advance current"),
    );
    changed(() => fixtureGit(root, "branch", "--force", "main", "current"));
    expect(signature(root, config)).toBe(signature(root, config));
  });
});
