import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { build, everyItem } from "../src/board.js";
import { main } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { runHook } from "../src/hooks.js";
import {
  append,
  journalPath,
  make,
  readJournal,
  summarize,
} from "../src/journal.js";
import { fixtureGit, removeRepo, tempRepo, write } from "./fixtures/helpers.js";

const events = [
  ["SessionStart", "Claude session started."],
  ["SessionEnd", "Claude session ended."],
  ["SubagentStart", "Claude subagent started."],
  ["SubagentStop", "Claude subagent stopped."],
  ["Stop", "Claude agent stopped."],
  ["CodexSessionStart", "Codex session started."],
  ["CodexSessionEnd", "Codex session ended."],
  ["CodexSubagentStart", "Codex subagent started."],
  ["CodexSubagentStop", "Codex subagent stopped."],
  ["CodexStop", "Codex agent stopped."],
  ["OpenCodeSessionCreated", "OpenCode session created."],
  ["OpenCodeSessionIdle", "OpenCode session idle."],
  ["PiSessionStart", "Pi session started."],
  ["PiSessionShutdown", "Pi session shut down."],
  ["PiAgentEnd", "Pi agent ended."],
] as const;
const tracker = (status = "planned") => `# Packages
## Phase 1
| ID | Title | Status |
| --- | --- | --- |
| TASK-1 | First package | ${status} |
| TASK-2 | Second package | planned |
`;
const settings = `tracker = "plans/packages.md"
idPattern = "TASK-[0-9]+"
journalDir = "local/activity"
`;
const optIn = `${settings}[hooks]\nenabled = true\npackage = "TASK-1"\n`;

