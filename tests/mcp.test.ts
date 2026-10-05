import { existsSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Detail, Snapshot } from "../src/board.js";
import { loadConfig } from "../src/config.js";
import {
  append,
  type JournalEntry,
  journalPath,
  KINDS,
  make,
  type Note,
  readJournal,
} from "../src/journal.js";
import { createMcpServer, type McpOptions } from "../src/mcp.js";
import { fixtureGit, removeRepo, tempRepo, write } from "./fixtures/helpers.js";

const tracker = (status = "planned", extra = "") => `# Packages
## Phase 1
| ID | Title | Status |
| --- | --- | --- |
| [TASK-1](TASK-1.md) | First package | ${status} |
| TASK-2 | Second package | planned |
${extra}`;
const settings = `name = "MCP fixture"
tracker = "docs/tasks/README.md"
idPattern = "TASK-[0-9]+"
branchPrefix = "task"
journalDir = "var/updates"
`;
type Overview = Snapshot & { project: { name: string; tracker: string } };

async function call(
  client: Client,
  name: string,
  args?: Record<string, unknown>,
) {
  return CallToolResultSchema.parse(
    await client.callTool({ name, arguments: args }),
  );
}

async function success<T>(
  client: Client,
  name: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const response = await call(client, name, args);
  expect(response.isError).not.toBe(true);
  expect(response.structuredContent).toBeDefined();
  expect(response.content).toHaveLength(1);
  const content = response.content[0];
  if (content.type !== "text") throw new Error("missing text result");
  expect(JSON.parse(content.text)).toEqual(response.structuredContent);
  return response.structuredContent as T;
}

async function failure(
  client: Client,
  name: string,
  args?: Record<string, unknown>,
  message?: string | RegExp,
) {
  const response = await call(client, name, args);
  expect(response.isError).toBe(true);
  expect(response.content[0]).toMatchObject({ type: "text" });
  const text = response.content
    .flatMap((entry) => (entry.type === "text" ? [entry.text] : []))
    .join("\n");
  expect(text.length).toBeGreaterThan(0);
  if (typeof message === "string") expect(text).toContain(message);
  else if (message) expect(text).toMatch(message);
}

