import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type Config, loadConfig, parseConfig } from "../src/config.js";
import {
  append,
  clean,
  JOURNAL_DIR,
  journalPath,
  journals,
  MAX_AUTHOR,
  MAX_ID,
  MAX_TEXT,
  make,
  type Note,
  readAll,
  readJournal,
  signatureParts,
  summarize,
} from "../src/journal.js";

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "rimewire-journal-"));
  temporary.push(repo);
  const wt = join(repo, ".worktrees", "WP-C1");
  mkdirSync(wt, { recursive: true });
  return { repo, wt };
}

function legacy(overrides: Record<string, unknown> = {}) {
  return {
    id: "legacy-id",
    wp: "WP-C1",
    kind: "note",
    text: "from an old journal",
    percent: null,
    author: "lead",
    time: 1,
    ...overrides,
  };
}

function notes(
  ...specs: [kind: string, text: string, percent: number | null][]
): Note[] {
  return specs.map(([kind, text, percent], time) => ({
    ...make("WP-X1", kind, text, percent, "sol"),
    time,
  }));
}

describe("journal validation", () => {
  it("makes a validated update with positional defaults and provenance", () => {
    const before = Date.now() / 1000;
    const note = make(" WP-C1 ", "progress", " offers done ", 60, " sol-2 ");
    expect(note).toMatchObject({
      wp: "WP-C1",
      kind: "progress",
      text: "offers done",
      percent: 60,
      author: "sol-2",
      source: "cli",
    });
    expect(note.id).toMatch(/^[a-f0-9]{16}$/);
    expect(note.time).toBeGreaterThanOrEqual(before);
    expect(note.time).toBeLessThanOrEqual(Date.now() / 1000);
    expect(make("WP-C1", "ready", "").author).toBe("agent");
    expect(make("WP-C1", "note", "x").percent).toBeNull();
    expect(make("WP-C1", "note", "x").id).not.toBe(note.id);
  });

  it.each([
    ["WP C1", "note", "x"],
    ["../etc", "note", "x"],
    ["", "note", "x"],
    ["1-WP", "note", "x"],
    ["WP-C1", "shout", "x"],
    ["WP-C1", "note", ""],
    ["WP-C1", "blocker", "  "],
    ["WP-C1", "note", "x".repeat(MAX_TEXT + 1)],
  ])("rejects invalid update %s/%s", (wp, kind, text) => {
    expect(() => make(wp, kind, text)).toThrow();
  });

  it.each([-1, 101, true, 50.5, Number.NaN, Infinity, "50"])(
    "rejects percent %s",
    (percent) => {
      expect(() => make("WP-C1", "progress", "x", percent as number)).toThrow(
        "percent must be a whole number from 0 to 100",
      );
    },
  );

  it("allows percentages only on progress and ready", () => {
    for (const kind of ["note", "blocker", "unblock"]) {
      expect(() => make("WP-C1", kind, "x", 10)).toThrow(
        "only progress and ready updates carry a percent",
      );
    }
    expect(make("WP-C1", "progress", "", 0).percent).toBe(0);
    expect(make("WP-C1", "ready", "", 100).percent).toBe(100);
    expect(make("WP-C1", "unblock", "").text).toBe("");
  });

  it("preserves Python's character limits for Unicode and default authors", () => {
    expect(make("WP-C1", "note", "🦀".repeat(MAX_TEXT)).text).toHaveLength(
      MAX_TEXT * 2,
    );
    expect(() => make("WP-C1", "note", "🦀".repeat(MAX_TEXT + 1))).toThrow(
      "text is longer",
    );
    expect(
      make("WP-C1", "note", "x", null, "🦀".repeat(MAX_AUTHOR + 1)).author,
    ).toBe("🦀".repeat(MAX_AUTHOR));
    expect(make("WP-C1", "note", "x", null, "  ").author).toBe("agent");
  });

  it("validates explicit sources and rejects hook completion", () => {
    for (const source of [
      "cli",
      "mcp",
      "web",
      "hook:Stop",
      "hook:session.idle",
      "hook:SubagentStop",
    ]) {
      expect(
        make("WP-C1", "progress", "working", 50, "sol", source).source,
      ).toBe(source);
      if (source.startsWith("hook:")) {
        expect(() =>
          make("WP-C1", "ready", "done", null, "sol", source),
        ).toThrow("hooks cannot mark a work package ready");
      } else {
        expect(make("WP-C1", "ready", "done", null, "sol", source).kind).toBe(
          "ready",
        );
      }
    }
    for (const source of [
      "",
      "main",
      "legacy",
      "hook:",
      "hook:bad event",
      "exit",
    ]) {
      expect(() => make("WP-C1", "note", "x", null, "", source)).toThrow(
        "source must be",
      );
    }
  });

  it("uses the configured ID pattern for the entire ID", () => {
    const config = parseConfig({ idPattern: "TASK-[0-9]+|BUG-[0-9]+" });
    expect(make("TASK-12", "note", "x", null, "", "cli", config).wp).toBe(
      "TASK-12",
    );
    expect(make("BUG-2", "note", "x", null, "", "cli", config).wp).toBe(
      "BUG-2",
    );
    for (const wp of ["WP-C1", "TASK-12suffix", "prefixBUG-2"]) {
      expect(() => make(wp, "note", "x", null, "", "cli", config)).toThrow(
        "not a work-package id",
      );
    }
    expect(clean(legacy({ wp: "TASK-12\n" }), "main", config)).toBeNull();
  });

  it("keeps IDs safe and at most 48 characters even with a permissive configured pattern", () => {
    const config = parseConfig({ idPattern: ".*" });
    for (const wp of [
      "../etc",
      "a/b",
      "a\\b",
      "WP C1",
      "_leading",
      "-leading",
      "a\nb",
      "A".repeat(MAX_ID + 1),
    ]) {
      expect(() => make(wp, "note", "x", null, "", "cli", config)).toThrow(
        "not a work-package id",
      );
      expect(clean(legacy({ wp }), "main", config)).toBeNull();
    }
    expect(
      make("A".repeat(MAX_ID), "note", "x", null, "", "cli", config).wp,
    ).toHaveLength(MAX_ID);
    expect(make("1-safe.id_2", "note", "x", null, "", "cli", config).wp).toBe(
      "1-safe.id_2",
    );
  });
});

