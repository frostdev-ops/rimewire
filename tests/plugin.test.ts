import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";

it("bundled plugin runs MCP, setup, hooks and scoped web assets outside the source checkout", async () => {
  const root = mkdtempSync(join(tmpdir(), "rimewire-plugin-"));
  const plugin = join(root, "cache with spaces", "rimewire");
  const repo = join(root, "project");
  const state = join(root, "state");
  cpSync(resolve("plugins/rimewire"), plugin, { recursive: true });
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "AGENTS.md"), "Keep this instruction.\n");
  const cli = join(plugin, "dist/cli.js");
  const env = {
    ...process.env,
    RIMEWIRE_STATE_DIR: state,
    RIMEWIRE_HEARTBEAT_MS: "100",
    RIMEWIRE_LEASE_MS: "1000",
    RIMEWIRE_IDLE_MS: "300",
  };
  execFileSync(process.execPath, [cli, "setup", "--repo", repo, "--json"], {
    env,
    stdio: "pipe",
  });
  expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toContain(
    "Keep this instruction.",
  );
  // The bundled CLI can register the other harnesses without source dependencies.
  for (const harness of ["opencode", "pi"]) {
    const installed = JSON.parse(
      execFileSync(
        process.execPath,
        [cli, "install", harness, "--project", "--json"],
        { cwd: repo, env, encoding: "utf8" },
      ),
    );
    expect(installed.changed.length).toBeGreaterThan(0);
    const repeated = JSON.parse(
      execFileSync(
        process.execPath,
        [cli, "install", harness, "--project", "--json"],
        { cwd: repo, env, encoding: "utf8" },
      ),
    );
    expect(repeated.changed).toEqual([]);
    const removed = JSON.parse(
      execFileSync(
        process.execPath,
        [cli, "uninstall", harness, "--project", "--json"],
        { cwd: repo, env, encoding: "utf8" },
      ),
    );
    expect(removed.changed.length).toBeGreaterThan(0);
  }
  const tracker = join(repo, "docs/board/README.md");
  writeFileSync(
    tracker,
    readFileSync(tracker, "utf8") +
      "| TASK-1 | Integration | any | — | planned | — |\n",
  );
  const client = new Client({ name: "plugin-artifact-test", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, "mcp", "--repo", repo, "--port", "0"],
        env,
        stderr: "pipe",
      }),
    );
    expect((await client.listTools()).tools).toHaveLength(5);
    const result = await client.callTool({ name: "board_url", arguments: {} });
    expect(result.isError).not.toBe(true);
    const url = (result.structuredContent as { url: string }).url;
    for (const path of ["", "board.js", "board.css", "api/board"])
      expect((await fetch(url + path)).status).toBe(200);
    const note = await client.callTool({
      name: "post_update",
      arguments: { wp: "TASK-1", kind: "note", text: "Cached plugin works" },
    });
    expect(note.isError).not.toBe(true);
    execFileSync(process.execPath, [cli, "hook", "Stop"], {
      env,
      input: JSON.stringify({ cwd: repo, last_assistant_message: "PRIVATE" }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(
      readFileSync(join(repo, ".rimewire/journal/notes.jsonl"), "utf8"),
    ).not.toContain("PRIVATE");
    await client.close();
    const deadline = Date.now() + 5000;
    while (existsSync(join(state, "daemon.json")) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 25));
    expect(existsSync(join(state, "daemon.json"))).toBe(false);
  } finally {
    await client.close();
    if (existsSync(join(state, "daemon.json"))) {
      try {
        const { pid } = JSON.parse(
          readFileSync(join(state, "daemon.json"), "utf8"),
        );
        process.kill(pid, "SIGTERM");
      } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
