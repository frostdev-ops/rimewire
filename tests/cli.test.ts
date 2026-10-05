import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findCheckout, main, mainRepo } from "../src/cli.js";
import { journalPath, readAll, readJournal } from "../src/journal.js";

describe("direct checkout journal CLI", () => {
  let repo: string;
  let worker: string;
  let outside: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "rimewire-cli-"));
    outside = mkdtempSync(join(tmpdir(), "rimewire-external-"));
    mkdirSync(join(repo, ".git", "worktrees", "TASK-1"), { recursive: true });
    mkdirSync(join(repo, "docs", "board"), { recursive: true });
    writeFileSync(
      join(repo, "docs", "board", "README.md"),
      "| [TASK-1](TASK-1.md) | first | planned |\n",
    );
    worker = join(repo, ".worktrees", "TASK-1");
    mkdirSync(join(worker, "src"), { recursive: true });
    writeFileSync(
      join(worker, ".git"),
      `gitdir: ${join(repo, ".git", "worktrees", "TASK-1")}\n`,
    );
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  async function run(
    args: string[],
    cwd = repo,
    stdin = "",
    env: NodeJS.ProcessEnv = { USER: "lead" },
  ) {
    let stdout = "";
    let stderr = "";
    const code = await main(args, {
      cwd,
      env,
      stdin: async () => stdin,
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });
    return { code, stdout, stderr };
  }

  it("discovers a nested worker checkout and writes only its own journal", async () => {
    expect(findCheckout(join(worker, "src"))).toBe(worker);
    expect(mainRepo(worker)).toBe(repo);
    const result = await run(
      ["progress", "TASK-1", "-p", "40", "engine", "offers", "done"],
      join(worker, "src"),
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(existsSync(journalPath(repo))).toBe(false);
    const [note] = readJournal(journalPath(worker), "TASK-1");
    expect(note.text).toBe("engine offers done");
    expect(note.percent).toBe(40);
    expect(note.author).toBe("TASK-1");
    expect(note.source).toBe("cli");
    expect(JSON.parse(readFileSync(journalPath(worker), "utf8")).source).toBe(
      "cli",
    );
  });

  it("accepts stdin and --text and lists merged updates with provenance and checkout", async () => {
    const posted = await run(
      ["blocker", "TASK-1", "-", "--json", "--author", "sol-3"],
      repo,
      "needs a dep\n\nversion 1.2\n",
    );
    expect(posted.code).toBe(0);
    expect(JSON.parse(posted.stdout).text).toBe("needs a dep\n\nversion 1.2");
    expect(JSON.parse(posted.stdout).author).toBe("sol-3");
    const update = await run(
      ["note", "TASK-1", "--text", "from the worker", "--json"],
      worker,
    );
    expect(update.code).toBe(0);
    const listed = await run(["list", "TASK-1", "--json"], worker);
    const notes = JSON.parse(listed.stdout);
    expect(notes.map((note: { checkout: string }) => note.checkout)).toEqual([
      "main",
      "TASK-1",
    ]);
    expect(notes.map((note: { source: string }) => note.source)).toEqual([
      "cli",
      "cli",
    ]);
    expect(
      (
        await run(
          ["progress", "TASK-1", "--text", "-", "--json"],
          worker,
          "step from stdin\n",
        )
      ).code,
    ).toBe(0);
  });

  it("warns for unknown ids, while invalid input fails without appending", async () => {
    const result = await run(["note", "TASK-unknown", "hello"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("warning");
    for (const args of [
      ["note", "TASK-1"],
      ["progress", "TASK-1"],
      ["blocker", "TASK-1", " "],
      ["progress", "TASK-1", "-p", "140", "x"],
      ["progress", "TASK-1", "-p", "50.5", "x"],
      ["note", "../escape", "hello"],
      ["note", "TASK-1", "--text", "x".repeat(4001)],
      ["note", "TASK-1", "positional", "--text", "flag"],
    ])
      expect((await run(args)).code, args.join(" ").slice(0, 80)).toBe(2);
    expect(readAll(repo)).toHaveLength(1);
  });

  it("supports all state update commands, empty unblock/ready, and percent-only progress", async () => {
    for (const args of [
      ["note", "TASK-1", "FYI"],
      ["progress", "TASK-1", "-p", "20"],
      ["blocker", "TASK-1", "needs API"],
      ["unblock", "TASK-1"],
      ["ready", "TASK-1"],
    ])
      expect((await run(args)).code).toBe(0);
    expect(readAll(repo).map((note) => note.kind)).toEqual([
      "note",
      "progress",
      "blocker",
      "unblock",
      "ready",
    ]);
  });

  it("uses project tracker/id/journal config from the main repo for unconfigured workers", async () => {
    mkdirSync(join(repo, ".rimewire"));
    mkdirSync(join(repo, "plans"));
    writeFileSync(
      join(repo, ".rimewire", "config.toml"),
      'name="Custom"\ntracker="plans/packages.md"\njournalDir="local/updates"\nidPattern="[A-Z]+_[0-9]+"\n',
    );
    writeFileSync(join(repo, "plans", "packages.md"), "| PKG_7 | planned |\n");
    const result = await run(
      ["progress", "PKG_7", "--text", "custom", "-p", "30", "--json"],
      worker,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(existsSync(join(worker, "local", "updates", "notes.jsonl"))).toBe(
      true,
    );
    expect(existsSync(join(repo, "local", "updates", "notes.jsonl"))).toBe(
      false,
    );
    const listed = await run(["list", "PKG_7", "--json"]);
    expect(JSON.parse(listed.stdout)[0].wp).toBe("PKG_7");
  });

  it("uses RIMEWIRE_AGENT and explicit authors and can post via --checkout outside a repo", async () => {
    const env = { RIMEWIRE_AGENT: "worker-name", USER: "owner" };
    const automatic = await run(
      ["note", "TASK-1", "env", "--json"],
      worker,
      "",
      env,
    );
    expect(JSON.parse(automatic.stdout).author).toBe("worker-name");
    const explicit = await run(
      [
        "note",
        "TASK-1",
        "direct",
        "--author",
        "named",
        "--checkout",
        worker,
        "--json",
      ],
      outside,
      "",
      env,
    );
    expect(JSON.parse(explicit.stdout).author).toBe("named");
    expect((await run(["note", "TASK-1", "x"], outside)).code).toBe(2);
  });

  it("supports list filters, limits, empty output, and multiline display", async () => {
    expect((await run(["list"])).stdout).toBe("No updates yet.\n");
    await run(["note", "TASK-1", "--text", "first\nsecond"]);
    await run(["note", "TASK-2", "other"]);
    await run(["note", "TASK-1", "last"]);
    expect(
      JSON.parse((await run(["list", "-n", "1", "--json"])).stdout),
    ).toHaveLength(1);
    expect(
      JSON.parse((await run(["list", "TASK-1", "-n", "0", "--json"])).stdout),
    ).toHaveLength(2);
    const display = await run(["list", "TASK-1", "-n", "0"]);
    expect(display.stdout).toContain("second");
    expect(display.stdout).toContain("(cli)");
  });

  it("discovers external Git worktrees when listing from the main repository", async () => {
    rmSync(join(repo, ".git"), { recursive: true });
    execFileSync("git", ["init", "--initial-branch=main", repo], {
      stdio: "ignore",
    });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "fixture",
      ],
      { cwd: repo, stdio: "ignore" },
    );
    const external = join(outside, "external-worker");
    execFileSync("git", ["worktree", "add", "-b", "work/TASK-1", external], {
      cwd: repo,
      stdio: "ignore",
    });
    const result = await run(
      ["progress", "TASK-1", "--text", "external update", "--json"],
      external,
    );
    expect(result.code).toBe(0);
    expect(mainRepo(external)).toBe(repo);
    expect(existsSync(journalPath(repo))).toBe(false);
    const listed = JSON.parse((await run(["list", "--json"])).stdout);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      text: "external update",
      source: "cli",
      checkout: "external-worker",
    });
  });

  it("reports write failures separately from validation errors", async () => {
    mkdirSync(join(repo, ".rimewire"));
    writeFileSync(join(repo, ".rimewire", "journal"), "not a directory");
    const result = await run(["note", "TASK-1", "hello"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("could not write the journal");
  });

  it("has executable help and rejects invalid options and unfinished commands", async () => {
    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("serve");
    expect(help.stdout).toContain("mcp");
    expect(help.stdout).toContain("progress");
    expect((await run(["serve", "--port", "70000"])).code).toBe(2);
    expect((await run(["serve", "--interval", "0"])).code).toBe(2);
    expect((await run(["mcp", "--port", "70000"])).code).toBe(2);
    expect((await run(["install"])).code).toBe(2);
  });
});