describe("journal reads and checkout discovery", () => {
  it("merges repo and worktree journals by time with checkout separate from source", () => {
    const { repo, wt } = fixture();
    const a = {
      ...make("WP-C1", "note", "from the lead", null, "lead", "mcp"),
      time: 200,
    };
    const b = {
      ...make(
        "WP-C1",
        "progress",
        "from the worker",
        30,
        "sol-1",
        "hook:PostToolUse",
      ),
      time: 100,
    };
    append(repo, a);
    append(wt, b);
    const updates = readAll(repo);
    expect(updates.map((note) => note.text)).toEqual([
      "from the worker",
      "from the lead",
    ]);
    expect(updates.map((note) => note.checkout)).toEqual(["WP-C1", "main"]);
    expect(updates.map((note) => note.source)).toEqual([
      "hook:PostToolUse",
      "mcp",
    ]);
    expect(journalPath(wt)).toBe(join(wt, JOURNAL_DIR, "notes.jsonl"));
    expect(existsSync(journalPath(wt))).toBe(true);
    expect(
      JSON.parse(readFileSync(journalPath(wt), "utf8")),
    ).not.toHaveProperty("checkout");
  });

  it("skips corrupt and half-written lines, sanitizes old entries, and deduplicates IDs", () => {
    const { repo, wt } = fixture();
    const note = make("WP-C1", "note", "once", null, "lead");
    append(repo, note);
    append(wt, { ...note, text: "duplicate in a worktree" });
    appendFileSync(
      journalPath(repo),
      [
        "not json",
        '{"wp":"../x","kind":"note","time":1}',
        "[1,2]",
        "null",
        '{"wp":"WP-C1","time":5,"kind":"?","percent":900}',
        '{"wp":"WP-C1","ti',
      ].join("\n"),
    );
    const updates = readAll(repo);
    expect(updates).toHaveLength(2);
    expect(updates.find((update) => update.id === note.id)).toMatchObject({
      text: "once",
      checkout: "main",
    });
    expect(updates.find((update) => update.time === 5)).toMatchObject({
      id: "main:5:WP-C1",
      kind: "note",
      percent: null,
      author: "agent",
      source: "legacy",
      checkout: "main",
    });
  });

  it("preserves legacy fields and completion while assigning provenance and actual checkout", () => {
    const raw = legacy({
      kind: "ready",
      text: "acceptance passes",
      percent: 100,
    });
    expect(clean(raw, "main")).toEqual({
      ...raw,
      source: "legacy",
      checkout: "main",
    });
    expect(
      clean({ ...raw, source: "old-worktree", checkout: "forged" }, "main"),
    ).toEqual({ ...raw, source: "legacy", checkout: "main" });
    const normalized = clean(raw, "main");
    expect(normalized).not.toBeNull();
    if (normalized)
      expect(summarize([normalized])["WP-C1"].ready?.text).toBe(
        "acceptance passes",
      );
    for (const source of ["cli", "mcp", "web", "hook:Stop"]) {
      expect(clean(legacy({ source }), "main")?.source).toBe(source);
    }
  });

  it.each([
    null,
    [],
    1,
    "x",
    {},
    legacy({ wp: "../x" }),
    legacy({ time: "1" }),
    legacy({ time: true }),
    legacy({ time: Number.NaN }),
    legacy({ time: Infinity }),
  ])("rejects unusable stored entry %#", (raw) => {
    expect(clean(raw, "main")).toBeNull();
  });

  it("sanitizes old percentages, text, authors, and fallback IDs", () => {
    for (const percent of [true, 1.5, -1, 101, "40", null]) {
      expect(clean(legacy({ percent }), "main")?.percent).toBeNull();
    }
    expect(clean(legacy({ percent: 0 }), "main")?.percent).toBe(0);
    expect(clean(legacy({ percent: 100 }), "main")?.percent).toBe(100);
    expect(
      clean(
        legacy({
          id: "",
          text: "🦀".repeat(MAX_TEXT + 1),
          author: "🦀".repeat(MAX_AUTHOR + 1),
        }),
        "main",
      ),
    ).toMatchObject({
      id: "main:1:WP-C1",
      text: "🦀".repeat(MAX_TEXT),
      author: "🦀".repeat(MAX_AUTHOR),
    });
  });

  it("decodes each line independently and supports CRLF, CR, and a final complete line", () => {
    const { repo } = fixture();
    const path = journalPath(repo);
    mkdirSync(join(repo, JOURNAL_DIR), { recursive: true });
    writeFileSync(
      path,
      Buffer.concat([
        Buffer.from(`${JSON.stringify(legacy({ id: "a", text: "雪" }))}\r\n`),
        Buffer.from([0xff, 10]),
        Buffer.from(
          `${JSON.stringify(legacy({ id: "b" }))}\r${JSON.stringify(legacy({ id: "c" }))}`,
        ),
      ]),
    );
    expect(readJournal(path, "main").map((note) => note.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(readJournal(path, "main")[0].text).toBe("雪");
    expect(readJournal(join(repo, "missing"), "main")).toEqual([]);
    expect(readJournal(repo, "main")).toEqual([]);
  });

  it("rejects hook ready at append, read, and summarize boundaries", () => {
    const { repo } = fixture();
    const forged = {
      ...make("WP-C1", "ready", "done"),
      source: "hook:SessionEnd" as const,
    };
    expect(() => append(repo, forged)).toThrow(
      "hooks cannot mark a work package ready",
    );
    expect(existsSync(journalPath(repo))).toBe(false);
    expect(clean(forged, "main")).toBeNull();
    expect(clean({ ...forged, source: "hook:" }, "main")).toBeNull();
    expect(summarize([forged])["WP-C1"]).toBeUndefined();
    append(repo, make("WP-C1", "blocker", "dependency pending"));
    appendFileSync(journalPath(repo), `${JSON.stringify(forged)}\n`);
    const updates = readAll(repo);
    expect(updates).toHaveLength(1);
    expect(summarize(updates)["WP-C1"].blocker?.text).toBe(
      "dependency pending",
    );
  });

  it("discovers explicit external worktrees and follows symlinks without duplicate paths", () => {
    const { repo, wt } = fixture();
    const outside = mkdtempSync(join(tmpdir(), "rimewire-external-"));
    temporary.push(outside);
    append(repo, make("WP-C1", "note", "main"));
    append(wt, make("WP-C1", "note", "worker"));
    append(outside, make("WP-C1", "note", "outside"));
    symlinkSync(wt, join(repo, ".worktrees", "alias"), "dir");
    writeFileSync(join(repo, ".worktrees", "not-a-directory"), "x");
    expect(
      journals(repo, [repo, wt, wt, outside, join(repo, "missing")]),
    ).toHaveLength(3);
    expect(readAll(repo, [repo, wt, outside]).map((note) => note.text)).toEqual(
      ["main", "worker", "outside"],
    );
    const entries = readAll(repo, [wt]);
    expect(entries.find((entry) => entry.text === "main")?.checkout).toBe(
      "main",
    );
    expect(entries.find((entry) => entry.text === "worker")?.checkout).toBe(
      "WP-C1",
    );
  });

  it("handles a repository without journals or .worktrees", () => {
    const { repo } = fixture();
    rmSync(join(repo, ".worktrees"), { recursive: true });
    expect(readAll(repo)).toEqual([]);
    expect(journals(repo)).toEqual([]);
    expect(signatureParts(repo)).toEqual([]);
  });

  it("uses sync-loaded project configuration for paths, writes, reads, and signatures", () => {
    const { repo, wt } = fixture();
    mkdirSync(join(repo, ".rimewire"));
    writeFileSync(
      join(repo, ".rimewire", "config.toml"),
      'journalDir = "target/wp-notes"\nidPattern = "TASK-[0-9]+"\n',
    );
    const config: Config = loadConfig(repo);
    const before = signatureParts(repo, config);
    const note = make("TASK-3", "note", "configured", null, "", "cli", config);
    expect(append(wt, note, config)).toBe(
      join(wt, "target/wp-notes/notes.jsonl"),
    );
    expect(readAll(repo, [], config)[0]).toMatchObject({
      wp: "TASK-3",
      checkout: "WP-C1",
    });
    expect(readAll(repo)).toEqual([]);
    expect(signatureParts(repo, config)).not.toEqual(before);
    expect(signatureParts(repo, config)[0][0]).toBe("journal:WP-C1");
    expect(signatureParts(repo, config)[0][2]).toBe(
      readFileSync(journalPath(wt, config)).length,
    );
    appendFileSync(journalPath(wt, config), `${JSON.stringify(legacy())}\n`);
    expect(readAll(repo, [], config)).toHaveLength(1);
  });

  it("changes signatures for newly created journals and later appends", () => {
    const { repo, wt } = fixture();
    const empty = signatureParts(repo);
    append(wt, make("WP-C1", "note", "hi"));
    const first = signatureParts(repo);
    expect(first).not.toEqual(empty);
    append(wt, make("WP-C1", "note", "again"));
    expect(signatureParts(repo)).not.toEqual(first);
  });

  it("rejects a journal directory symlink outside before creating directories or writing", () => {
    const { repo } = fixture();
    const outside = mkdtempSync(join(tmpdir(), "rimewire-journal-outside-"));
    temporary.push(outside);
    symlinkSync(outside, join(repo, ".rimewire"), "dir");
    expect(() => append(repo, make("WP-C1", "note", "private"))).toThrow(
      "journal path must stay inside its checkout",
    );
    expect(existsSync(join(outside, "journal"))).toBe(false);
  });

  it("rejects a journal file symlink outside before opening or modifying the target", () => {
    const { repo } = fixture();
    const outside = mkdtempSync(join(tmpdir(), "rimewire-journal-outside-"));
    temporary.push(outside);
    const target = join(outside, "notes.jsonl");
    writeFileSync(target, "preserve me\n");
    mkdirSync(join(repo, JOURNAL_DIR), { recursive: true });
    symlinkSync(target, journalPath(repo), "file");
    expect(() => append(repo, make("WP-C1", "note", "private"))).toThrow(
      "journal path must stay inside its checkout",
    );
    expect(readFileSync(target, "utf8")).toBe("preserve me\n");
  });

  it("allows directory symlinks within the checkout and a symlinked checkout root", () => {
    const { repo } = fixture();
    mkdirSync(join(repo, "local-data"));
    symlinkSync(join(repo, "local-data"), join(repo, ".rimewire"), "dir");
    const wrapper = mkdtempSync(join(tmpdir(), "rimewire-checkout-alias-"));
    temporary.push(wrapper);
    const alias = join(wrapper, "checkout");
    symlinkSync(repo, alias, "dir");
    append(alias, make("WP-C1", "note", "local"));
    expect(readAll(repo)[0].text).toBe("local");
    expect(existsSync(join(repo, "local-data/journal/notes.jsonl"))).toBe(true);
  });
});

describe("package summaries", () => {
  it("keeps blockers until an unblock or ready", () => {
    const blocked = summarize(
      notes(["progress", "a", 20], ["blocker", "needs dep", null]),
    )["WP-X1"];
    expect(blocked).toMatchObject({
      percent: 20,
      step: "a",
      blocker: { text: "needs dep" },
      ready: null,
    });
    expect(
      summarize(
        notes(
          ["progress", "a", 20],
          ["blocker", "b", null],
          ["unblock", "", null],
        ),
      )["WP-X1"].blocker,
    ).toBeNull();
    expect(
      summarize(notes(["blocker", "b", null], ["ready", "all green", null]))[
        "WP-X1"
      ],
    ).toMatchObject({
      blocker: null,
      ready: { text: "all green", author: "sol", time: 1 },
      percent: 100,
      count: 2,
    });
  });

  it("reopens ready on progress or a blocker, but preserves ready on notes or unblock", () => {
    expect(
      summarize(notes(["ready", "", 100], ["progress", "review round 2", 80]))[
        "WP-X1"
      ],
    ).toMatchObject({ ready: null, percent: 80, step: "review round 2" });
    expect(
      summarize(notes(["ready", "", 100], ["blocker", "regression", null]))[
        "WP-X1"
      ],
    ).toMatchObject({ ready: null, blocker: { text: "regression" } });
    expect(
      summarize(
        notes(
          ["ready", "done", 95],
          ["note", "fyi", null],
          ["unblock", "", null],
        ),
      )["WP-X1"],
    ).toMatchObject({ ready: { text: "done" }, percent: 95, blocker: null });
  });

  it("keeps the last step and percentage through notes and empty progress", () => {
    const summary = summarize(
      notes(["progress", "step one", 10], ["note", "fyi", null]),
    )["WP-X1"];
    expect(summary).toMatchObject({
      step: "step one",
      percent: 10,
      authors: ["sol"],
      count: 2,
    });
    expect(summary.last).toEqual({
      kind: "note",
      text: "fyi",
      author: "sol",
      time: 1,
      percent: null,
    });
    expect(
      summarize(notes(["progress", "step one", 10], ["progress", "", null]))[
        "WP-X1"
      ],
    ).toMatchObject({ step: "step one", percent: 10, count: 2 });
  });

  it("keeps progress from clearing an open blocker and replaces later blockers", () => {
    const updates = notes(
      ["blocker", "first", null],
      ["progress", "working around it", 30],
    );
    expect(summarize(updates)["WP-X1"].blocker?.text).toBe("first");
    updates.push({
      ...make("WP-X1", "blocker", "second", null, "reviewer"),
      time: 2,
    });
    expect(summarize(updates)["WP-X1"].blocker).toEqual({
      text: "second",
      author: "reviewer",
      time: 2,
    });
  });

  it("tracks packages independently and authors once in first-seen order", () => {
    const updates = [
      make("WP-C1", "note", "a", null, "lead"),
      make("WP-C2", "ready", "b", null, "worker"),
      make("WP-C1", "progress", "c", 40, "worker"),
      make("WP-C1", "note", "d", null, "lead"),
    ];
    expect(summarize(updates)["WP-C1"]).toMatchObject({
      count: 3,
      percent: 40,
      authors: ["lead", "worker"],
    });
    expect(summarize(updates)["WP-C2"]).toMatchObject({
      count: 1,
      percent: 100,
      authors: ["worker"],
    });
    expect(summarize([])).toEqual({});
  });

  it("supports configured IDs that coincide with object prototype properties", () => {
    const config = parseConfig({ idPattern: "[A-Za-z_][A-Za-z_0-9]*" });
    const updates = ["constructor", "toString"].map((wp) =>
      make(wp, "note", "safe", null, "", "cli", config),
    );
    const summaries = summarize(updates);
    for (const update of updates) expect(summaries[update.wp].count).toBe(1);
    expect(JSON.parse(JSON.stringify(summaries)).constructor.count).toBe(1);
  });
});

const journalUrl = new URL("../src/journal.ts", import.meta.url).href;
const referencePath = fileURLToPath(
  new URL("./reference/python/", import.meta.url),
);
const nodeWriter = `
  import { append, make, MAX_TEXT } from ${JSON.stringify(journalUrl)};
  const [checkout, worker, count, serializedConfig] = process.argv.slice(1);
  const config = JSON.parse(serializedConfig);
  process.stdout.write("ready\\n");
  await new Promise(resolve => process.stdin.once("data", resolve));
  process.stdin.pause();
  for (let index = 0; index < Number(count); index++) {
    const prefix = worker + ":" + index + ":";
    append(checkout, make("WP-C1", "note", prefix + "雪".repeat(MAX_TEXT - prefix.length),
      null, worker, "cli", config), config);
  }
`;
const pythonWriter = `
import sys
sys.dont_write_bytecode = True
sys.path.insert(0, sys.argv[4])
from pathlib import Path
import journal
checkout, worker, count = sys.argv[1:4]
print("ready", flush=True)
sys.stdin.readline()
for index in range(int(count)):
    prefix = worker + ":" + str(index) + ":"
    journal.append(Path(checkout), journal.make("WP-C1", "note", prefix + "雪" * (journal.MAX_TEXT - len(prefix)), author=worker))
`;

async function concurrentWriters(
  checkout: string,
  config: Config,
  nodeCount: number,
  pythonCount: number,
  records: number,
) {
  const children = Array.from(
    { length: nodeCount + pythonCount },
    (_, index) => {
      const python = index >= nodeCount;
      const author = `${python ? "python" : "node"}-${index}`;
      return spawn(
        python ? "python3" : process.execPath,
        python
          ? [
              "-c",
              pythonWriter,
              checkout,
              author,
              String(records),
              referencePath,
            ]
          : [
              "--input-type=module",
              "--eval",
              nodeWriter,
              checkout,
              author,
              String(records),
              JSON.stringify(config),
            ],
        { stdio: ["pipe", "pipe", "pipe"], timeout: 15_000 },
      );
    },
  );
  const ready = children.map(
    (child) =>
      new Promise<void>((resolve, reject) => {
        child.stdout.once("data", (data: Buffer) => {
          if (data.toString().trim() === "ready") resolve();
          else reject(new Error("writer did not reach the start barrier"));
        });
        child.once("error", reject);
        child.once("exit", () =>
          reject(new Error("writer exited before the start barrier")),
        );
      }),
  );
  const done = children.map(
    (child) =>
      new Promise<void>((resolve, reject) => {
        let stderr = "";
        child.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });
        child.once("error", reject);
        child.once("close", (code, signal) => {
          if (code === 0) resolve();
          else
            reject(new Error(`writer failed (${code ?? signal}): ${stderr}`));
        });
      }),
  );
  const complete = Promise.all(done);
  // Attach the handler immediately so a startup failure cannot become unhandled.
  void complete.catch(() => {});
  try {
    await Promise.all(ready);
    for (const child of children) child.stdin.end("go\n");
    await complete;
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.allSettled(done);
  }
}

