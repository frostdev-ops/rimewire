import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "vitest";
import { fixtureGit, projectDirectory, write } from "./fixtures/helpers.js";

test("stdio handshake, all tools, explicit MCP updates, and shared daemon idle shutdown", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "rimewire-mcp-stdio-test-"));
  const root = join(sandbox, "project");
  const state = join(sandbox, "state");
  write(root, ".rimewire/config.toml", 'name = "Stdio fixture"\n');
  write(
    root,
    "docs/board/README.md",
    "# Board\n\n## Phase 1\n\n| ID | Title | Status |\n| --- | --- | --- |\n| TEST-1 | MCP integration | planned |\n| TEST-2 | Session exit is not completion | planned |\n",
  );
  fixtureGit(root, "init", "--initial-branch=main");
  const lock = join(state, "daemon.json");
  const journal = join(root, ".rimewire/journal/notes.jsonl");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(projectDirectory, "dist/cli.js"),
      "mcp",
      "--repo",
      root,
      "--port",
      "0",
    ],
    env: {
      RIMEWIRE_STATE_DIR: state,
      RIMEWIRE_HEARTBEAT_MS: "100",
      RIMEWIRE_LEASE_MS: "500",
      RIMEWIRE_IDLE_MS: "300",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "rimewire-stdio-test", version: "1.0.0" });
  let diagnostics = "";
  let daemonPid: number | undefined;
  transport.stderr?.on("data", (chunk) => {
    diagnostics += String(chunk);
  });

  async function tool<T>(name: string, args = {}) {
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout: 5000,
    });
    expect(result.isError, diagnostics).not.toBe(true);
    return result.structuredContent as T;
  }

  function notes() {
    return readFileSync(journal, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }

  const http = (url: string) =>
    fetch(url, { signal: AbortSignal.timeout(1000) });
  function signalDaemon(pid: number, signal: NodeJS.Signals) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  function daemonAlive(pid: number) {
    try {
      process.kill(pid, 0);
      if (process.platform === "linux") {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
      }
      return true;
    } catch (error) {
      if (
        ["ESRCH", "ENOENT"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        return false;
      throw error;
    }
  }
  async function cleanup() {
    try {
      await client.close();
      // A failure before board_url still cleans this test's exact daemon PID.
      if (existsSync(lock)) {
        const record = JSON.parse(readFileSync(lock, "utf8"));
        daemonPid = record.pid;
      }
      if (
        daemonPid &&
        daemonPid > 0 &&
        daemonPid !== process.pid &&
        daemonAlive(daemonPid)
      ) {
        signalDaemon(daemonPid, "SIGTERM");
        const deadline = Date.now() + 1500;
        while (daemonAlive(daemonPid) && Date.now() < deadline) await delay(25);
        if (daemonAlive(daemonPid)) signalDaemon(daemonPid, "SIGKILL");
        const killedDeadline = Date.now() + 1500;
        while (daemonAlive(daemonPid) && Date.now() < killedDeadline)
          await delay(25);
        expect(daemonAlive(daemonPid)).toBe(false);
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }
  try {
    await client.connect(transport, { timeout: 5000 });
    expect(client.getServerVersion()?.name).toBe("rimewire");
    expect(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
    ).toEqual([
      "board_overview",
      "board_url",
      "get_package",
      "list_updates",
      "post_update",
    ]);
    const { url } = await tool<{ url: string }>("board_url");
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/p\/[A-Za-z0-9_-]+\/$/);
    const record = JSON.parse(readFileSync(lock, "utf8"));
    daemonPid = record.pid;
    expect(record).toMatchObject({
      version: 1,
      port: Number(new URL(url).port),
    });
    expect(record.pid).not.toBe(transport.pid);
    expect((await http(`${url}api/board`)).status).toBe(200);
    const overview = await tool<{
      project: { name: string };
      totals: { planned: number };
    }>("board_overview");
    expect(overview.project.name).toBe("Stdio fixture");
    expect(overview.totals.planned).toBe(2);
    const { note } = await tool<{
      note: { id: string; source: string; kind: string };
    }>("post_update", {
      wp: "TEST-1",
      kind: "ready",
      text: "Explicit stdio acceptance passed",
    });
    expect(note).toMatchObject({ source: "mcp", kind: "ready" });
    const progress = await tool<{ note: { id: string } }>("post_update", {
      wp: "TEST-2",
      kind: "progress",
      percent: 100,
      text: "Still requires explicit ready",
    });
    const detail = await tool<{
      item: { cls: string };
      updates: { id: string; source: string }[];
    }>("get_package", { wp: "TEST-1" });
    expect(detail.item.cls).toBe("done");
    expect(detail.updates).toEqual([
      expect.objectContaining({ id: note.id, source: "mcp" }),
    ]);
    const pending = await tool<{ item: { cls: string } }>("get_package", {
      wp: "TEST-2",
    });
    expect(pending.item.cls).toBe("active");
    const updates = await tool<{ updates: { id: string; source: string }[] }>(
      "list_updates",
    );
    expect(updates.updates).toHaveLength(2);
    expect(updates.updates.map((entry) => entry.id).sort()).toEqual(
      [note.id, progress.note.id].sort(),
    );
    expect(updates.updates.every((entry) => entry.source === "mcp")).toBe(true);
    const explicitNotes = notes();
    await client.close();
    // The shared web process outlives stdio; only release/lease plus idle stops it.
    expect((await http(url)).status).toBe(200);
    await delay(100);
    expect((await http(url)).status).toBe(200);
    const deadline = Date.now() + 5000;
    while (existsSync(lock) && Date.now() < deadline) await delay(25);
    expect(existsSync(lock)).toBe(false);
    await expect(http(url)).rejects.toThrow();
    expect(notes()).toEqual(explicitNotes);
    expect(notes().filter((entry) => entry.kind === "ready")).toHaveLength(1);
  } finally {
    await cleanup();
  }
}, 20000);