describe("optional harness lifecycle hooks", () => {
  let repo: string;
  let outside: string;
  let stderr: string;

  beforeEach(() => {
    repo = tempRepo();
    outside = tempRepo();
    mkdirSync(join(repo, ".git"));
    write(repo, ".rimewire/config.toml", optIn);
    write(repo, "plans/packages.md", tracker());
    mkdirSync(join(repo, "src", "nested"), { recursive: true });
    stderr = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    removeRepo(repo);
    removeRepo(outside);
  });

  function notes(checkout = repo, configRoot = repo) {
    const config = loadConfig(configRoot);
    return readJournal(journalPath(checkout, config), "fixture", config);
  }

  it("routes enabled hooks to the branch package without a fixed package", async () => {
    rmSync(join(repo, ".git"), { recursive: true });
    fixtureGit(repo, "init", "--initial-branch=work/TASK-2-parser");
    write(
      repo,
      ".rimewire/config.toml",
      `${settings}[hooks]\nenabled = true\n`,
    );
    await runHook("SessionStart", { cwd: repo });
    expect(notes()).toHaveLength(2);
    expect(notes()[0].wp).toBe("TASK-2");
    expect(notes()[1]).toMatchObject({
      source: "hook:GitSnapshot",
      kind: "note",
    });
    await runHook("Stop", { cwd: repo });
    expect(
      notes().filter((entry) => entry.source === "hook:GitSnapshot"),
    ).toHaveLength(1);
    write(repo, "private-filename.txt", "private contents");
    await runHook("Stop", { cwd: repo });
    const snapshots = notes().filter(
      (entry) => entry.source === "hook:GitSnapshot",
    );
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1].text).not.toContain("private");
    expect(snapshots[1].percent).toBeNull();
  });

  it("does not route an unmatched branch to an arbitrary package", async () => {
    rmSync(join(repo, ".git"), { recursive: true });
    fixtureGit(repo, "init", "--initial-branch=main");
    write(
      repo,
      ".rimewire/config.toml",
      `${settings}[hooks]\nenabled = true\n`,
    );
    await runHook("SessionStart", { cwd: repo });
    expect(notes()).toHaveLength(0);
  });

  it.each(events)(
    "%s appends a bounded activity note with fixed provenance and author",
    async (event, text) => {
      const context = await runHook(event, {
        cwd: join(repo, "src", "nested"),
      });
      const [note] = notes();
      expect(notes()).toHaveLength(1);
      expect(note).toMatchObject({
        wp: "TASK-1",
        kind: "note",
        text,
        percent: null,
        author: "agent",
        source: `hook:${event}`,
      });
      const raw = JSON.parse(
        readFileSync(journalPath(repo, loadConfig(repo)), "utf8"),
      );
      expect(Object.keys(raw).sort()).toEqual(
        [
          "id",
          "wp",
          "kind",
          "text",
          "percent",
          "author",
          "time",
          "source",
        ].sort(),
      );
      expect(raw.text.length).toBeLessThan(100);
      expect(existsSync(journalPath(repo))).toBe(false);
      expect(stderr).toBe("");
      if (
        [
          "SessionStart",
          "SubagentStart",
          "CodexSessionStart",
          "CodexSubagentStart",
          "OpenCodeSessionCreated",
          "PiSessionStart",
        ].includes(event)
      ) {
        expect(context).toContain("Rimewire");
        for (const tool of [
          "board_overview",
          "get_package",
          "post_update",
          "list_updates",
          "board_url",
        ])
          expect(context).toContain(tool);
        expect(context).not.toMatch(/mcp__|exit|completion|ready|done/i);
      } else expect(context).toBeUndefined();
    },
  );

  it("reads only cwd, never private fields or caller-controlled update attributes", async () => {
    const privateValue = "PRIVATE-prompt-session-transcript-secret";
    const payload: Record<string, unknown> = { cwd: repo };
    const unread = [
      "prompt",
      "transcript",
      "transcript_path",
      "input",
      "last_assistant_message",
      "lastAssistantMessage",
      "Message",
      "session_id",
      "agent_id",
      "agent_type",
      "package",
      "wp",
      "kind",
      "percent",
      "text",
      "source",
      "author",
      "hook_event_name",
    ];
    const readers = unread.map((field) => {
      const getter = vi.fn(() => {
        throw new Error(privateValue);
      });
      Object.defineProperty(payload, field, { enumerable: true, get: getter });
      return getter;
    });
    const context = await runHook("SessionStart", payload);
    expect(context).toContain("board_overview");
    for (const getter of readers) expect(getter).not.toHaveBeenCalled();
    const bytes = readFileSync(journalPath(repo, loadConfig(repo)), "utf8");
    expect(bytes).not.toContain(privateValue);
    expect(context).not.toContain(privateValue);
    expect(stderr).toBe("");
  });

  it("ignores injected completion, source, author, and percent values", async () => {
    await runHook("SessionEnd", {
      cwd: repo,
      hook_event_name: "SessionStart",
      wp: "TASK-2",
      package: "TASK-2",
      kind: "ready",
      percent: 100,
      text: "PRIVATE fabricated completion",
      source: "mcp",
      author: "PRIVATE session owner",
      session_id: "PRIVATE session identifier",
      prompt: "PRIVATE prompt",
      input: { secret: "PRIVATE input" },
      transcript_path: join(outside, "PRIVATE-transcript"),
      last_assistant_message: "PRIVATE response",
    });
    const [note] = notes();
    expect(note).toMatchObject({
      wp: "TASK-1",
      kind: "note",
      source: "hook:SessionEnd",
      percent: null,
      author: "agent",
      text: "Claude session ended.",
    });
    expect(summarize(notes())["TASK-1"].ready).toBeNull();
    expect(
      readFileSync(journalPath(repo, loadConfig(repo)), "utf8"),
    ).not.toContain("PRIVATE");
  });

  it.each(events)(
    "%s preserves an explicit ready update and board status",
    async (event) => {
      const config = loadConfig(repo);
      append(
        repo,
        make(
          "TASK-1",
          "ready",
          "Acceptance checks passed",
          100,
          "lead",
          "cli",
          config,
        ),
        config,
      );
      await runHook(event, { cwd: repo });
      const summary = summarize(notes())["TASK-1"];
      expect(summary.ready).toMatchObject({
        text: "Acceptance checks passed",
        author: "lead",
      });
      expect(summary.percent).toBe(100);
      expect(summary.last?.kind).toBe("note");
      const item = [...everyItem(build(repo, config, false))].find(
        (item) => item.id === "TASK-1",
      );
      expect(item?.cls).toBe("done");
      expect(item?.agent?.ready?.text).toBe("Acceptance checks passed");
    },
  );

  it("exit events preserve a blocker and progress instead of marking completion", async () => {
    const config = loadConfig(repo);
    append(
      repo,
      make(
        "TASK-1",
        "progress",
        "Implementation started",
        30,
        "lead",
        "mcp",
        config,
      ),
      config,
    );
    append(
      repo,
      make(
        "TASK-1",
        "blocker",
        "Needs a dependency",
        null,
        "lead",
        "mcp",
        config,
      ),
      config,
    );
    for (const event of ["SessionEnd", "SubagentStop", "Stop"])
      expect(await runHook(event, { cwd: repo })).toBeUndefined();
    const summary = summarize(notes())["TASK-1"];
    expect(summary.blocker?.text).toBe("Needs a dependency");
    expect(summary.percent).toBe(30);
    expect(summary.step).toBe("Implementation started");
    expect(summary.ready).toBeNull();
    expect([...everyItem(build(repo, config, false))][0].cls).toBe("blocked");
  });

  it.each([
    settings,
    `${settings}[hooks]\n`,
    `${settings}[hooks]\npackage = "TASK-1"\n`,
    `${settings}[hooks]\nenabled = false\npackage = "TASK-1"\n`,
    `${settings}[hooks]\nenabled = true\n`,
    `${settings}[hooks]\nenabled = true\npackage = "TASK-99"\n`,
    `${settings}[hooks]\nenabled = true\npackage = "OTHER-1"\n`,
    `${settings}[hooks]\nenabled = true\npackage = "../TASK-1"\n`,
  ])(
    "is a no-op without opt-in and a valid known package (%#)",
    async (configText) => {
      write(repo, ".rimewire/config.toml", configText);
      expect(await runHook("SessionStart", { cwd: repo })).toBeUndefined();
      expect(existsSync(join(repo, "local", "activity"))).toBe(false);
      expect(existsSync(journalPath(repo))).toBe(false);
    },
  );

  it("is a no-op when project configuration is absent", async () => {
    rmSync(join(repo, ".rimewire", "config.toml"));
    expect(await runHook("SessionStart", { cwd: repo })).toBeUndefined();
    expect(existsSync(journalPath(repo))).toBe(false);
    expect(stderr).toBe("");
  });

  it("uses the board parser rather than treating a prose mention as a known package", async () => {
    write(repo, "plans/packages.md", "# Notes\nTASK-1 is mentioned here.\n");
    expect(await runHook("SessionStart", { cwd: repo })).toBeUndefined();
    expect(notes()).toHaveLength(0);
    write(repo, "plans/TASK-1.md", "# TASK-1 — Untracked board package\n");
    expect(await runHook("SessionStart", { cwd: repo })).toContain(
      "board_overview",
    );
    expect(notes()).toHaveLength(1);
  });

  it.each([
    "",
    "PostToolUse",
    "UserPromptSubmit",
    "sessionstart",
    "toString",
    "__proto__",
    "Stop\nPRIVATE",
  ])(
    "ignores unknown events without reading the payload (%#)",
    async (event) => {
      const cwd = vi.fn(() => {
        throw new Error("PRIVATE cwd");
      });
      const payload = Object.defineProperty({}, "cwd", { get: cwd });
      expect(await runHook(event, payload)).toBeUndefined();
      expect(cwd).not.toHaveBeenCalled();
      expect(notes()).toHaveLength(0);
      expect(stderr).toBe("");
    },
  );

  it.each([
    null,
    undefined,
    false,
    1,
    "PRIVATE input",
    [],
    {},
    { cwd: null },
    { cwd: 12 },
    { cwd: "" },
    { cwd: "   " },
    { cwd: "." },
  ])(
    "ignores invalid payloads without inferring a checkout (%#)",
    async (payload) => {
      expect(await runHook("SessionStart", payload)).toBeUndefined();
      expect(notes()).toHaveLength(0);
      expect(stderr).toBe("");
    },
  );

  it("ignores cwd outside Git or pointing at a file or removed directory", async () => {
    for (const cwd of [
      outside,
      join(repo, "plans", "packages.md"),
      join(outside, "missing"),
    ])
      expect(await runHook("SessionStart", { cwd })).toBeUndefined();
    expect(notes()).toHaveLength(0);
  });

  it("fails open with private config and journal failures without echoing error content", async () => {
    write(
      repo,
      ".rimewire/config.toml",
      `${optIn}\nPRIVATE_bad_config = "PRIVATE-config-secret"\n`,
    );
    await expect(
      runHook("SessionStart", { cwd: repo }),
    ).resolves.toBeUndefined();
    expect(stderr).toBe(
      "rimewire: optional hook could not run; continuing without a board update.\n",
    );
    expect(stderr).not.toContain("PRIVATE");
    write(repo, ".rimewire/config.toml", optIn);
    mkdirSync(join(repo, "local"));
    symlinkSync(outside, join(repo, "local", "activity"));
    await expect(runHook("Stop", { cwd: repo })).resolves.toBeUndefined();
    expect(existsSync(join(outside, "notes.jsonl"))).toBe(false);
    expect(stderr).not.toContain(outside);
    expect(notes()).toHaveLength(0);
  });

  it("fails open even when cwd access and diagnostics themselves fail", async () => {
    const payload = Object.defineProperty({}, "cwd", {
      get() {
        throw new Error("PRIVATE cwd secret");
      },
    });
    vi.mocked(process.stderr.write).mockImplementation(() => {
      throw new Error("closed diagnostic stream");
    });
    await expect(runHook("Stop", payload)).resolves.toBeUndefined();
    expect(notes()).toHaveLength(0);
  });

  it("uses main-repo config for a linked worktree and writes only in that checkout", async () => {
    const worker = join(outside, "worker");
    mkdirSync(join(worker, "nested"), { recursive: true });
    const gitdir = join(repo, ".git", "worktrees", "worker");
    write(worker, ".git", `gitdir: ${relative(worker, gitdir)}\n`);
    write(repo, ".git/worktrees/worker/commondir", "../..\n");
    expect(
      await runHook("SubagentStart", { cwd: join(worker, "nested") }),
    ).toContain("get_package");
    expect(notes(worker)).toHaveLength(1);
    expect(notes(worker)[0].source).toBe("hook:SubagentStart");
    expect(existsSync(journalPath(repo, loadConfig(repo)))).toBe(false);
    expect(existsSync(journalPath(worker))).toBe(false);
  });

  it("honors worktree config and local board packages without borrowing main opt-in", async () => {
    const worker = join(outside, "worker");
    const gitdir = join(repo, ".git", "worktrees", "worker");
    write(worker, ".git", `gitdir: ${gitdir}\n`);
    write(repo, ".git/worktrees/worker/commondir", "../..\n");
    write(
      worker,
      ".rimewire/config.toml",
      `${settings}[hooks]\nenabled = false\npackage = "TASK-1"\n`,
    );
    expect(await runHook("SessionStart", { cwd: worker })).toBeUndefined();
    write(
      worker,
      ".rimewire/config.toml",
      `${settings}[hooks]\nenabled = true\npackage = "TASK-3"\n`,
    );
    write(
      worker,
      "plans/packages.md",
      tracker().replaceAll("TASK-1", "TASK-3"),
    );
    expect(await runHook("SessionStart", { cwd: worker })).toContain(
      "board_overview",
    );
    expect(notes(worker, worker)[0].wp).toBe("TASK-3");
    expect(notes()).toHaveLength(0);
  });

  it("discovers real external Git worktrees and publishes a note visible on the main board", async () => {
    rmSync(join(repo, ".git"), { recursive: true });
    fixtureGit(repo, "init", "--initial-branch=main");
    write(repo, ".gitignore", "local/activity/\n");
    fixtureGit(repo, "add", ".");
    fixtureGit(repo, "commit", "-m", "fixture");
    const worker = join(outside, "actual-worker");
    fixtureGit(repo, "worktree", "add", "-b", "task/TASK-1-hooks", worker);
    rmSync(join(worker, ".rimewire", "config.toml"));
    rmSync(join(worker, "plans"), { recursive: true });
    mkdirSync(join(worker, "src", "nested"), { recursive: true });
    await runHook("SubagentStop", { cwd: join(worker, "src", "nested") });
    expect(notes(worker)).toHaveLength(2);
    expect(notes()).toHaveLength(0);
    const board = build(repo);
    expect(board.activity).toHaveLength(2);
    expect(
      board.activity.find((entry) => entry.source === "hook:SubagentStop"),
    ).toMatchObject({
      checkout: "actual-worker",
      kind: "note",
      source: "hook:SubagentStop",
    });
    expect([...everyItem(board)][0].cls).not.toBe("done");
  });

  it("chooses the nearest nested checkout and resolves symlinked cwd", async () => {
    const nested = join(repo, "src", "independent");
    mkdirSync(join(nested, ".git"), { recursive: true });
    write(nested, ".rimewire/config.toml", optIn);
    write(nested, "plans/packages.md", tracker());
    const alias = join(outside, "alias");
    symlinkSync(nested, alias);
    await runHook("Stop", { cwd: alias });
    expect(notes(nested, nested)).toHaveLength(1);
    expect(notes()).toHaveLength(0);
  });

  it("reloads opt-in each time, and repeated events remain harmless activity notes", async () => {
    await runHook("Stop", { cwd: repo });
    await runHook("Stop", { cwd: repo });
    expect(notes()).toHaveLength(2);
    expect(notes()[0].id).not.toBe(notes()[1].id);
    write(repo, ".rimewire/config.toml", settings);
    expect(await runHook("SessionStart", { cwd: repo })).toBeUndefined();
    expect(notes()).toHaveLength(2);
    expect(summarize(notes())["TASK-1"].ready).toBeNull();
  });

  it.each([
    ["CodexSessionStart", "SessionStart"],
    ["CodexSubagentStart", "SubagentStart"],
  ])(
    "CLI %s returns the native Codex event name with harness-specific journal provenance",
    async (event, native) => {
      let output = "";
      expect(
        await main(["hook", event], {
          cwd: repo,
          stdin: async () => JSON.stringify({ cwd: repo }),
          stdout: (text) => {
            output += text;
          },
          stderr: (text) => {
            stderr += text;
          },
        }),
      ).toBe(0);
      expect(JSON.parse(output).hookSpecificOutput).toEqual({
        hookEventName: native,
        additionalContext: expect.stringContaining("board_overview"),
      });
      expect(notes()[0].source).toBe(`hook:${event}`);
      expect(stderr).toBe("");
    },
  );

  it("CLI malformed secret payload errors fail open with a fixed, private diagnostic", async () => {
    const secret = "PRIVATE-malformed-hook-payload-secret";
    let stdout = "";
    let diagnostic = "";
    const input = vi.fn(async () => `{"cwd":"${repo}","prompt":"${secret}"`);
    const code = await main(["hook", "SessionStart"], {
      cwd: repo,
      stdin: input,
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        diagnostic += text;
      },
    });
    expect(input).toHaveBeenCalledOnce();
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(diagnostic).toBe(
      "rimewire: hook skipped (invalid input or unavailable project)\n",
    );
    expect(diagnostic + stderr).not.toContain(secret);
    expect(notes()).toHaveLength(0);
  });
});