function expectCompleteWrites(
  checkout: string,
  config: Config,
  writers: number,
  records: number,
) {
  const data = readFileSync(journalPath(checkout, config), "utf8");
  expect(data.endsWith("\n")).toBe(true);
  const raw = data
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Note);
  expect(raw).toHaveLength(writers * records);
  expect(new Set(raw.map((note) => note.id)).size).toBe(raw.length);
  const perAuthor = new Map<string, Set<number>>();
  for (const note of raw) {
    const [author, index, padding] = note.text.split(":");
    expect(author).toBe(note.author);
    expect(padding).toBe("雪".repeat(MAX_TEXT - `${author}:${index}:`.length));
    expect(note.text).toHaveLength(MAX_TEXT);
    const indexes = perAuthor.get(author) ?? new Set<number>();
    indexes.add(Number(index));
    perAuthor.set(author, indexes);
  }
  expect(perAuthor.size).toBe(writers);
  for (const indexes of perAuthor.values()) {
    expect([...indexes].sort((a, b) => a - b)).toEqual(
      Array.from({ length: records }, (_, index) => index),
    );
  }
  expect(readAll(checkout, [], config)).toHaveLength(writers * records);
}

describe("real concurrent subprocess appends", () => {
  it("preserves every full-size record from eight Node processes", async () => {
    const { repo } = fixture();
    const config = parseConfig({});
    await concurrentWriters(repo, config, 8, 0, 80);
    expectCompleteWrites(repo, config, 8, 80);
  }, 20_000);

  const hasLegacyPython =
    spawnSync("python3", ["-c", "import fcntl"], { timeout: 5_000 }).status ===
    0;
  it.skipIf(!hasLegacyPython)(
    "coexists with legacy fcntl-locked Python writers on a local filesystem",
    async () => {
      const { repo } = fixture();
      const config = parseConfig({ journalDir: "target/wp-notes" });
      await concurrentWriters(repo, config, 4, 4, 80);
      expectCompleteWrites(repo, config, 8, 80);
      const updates = readAll(repo, [], config);
      expect(updates.filter((note) => note.source === "legacy")).toHaveLength(
        320,
      );
      expect(updates.filter((note) => note.source === "cli")).toHaveLength(320);
    },
    20_000,
  );
});