describe("MCP tool contracts through linked SDK transports", () => {
  let repo: string;
  let outside: string;
  let sessions: {
    client: Client;
    server: ReturnType<typeof createMcpServer>;
  }[];

  beforeEach(() => {
    repo = tempRepo();
    outside = tempRepo();
    sessions = [];
    write(repo, ".rimewire/config.toml", settings);
    write(repo, "docs/tasks/README.md", tracker());
    write(
      repo,
      "docs/tasks/TASK-1.md",
      "# First spec\n\nWhy this package exists.\n",
    );
  });

  afterEach(async () => {
    for (const { client, server } of sessions) {
      await client.close();
      await server.close();
    }
    removeRepo(repo);
    removeRepo(outside);
  });

  async function connect(options: McpOptions = {}, checkout = repo) {
    const server = createMcpServer(checkout, options);
    const client = new Client({ name: "contract-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    sessions.push({ client, server });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }

  function notes(checkout = repo) {
    return readJournal(
      journalPath(checkout, loadConfig(repo)),
      "fixture",
      loadConfig(repo),
    );
  }

  function initializeGit() {
    fixtureGit(repo, "init", "--initial-branch=main");
    write(repo, ".gitignore", "var/updates/\n.rimewire/journal/\n");
    fixtureGit(repo, "add", ".");
    fixtureGit(repo, "commit", "-m", "fixture");
  }

  it("initializes and advertises exactly five strict schemas and tool annotations", async () => {
    const client = await connect();
    expect(client.getServerVersion()).toMatchObject({ name: "rimewire" });
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "board_overview",
      "board_url",
      "get_package",
      "list_updates",
      "post_update",
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.properties).not.toHaveProperty("source");
      expect(tool.inputSchema.properties).not.toHaveProperty("checkout");
      expect(tool.inputSchema.properties).not.toHaveProperty("path");
      expect(tool.annotations?.readOnlyHint).toBe(tool.name !== "post_update");
    }
    const update = tools.find((tool) => tool.name === "post_update");
    expect(update?.inputSchema.required).toEqual(["wp", "kind"]);
    expect(update?.inputSchema.properties?.kind).toMatchObject({
      enum: [...KINDS],
    });
    expect(update?.inputSchema.properties?.percent).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 100,
    });
    const list = tools.find((tool) => tool.name === "list_updates");
    expect(list?.inputSchema.properties?.limit).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 200,
      default: 20,
    });
  });

  it("returns useful fresh snapshots and the existing package/spec detail as structured data and text", async () => {
    const client = await connect();
    const overview = await success<Overview>(client, "board_overview");
    expect(overview.project).toMatchObject({
      name: "MCP fixture",
      tracker: "docs/tasks/README.md",
    });
    expect(overview.totals).toMatchObject({ planned: 2, counted: 2 });
    expect(overview.lanes[0].title).toBe("Phase 1");
    const detail = await success<Detail>(client, "get_package", {
      wp: "TASK-1",
    });
    expect(detail.item).toMatchObject({ id: "TASK-1", cls: "planned" });
    expect(detail.spec?.h1).toBe("First spec");
    expect(detail.markdown).toContain("Why this package exists.");
    expect(detail.source).toBe("docs/tasks/TASK-1.md");
    expect(detail.updates).toEqual([]);
    expect(await success(client, "list_updates")).toEqual({ updates: [] });

    write(
      repo,
      ".rimewire/config.toml",
      settings.replace("MCP fixture", "Renamed"),
    );
    write(
      repo,
      "docs/tasks/README.md",
      tracker("in progress", "| TASK-3 | Added now | blocked |\n"),
    );
    expect(
      (await success<Overview>(client, "board_overview")).project.name,
    ).toBe("Renamed");
    expect(
      (await success<Detail>(client, "get_package", { wp: "TASK-3" })).item.cls,
    ).toBe("blocked");
  });

  it.each([
    {},
    { wp: "TASK-1" },
    { wp: "TASK-1", kind: "finished" },
    { wp: "../escape", kind: "note", text: "unsafe" },
    { wp: "TASK-1", kind: "note" },
    { wp: "TASK-1", kind: "blocker", text: "   " },
    { wp: "TASK-1", kind: "progress" },
    { wp: "TASK-1", kind: "progress", text: "  " },
    { wp: "TASK-1", kind: "progress", percent: -1 },
    { wp: "TASK-1", kind: "progress", percent: 101 },
    { wp: "TASK-1", kind: "progress", percent: 1.5 },
    { wp: "TASK-1", kind: "progress", percent: "50" },
    { wp: "TASK-1", kind: "progress", percent: true },
    { wp: "TASK-1", kind: "progress", percent: null },
    { wp: "TASK-1", kind: "note", text: null },
    { wp: "TASK-1", kind: "note", text: 42 },
    { wp: "TASK-1", kind: "note", text: "x".repeat(4001) },
    { wp: "TASK-1", kind: "note", text: "hello", author: "x".repeat(65) },
    { wp: "TASK-1", kind: "note", text: "hello", percent: 20 },
    { wp: "TASK-1", kind: "blocker", text: "hello", percent: 20 },
    { wp: "TASK-1", kind: "unblock", percent: 20 },
  ])(
    "returns tool validation errors without writing for invalid post %#",
    async (args) => {
      await failure(
        await connect(),
        "post_update",
        args,
        "Input validation error",
      );
      expect(existsSync(journalPath(repo, loadConfig(repo)))).toBe(false);
    },
  );

  it("rejects caller provenance and paths for every tool without journal effects", async () => {
    const client = await connect();
    for (const injected of [
      { source: "hook:exit" },
      { checkout: outside },
      { path: "other.jsonl" },
      { repo: outside },
      { id: "forged" },
      { time: 1 },
    ])
      await failure(
        client,
        "post_update",
        { wp: "TASK-1", kind: "ready", ...injected },
        "Input validation error",
      );
    for (const name of [
      "board_overview",
      "board_url",
      "get_package",
      "list_updates",
    ])
      await failure(
        client,
        name,
        { ...(name === "get_package" ? { wp: "TASK-1" } : {}), path: outside },
        "Input validation error",
      );
    expect(notes()).toEqual([]);
    expect(existsSync(journalPath(outside, loadConfig(repo)))).toBe(false);
  });

  it("rejects unknown IDs in reads, filters, and writes, but accepts discovered spec packages", async () => {
    const client = await connect();
    for (const name of ["get_package", "list_updates", "post_update"])
      await failure(
        client,
        name,
        {
          wp: "TASK-99",
          ...(name === "post_update" ? { kind: "note", text: "unknown" } : {}),
        },
        "Unknown work-package ID",
      );
    expect(notes()).toEqual([]);
    write(repo, "docs/tasks/TASK-99.md", "# Extra spec\n");
    await success(client, "post_update", {
      wp: "TASK-99",
      kind: "progress",
      percent: 0,
    });
    expect(
      (await success<Detail>(client, "get_package", { wp: "TASK-99" })).item,
    ).toMatchObject({ tracked: false, cls: "active" });
    await failure(client, "get_package", {}, "Input validation error");
    await failure(
      client,
      "get_package",
      { wp: "../TASK-1" },
      "Input validation error",
    );
  });

  it("persists all update kinds with server provenance, generated IDs/times, and normalized fields", async () => {
    const client = await connect();
    for (const args of [
      { kind: "note", text: "  explanation  ", author: "  owner  " },
      { kind: "progress", percent: 0 },
      { kind: "progress", text: "text-only progress" },
      { kind: "blocker", text: "needs input" },
      { kind: "unblock" },
      { kind: "ready", text: "checks passed", percent: 100 },
    ]) {
      const before = Date.now() / 1000;
      const { note } = await success<{ note: Note }>(client, "post_update", {
        wp: "TASK-1",
        ...args,
      });
      expect(note.source).toBe("mcp");
      expect(note.id).toMatch(/^[a-f0-9]{16}$/);
      expect(note.time).toBeGreaterThanOrEqual(before);
      expect(note.time).toBeLessThanOrEqual(Date.now() / 1000);
      expect(notes().at(-1)?.id).toBe(note.id);
    }
    const saved = notes();
    expect(saved[0]).toMatchObject({
      text: "explanation",
      author: "owner",
      percent: null,
    });
    expect(saved[1]).toMatchObject({ text: "", author: "agent", percent: 0 });
    expect(saved[2].percent).toBeNull();
    expect(new Set(saved.map((note) => note.id)).size).toBe(6);
    expect(
      JSON.parse(
        readFileSync(journalPath(repo, loadConfig(repo)), "utf8").split(
          "\n",
        )[0],
      ),
    ).not.toHaveProperty("checkout");
  });

  it("requires explicit ready, retains completion across notes/unblock, and reopens on progress or blockers", async () => {
    const client = await connect();
    const update = (args: Record<string, unknown>) =>
      success(client, "post_update", { wp: "TASK-1", ...args });
    const detail = () =>
      success<Detail>(client, "get_package", { wp: "TASK-1" });
    await update({ kind: "progress", percent: 100 });
    expect((await detail()).item.cls).toBe("active");
    await update({ kind: "blocker", text: "needs review" });
    expect((await detail()).item.agent?.blocker?.text).toBe("needs review");
    expect(
      (await success<Overview>(client, "board_overview")).totals.blocked,
    ).toBe(1);
    await update({ kind: "ready", text: "checks passed" });
    expect((await detail()).item).toMatchObject({
      cls: "done",
      agent: { percent: 100, blocker: null },
    });
    await update({ kind: "note", text: "review context" });
    await update({ kind: "unblock" });
    expect((await detail()).item.cls).toBe("done");
    await update({ kind: "progress", text: "more work found" });
    expect((await detail()).item).toMatchObject({
      cls: "active",
      agent: { ready: null },
    });
    await update({ kind: "ready" });
    await update({ kind: "blocker", text: "regression found" });
    expect((await detail()).item).toMatchObject({
      cls: "blocked",
      agent: { ready: null },
    });
    await update({ kind: "unblock", text: "regression resolved" });
    expect((await detail()).item.agent?.blocker).toBeNull();
    expect((await detail()).updates[0].kind).toBe("unblock");
  });

  it.each([0, 201, -1, 1.5, "20", null])(
    "rejects invalid list limit %s",
    async (limit) => {
      await failure(
        await connect(),
        "list_updates",
        { limit },
        "Input validation error",
      );
    },
  );

  it("lists newest first, defaults to 20, filters before limiting, and accepts 1 and 200", async () => {
    const client = await connect();
    for (let index = 0; index < 25; index++) {
      const note = make(
        index % 2 ? "TASK-2" : "TASK-1",
        "note",
        `note ${index}`,
        null,
        "fixture",
        "cli",
        loadConfig(repo),
      );
      note.time = 100 + index;
      append(repo, note, loadConfig(repo));
    }
    const list = (args?: Record<string, unknown>) =>
      success<{ updates: JournalEntry[] }>(client, "list_updates", args);
    expect((await list()).updates).toHaveLength(20);
    expect((await list()).updates[0]).toMatchObject({
      text: "note 24",
      source: "cli",
      checkout: "main",
    });
    expect(
      (await list({ limit: 1 })).updates.map((entry) => entry.text),
    ).toEqual(["note 24"]);
    expect((await list({ limit: 200 })).updates).toHaveLength(25);
    expect(
      (await list({ wp: "TASK-2", limit: 2 })).updates.map(
        (entry) => entry.text,
      ),
    ).toEqual(["note 23", "note 21"]);
  });

  it("resolves the main repository from a linked worktree, discovers new worktrees, and writes only locally", async () => {
    initializeGit();
    const worker = join(outside, "external-worker");
    fixtureGit(repo, "worktree", "add", "-b", "task/TASK-1", worker);
    rmSync(join(worker, ".rimewire/config.toml"));
    write(worker, "docs/tasks/README.md", tracker("done"));
    const client = await connect({}, worker);
    expect(
      (await success<Detail>(client, "get_package", { wp: "TASK-1" })).item,
    ).toMatchObject({
      cls: "planned",
      branch: "task/TASK-1",
      worktree: { name: "external-worker" },
    });
    await success(client, "post_update", {
      wp: "TASK-1",
      kind: "progress",
      percent: 55,
      text: "local work",
    });
    expect(notes(worker)).toHaveLength(1);
    expect(notes()).toEqual([]);
    expect(existsSync(journalPath(repo, loadConfig(repo)))).toBe(false);

    const sibling = join(outside, "sibling-worker");
    fixtureGit(repo, "worktree", "add", "-b", "task/TASK-2", sibling);
    const siblingNote = make(
      "TASK-2",
      "blocker",
      "sibling blocker",
      null,
      "sibling",
      "cli",
      loadConfig(repo),
    );
    siblingNote.time = Date.now() / 1000 + 1;
    append(sibling, siblingNote, loadConfig(repo));
    const overview = await success<Overview>(client, "board_overview");
    expect(overview.totals).toMatchObject({ active: 1, blocked: 1 });
    expect(overview.activity[0]).toMatchObject({
      text: "sibling blocker",
      source: "cli",
      checkout: "sibling-worker",
    });
    const { updates } = await success<{ updates: JournalEntry[] }>(
      client,
      "list_updates",
    );
    expect(updates.map((note) => note.checkout)).toEqual([
      "sibling-worker",
      "external-worker",
    ]);
    expect(
      (await success<Detail>(client, "get_package", { wp: "TASK-2" }))
        .updates[0].id,
    ).toBe(siblingNote.id);
    expect(notes(worker)[0].source).toBe("mcp");
    expect(notes(sibling)[0].source).toBe("cli");

    write(
      repo,
      "docs/tasks/README.md",
      tracker("planned", "| TASK-3 | Main addition | planned |\n"),
    );
    await success(client, "post_update", {
      wp: "TASK-3",
      kind: "note",
      text: "main tracker reread",
    });
    expect(notes(worker).at(-1)?.wp).toBe("TASK-3");
    expect(notes()).toEqual([]);
  });

  it("reloads config including ID scheme and journal directory before accepting writes", async () => {
    const client = await connect();
    write(
      repo,
      ".rimewire/config.toml",
      settings
        .replace("TASK-[0-9]+", "TASK-[23]")
        .replace("var/updates", "new/journal"),
    );
    await failure(
      client,
      "post_update",
      { wp: "TASK-1", kind: "ready" },
      "Unknown work-package ID",
    );
    await success(client, "post_update", {
      wp: "TASK-2",
      kind: "progress",
      percent: 10,
    });
    expect(existsSync(join(repo, "var/updates/notes.jsonl"))).toBe(false);
    expect(notes()).toHaveLength(1);
    expect(
      (await success<Detail>(client, "get_package", { wp: "TASK-2" }))
        .updates[0].source,
    ).toBe("mcp");
  });

  it("reports config, missing tracker, and journal write failures as tool errors and recovers", async () => {
    const client = await connect();
    write(repo, ".rimewire/config.toml", "name = [\n");
    for (const name of [
      "board_overview",
      "get_package",
      "post_update",
      "list_updates",
    ])
      await failure(
        client,
        name,
        name === "post_update"
          ? { wp: "TASK-1", kind: "ready" }
          : name === "get_package"
            ? { wp: "TASK-1" }
            : {},
        "Invalid Rimewire config",
      );
    expect(existsSync(join(repo, "var/updates/notes.jsonl"))).toBe(false);
    write(repo, ".rimewire/config.toml", settings);
    rmSync(join(repo, "docs/tasks/README.md"));
    await failure(client, "board_overview", {}, "Tracker is missing");
    write(repo, "docs/tasks/README.md", tracker());
    symlinkSync(outside, join(repo, "var"));
    await failure(
      client,
      "post_update",
      { wp: "TASK-1", kind: "ready" },
      "journal path must stay inside its checkout",
    );
    expect(existsSync(join(outside, "updates"))).toBe(false);
    rmSync(join(repo, "var"));
    await success(client, "post_update", { wp: "TASK-1", kind: "ready" });
    expect(notes()).toHaveLength(1);
  });

  it("delegates board URLs lazily to sync/async callbacks and returns tool errors when unavailable", async () => {
    await failure(await connect(), "board_url", {}, /board not started/i);
    for (const callback of [
      () => "http://127.0.0.1:8737/",
      async () => "http://127.0.0.1:8738/",
    ]) {
      const boardUrl = vi.fn(callback);
      const client = await connect({ boardUrl });
      expect(boardUrl).not.toHaveBeenCalled();
      await success(client, "board_overview");
      expect(boardUrl).not.toHaveBeenCalled();
      expect(await success(client, "board_url")).toEqual({
        url: await callback(),
      });
      expect(boardUrl).toHaveBeenCalledTimes(1);
    }
    const client = await connect({
      boardUrl: async () => {
        throw new Error("board unavailable");
      },
    });
    await failure(client, "board_url", {}, "board unavailable");
    await failure(client, "nonexistent_tool", {}, "not found");
    await success(client, "board_overview");
  });
});
