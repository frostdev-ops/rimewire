import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtureGit, projectDirectory, write } from "./fixtures/helpers.js";

const heartbeatMs = 100;
const leaseMs = 500;
const idleMs = 300;
const cli = join(projectDirectory, "dist/cli.js");

interface DaemonRecord {
  pid: number;
  port: number;
  token: string;
  version: 1;
}

interface Project {
  id: string;
  name: string;
  root: string;
  url: string;
}

interface Session {
  client: Client;
  transport: StdioClientTransport;
  diagnostics: string;
}

interface RawResponse {
  id: number;
  error?: unknown;
  result?: { isError?: boolean; structuredContent?: { url: string } };
}

async function eventually(check: () => Promise<void> | void, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(25);
    }
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    // A detached child can briefly be an unreaped zombie in CI containers.
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
    }
    return true;
  } catch (error) {
    if (
      ["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      return false;
    throw error;
  }
}

async function http(url: string, options: RequestInit = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(1000) });
}

describe("shared detached board lifecycle", () => {
  let sandbox: string;
  let state: string;
  let sessions: Session[];
  let children: ChildProcess[];
  let ownedPids: Set<number>;
  let occupied: Server | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "rimewire-daemon-test-"));
    state = join(sandbox, "state");
    mkdirSync(state);
    sessions = [];
    children = [];
    ownedPids = new Set();
    occupied = undefined;
  });

  function environment() {
    return {
      RIMEWIRE_STATE_DIR: state,
      RIMEWIRE_HEARTBEAT_MS: String(heartbeatMs),
      RIMEWIRE_LEASE_MS: String(leaseMs),
      RIMEWIRE_IDLE_MS: String(idleMs),
    };
  }

  function record(): DaemonRecord {
    const value = JSON.parse(readFileSync(join(state, "daemon.json"), "utf8"));
    expect(value).toMatchObject({ version: 1 });
    expect(value.pid).toBeGreaterThan(0);
    expect(value.port).toBeGreaterThan(0);
    expect(value.port).toBeLessThanOrEqual(65535);
    expect(value.token).toMatch(/^[a-f0-9]{64}$/);
    expect(value.pid).not.toBe(process.pid);
    ownedPids.add(value.pid);
    return value;
  }

  afterEach(async () => {
    try {
      await Promise.allSettled(sessions.map(({ client }) => client.close()));
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await eventually(() =>
            expect(child.exitCode !== null || child.signalCode !== null).toBe(
              true,
            ),
          );
        }
      }
      // Read only this test's private lock, including failures before board_url.
      if (existsSync(join(state, "daemon.json"))) {
        const value = JSON.parse(
          readFileSync(join(state, "daemon.json"), "utf8"),
        );
        if (
          Number.isInteger(value.pid) &&
          value.pid > 0 &&
          value.pid !== process.pid
        )
          ownedPids.add(value.pid);
      }
      for (const pid of ownedPids) {
        if (!alive(pid)) continue;
        process.kill(pid, "SIGTERM");
        try {
          await eventually(() => expect(alive(pid)).toBe(false), 1500);
        } catch {
          if (alive(pid)) process.kill(pid, "SIGKILL");
          await eventually(() => expect(alive(pid)).toBe(false));
        }
      }
    } finally {
      if (occupied) {
        const server = occupied;
        await new Promise<void>((done, reject) => {
          server.close((error) => (error ? reject(error) : done()));
          server.closeAllConnections();
        });
      }
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 15000);

  function project(name: string, id: string) {
    const root = join(sandbox, name);
    mkdirSync(root);
    fixtureGit(root, "init", "--initial-branch=main");
    write(root, ".rimewire/config.toml", `name = ${JSON.stringify(name)}\n`);
    write(root, ".gitignore", ".rimewire/journal/\n");
    write(
      root,
      "docs/board/README.md",
      `# ${name}\n\n## Phase 1\n\n| ID | Title | Status |\n| --- | --- | --- |\n| ${id} | ${name} package | planned |\n`,
    );
    write(root, `docs/board/${id}.md`, `# ${name} spec\n\nOnly ${name}.\n`);
    return root;
  }

  async function connect(root: string, port = 0): Promise<Session> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "mcp", "--repo", root, "--port", String(port)],
      env: environment(),
      stderr: "pipe",
    });
    const client = new Client({ name: "daemon-acceptance", version: "1.0.0" });
    const session = { client, transport, diagnostics: "" };
    sessions.push(session);
    transport.stderr?.on("data", (chunk) => {
      session.diagnostics += String(chunk);
    });
    await client.connect(transport, { timeout: 5000 });
    return session;
  }

  async function tool<T>(session: Session, name: string, args = {}) {
    const result = await session.client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: 5000 },
    );
    expect(result.isError, session.diagnostics).not.toBe(true);
    return result.structuredContent as T;
  }

  async function urls(roots: string[], port = 0) {
    // Await every start even if one fails so cleanup cannot race a starting client.
    const connected = await Promise.allSettled(
      roots.map((root) => connect(root, port)),
    );
    const clients = connected.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    const results = await Promise.allSettled(
      clients.map((session) => tool<{ url: string }>(session, "board_url")),
    );
    const boards = results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      expect(result.value.url).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/p\/[A-Za-z0-9_-]+\/$/,
      );
      return result.value.url;
    });
    return { clients, boards };
  }

  async function healthy(daemon: DaemonRecord) {
    const response = await http(
      `http://127.0.0.1:${daemon.port}/_rimewire/health`,
      {
        headers: { Authorization: `Bearer ${daemon.token}` },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pid: daemon.pid, version: 1 });
  }

  async function reachable(boards: string[], duration: number) {
    const deadline = Date.now() + duration;
    do {
      for (const url of boards)
        expect((await http(`${url}api/board`)).status).toBe(200);
      await delay(25);
    } while (Date.now() < deadline);
  }

  async function stopped(daemon: DaemonRecord, url: string) {
    await eventually(async () => {
      expect(existsSync(join(state, "daemon.json"))).toBe(false);
      expect(alive(daemon.pid)).toBe(false);
      await expect(http(url)).rejects.toThrow();
    });
  }

  it.each([
    [0, 1],
    [1, 0],
  ])(
    "concurrent projects share one daemon; close order %s then %s preserves both boards until idle",
    async (first, last) => {
      const roots = [project("Alpha", "ALPHA-1"), project("Beta", "BETA-1")];
      const { clients, boards } = await urls(roots);
      const daemon = record();
      expect(new URL(boards[0]).origin).toBe(new URL(boards[1]).origin);
      expect(boards[0]).not.toBe(boards[1]);
      expect(new URL(boards[0]).port).toBe(String(daemon.port));
      for (const session of clients)
        expect(session.transport.pid).not.toBe(daemon.pid);
      if (process.platform === "linux") {
        // The daemon must survive harnesses signalling an MCP process group.
        const group = (pid: number) => {
          const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
          return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2];
        };
        expect(group(daemon.pid)).toBe(String(daemon.pid));
        for (const session of clients)
          expect(group(session.transport.pid as number)).not.toBe(
            group(daemon.pid),
          );
      }
      await healthy(daemon);
      const origin = new URL(boards[0]).origin;
      const listing = (await (await http(`${origin}/api/projects`)).json()) as {
        projects: Project[];
      };
      expect(listing.projects).toHaveLength(2);
      for (const [index, name] of ["Alpha", "Beta"].entries()) {
        const entry = listing.projects.find((entry) => entry.name === name);
        expect(entry).toMatchObject({
          sessions: 1,
          totals: expect.any(Object),
          root: realpathSync(roots[index]),
          url: new URL(boards[index]).pathname,
        });
        expect(entry?.url).toBe(`/p/${entry?.id}/`);
        expect((await http(boards[index])).status).toBe(200);
        for (const asset of ["board.js", "board.css"])
          expect((await http(`${boards[index]}${asset}`)).status).toBe(200);
        const board = await (await http(`${boards[index]}api/board`)).json();
        expect(board.project.name).toBe(name);
        const id = index ? "BETA-1" : "ALPHA-1";
        const other = index ? "ALPHA-1" : "BETA-1";
        const doc = await (
          await http(`${boards[index]}api/doc?file=${id}.md`)
        ).json();
        expect(doc.markdown).toContain(`Only ${name}.`);
        expect((await http(`${boards[index]}api/wp?key=${other}`)).status).toBe(
          404,
        );
        expect(
          (await http(`${boards[index]}api/doc?file=${other}.md`)).status,
        ).toBe(404);
        const note = await tool<{ note: { source: string } }>(
          clients[index],
          "post_update",
          {
            wp: id,
            kind: "progress",
            percent: 40,
            text: `${name} explicit progress`,
          },
        );
        expect(note.note.source).toBe("mcp");
        const notes = await (await http(`${boards[index]}api/notes`)).json();
        expect(notes.notes).toHaveLength(1);
        expect(notes.notes[0]).toMatchObject({
          wp: id,
          source: "mcp",
          kind: "progress",
        });
        const posted = await http(`${boards[index]}api/notes`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: origin },
          body: JSON.stringify({
            wp: id,
            kind: "note",
            text: `${name} browser note`,
          }),
        });
        expect(posted.status).toBe(201);
        expect((await posted.json()).note).toMatchObject({
          wp: id,
          kind: "note",
          source: "web",
        });
        const scoped = await (await http(`${boards[index]}api/notes`)).json();
        expect(scoped.notes).toHaveLength(2);
        expect(
          scoped.notes.every((entry: { wp: string }) => entry.wp === id),
        ).toBe(true);
      }
      expect((await http(`${origin}/p/unknown/api/board`)).status).toBe(404);
      await clients[first].client.close();
      await reachable(boards, leaseMs + idleMs + heartbeatMs * 2);
      expect(record()).toEqual(daemon);
      await healthy(daemon);
      expect(
        (await tool<{ url: string }>(clients[last], "board_url")).url,
      ).toBe(boards[last]);
      await clients[last].client.close();
      await reachable(boards, idleMs / 3);
      await stopped(daemon, boards[last]);
      for (const [index, root] of roots.entries()) {
        const notes = readFileSync(
          join(root, ".rimewire/journal/notes.jsonl"),
          "utf8",
        )
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        // Closing sessions and the daemon never synthesizes a ready update.
        expect(notes).toHaveLength(2);
        expect(notes[0]).toMatchObject({
          source: "mcp",
          kind: "progress",
          wp: index ? "BETA-1" : "ALPHA-1",
        });
        expect(notes[1]).toMatchObject({
          source: "web",
          kind: "note",
          wp: index ? "BETA-1" : "ALPHA-1",
        });
      }
    },
    20000,
  );

  it("SIGKILL expires only the lost heartbeat lease, then exits after the last lease plus idle", async () => {
    const roots = [project("Alpha", "ALPHA-1"), project("Beta", "BETA-1")];
    const { clients, boards } = await urls(roots);
    const daemon = record();
    for (const session of clients)
      expect(session.transport.pid).toBeGreaterThan(0);
    process.kill(clients[0].transport.pid as number, "SIGKILL");
    await reachable(boards, leaseMs + idleMs + heartbeatMs * 2);
    await healthy(daemon);
    await tool(clients[1], "board_overview");
    const killedAt = Date.now();
    process.kill(clients[1].transport.pid as number, "SIGKILL");
    await reachable(boards, leaseMs / 2);
    await stopped(daemon, boards[1]);
    expect(Date.now() - killedAt).toBeGreaterThanOrEqual(
      leaseMs - heartbeatMs + idleMs - 50,
    );
    for (const root of roots)
      expect(existsSync(join(root, ".rimewire/journal/notes.jsonl"))).toBe(
        false,
      );
  }, 15000);

  it.each(["dead", "recycled"] as const)(
    "four concurrent clients recover a %s PID lock without starting multiple daemons",
    async (owner) => {
      const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      children.push(child);
      const deadPid = child.pid;
      await new Promise<void>((done, reject) => {
        child.once("error", reject);
        child.once("exit", () => done());
      });
      expect(deadPid).toBeGreaterThan(0);
      expect(alive(deadPid as number)).toBe(false);
      writeFileSync(
        join(state, "daemon.json"),
        JSON.stringify({
          pid: owner === "dead" ? deadPid : process.pid,
          port: 1,
          token: "a".repeat(64),
          version: 1,
          ...(owner === "recycled" ? { identity: "not-this-process" } : {}),
        }),
      );
      const roots = [
        project("RecoveryA", "RECOVER-1"),
        project("RecoveryB", "RECOVER-2"),
      ];
      const { clients, boards } = await urls([...roots, ...roots]);
      const daemon = record();
      expect(daemon.pid).not.toBe(deadPid);
      expect(daemon.token).not.toBe("a".repeat(64));
      expect(new Set(boards.map((url) => new URL(url).origin)).size).toBe(1);
      expect(new Set(boards).size).toBe(2);
      await healthy(daemon);
      const listing = await (
        await http(`${new URL(boards[0]).origin}/api/projects`)
      ).json();
      expect(listing.projects).toHaveLength(2);
      await reachable(boards, leaseMs);
      expect(record()).toEqual(daemon);
      for (const session of clients) await session.client.close();
      await stopped(daemon, boards[0]);
    },
    20000,
  );

  it("falls back from the requested occupied port without adopting or modifying the unrelated service", async () => {
    const requests: string[] = [];
    occupied = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.end("unrelated service");
    });
    await new Promise<void>((done) => occupied?.listen(0, "127.0.0.1", done));
    const address = occupied.address();
    if (!address || typeof address === "string")
      throw new Error("missing occupied port");
    const unrelated = `http://127.0.0.1:${address.port}/`;
    const { clients, boards } = await urls(
      [project("Collision", "PORT-1")],
      address.port,
    );
    const daemon = record();
    expect(daemon.port).toBeGreaterThan(address.port);
    expect(daemon.port).toBeLessThanOrEqual(address.port + 20);
    expect(new URL(boards[0]).origin).not.toBe(new URL(unrelated).origin);
    expect(await (await http(unrelated)).text()).toBe("unrelated service");
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
    await healthy(daemon);
    await clients[0].client.close();
    await stopped(daemon, boards[0]);
    expect(await (await http(unrelated)).text()).toBe("unrelated service");
  }, 15000);

  it("registers main checkout, linked worktree, and symlink as one canonical project while keeping MCP writes local", async () => {
    const root = project("Canonical", "TASK-1");
    fixtureGit(root, "add", ".");
    fixtureGit(root, "commit", "-m", "fixture");
    const worker = join(sandbox, "worker");
    fixtureGit(root, "worktree", "add", "-b", "work/TASK-1", worker);
    const alias = join(sandbox, "alias");
    symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
    const { clients, boards } = await urls([root, worker, alias]);
    const daemon = record();
    expect(new Set(boards).size).toBe(1);
    const listing = await (
      await http(`${new URL(boards[0]).origin}/api/projects`)
    ).json();
    expect(listing.projects).toHaveLength(1);
    expect(listing.projects[0]).toMatchObject({
      root: realpathSync(root),
      name: "Canonical",
      url: new URL(boards[0]).pathname,
    });
    await tool(clients[1], "post_update", {
      wp: "TASK-1",
      kind: "progress",
      percent: 55,
      text: "Explicit worker progress",
    });
    expect(existsSync(join(root, ".rimewire/journal/notes.jsonl"))).toBe(false);
    const notes = await (await http(`${boards[0]}api/notes`)).json();
    expect(notes.notes).toHaveLength(1);
    expect(notes.notes[0]).toMatchObject({
      source: "mcp",
      kind: "progress",
      checkout: "worker",
    });
    await clients[0].client.close();
    await clients[2].client.close();
    await reachable(boards, leaseMs + idleMs);
    await clients[1].client.close();
    await stopped(daemon, boards[0]);
    expect(
      JSON.parse(
        readFileSync(join(worker, ".rimewire/journal/notes.jsonl"), "utf8"),
      ),
    ).toMatchObject({ kind: "progress", source: "mcp" });
  }, 20000);

  it("authenticates control routes and release prevents a session from renewing its lease", async () => {
    const root = project("Control", "CTRL-1");
    const { clients, boards } = await urls([root]);
    const daemon = record();
    const origin = new URL(boards[0]).origin;
    const session = "b".repeat(32);
    const control = (route: string, body: object, token = daemon.token) =>
      http(`${origin}/_rimewire/${route}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    for (const route of ["register", "heartbeat", "release"]) {
      const response = await control(route, { session, root }, "wrong-token");
      expect([401, 403]).toContain(response.status);
      await response.arrayBuffer();
    }
    const unauthorized = await http(`${origin}/_rimewire/health`);
    expect([401, 403]).toContain(unauthorized.status);
    await unauthorized.arrayBuffer();
    // Use node:http to send an actual Host override; fetch may replace this header.
    const invalidHost = await new Promise<number>((done, reject) => {
      const req = request(
        `${origin}/_rimewire/health`,
        {
          headers: {
            Authorization: `Bearer ${daemon.token}`,
            Host: "unrelated.invalid",
          },
        },
        (res) => {
          res.resume();
          res.once("end", () => done(res.statusCode ?? 0));
        },
      );
      req.setTimeout(1000, () =>
        req.destroy(new Error("Host check timed out")),
      );
      req.once("error", reject);
      req.end();
    });
    expect(invalidHost).toBe(403);
    const registration = await control("register", { session, root });
    expect(registration.status).toBe(200);
    expect(await registration.json()).toEqual({
      url: boards[0],
      project: new URL(boards[0]).pathname.split("/")[2],
    });
    const heartbeat = await control("heartbeat", { session });
    expect(heartbeat.status).toBe(200);
    await heartbeat.arrayBuffer();
    await clients[0].client.close();
    // This control lease now owns the lifecycle; refresh beyond the idle window.
    for (let index = 0; index < 5; index++) {
      const response = await control("heartbeat", { session });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      await delay(heartbeatMs);
    }
    await healthy(daemon);
    const release = await control("release", { session });
    expect(release.status).toBe(200);
    await release.arrayBuffer();
    const expired = await control("heartbeat", { session });
    expect(expired.status).toBe(404);
    await expired.arrayBuffer();
    await reachable(boards, idleMs / 3);
    await stopped(daemon, boards[0]);
  }, 15000);

  async function rawConnect(root: string, detached = false) {
    const child = spawn(
      process.execPath,
      [cli, "mcp", "--repo", root, "--port", "0"],
      {
        env: { ...process.env, ...environment() },
        stdio: ["pipe", "pipe", "pipe"],
        detached,
      },
    );
    children.push(child);
    let diagnostics = "";
    child.stderr.on("data", (chunk) => {
      diagnostics += String(chunk);
    });
    const lines = createInterface({ input: child.stdout });
    async function request(id: number, method: string, params: object) {
      return new Promise<RawResponse>((done, reject) => {
        const timer = setTimeout(
          () => finish(new Error(`No ${method} response: ${diagnostics}`)),
          5000,
        );
        const exit = () => finish(new Error(`MCP exited: ${diagnostics}`));
        const failure = (error: Error) => finish(error);
        const line = (text: string) => {
          try {
            const response = JSON.parse(text) as RawResponse;
            if (response.id === id) finish(undefined, response);
          } catch (error) {
            finish(error);
          }
        };
        function finish(error?: unknown, response?: RawResponse) {
          clearTimeout(timer);
          lines.off("line", line);
          child.off("exit", exit);
          child.off("error", failure);
          if (error) reject(error);
          else done(response as RawResponse);
        }
        lines.on("line", line);
        child.once("exit", exit);
        child.once("error", failure);
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        );
      });
    }
    try {
      const initialized = await request(1, "initialize", {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "raw-lifecycle-test", version: "1" },
      });
      expect(initialized.error, diagnostics).toBeUndefined();
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      const response = await request(2, "tools/call", {
        name: "board_url",
        arguments: {},
      });
      expect(response.error, diagnostics).toBeUndefined();
      expect(response.result?.isError, diagnostics).not.toBe(true);
      const url = response.result?.structuredContent?.url;
      if (typeof url !== "string")
        throw new Error(`Missing board URL: ${diagnostics}`);
      return { child, url, diagnostics };
    } finally {
      lines.close();
    }
  }

  it("raw stdin EOF releases the MCP lease and stops heartbeats without marking work done", async () => {
    const root = project("EOF", "EOF-1");
    const { child, url, diagnostics } = await rawConnect(root);
    const daemon = record();
    child.stdin.end();
    await eventually(() => expect(child.exitCode, diagnostics).toBe(0));
    await stopped(daemon, url);
    expect(existsSync(join(root, ".rimewire/journal/notes.jsonl"))).toBe(false);
  }, 15000);

  it.skipIf(process.platform === "win32")(
    "terminating an entire MCP process group leaves the detached daemon and another session alive",
    async () => {
      const root = project("Group", "GROUP-1");
      const { clients, boards } = await urls([root]);
      const { child, url } = await rawConnect(root, true);
      const daemon = record();
      expect(url).toBe(boards[0]);
      expect(child.pid).toBeGreaterThan(0);
      expect(child.pid).not.toBe(daemon.pid);
      process.kill(-(child.pid as number), "SIGTERM");
      await eventually(() =>
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true),
      );
      await reachable(boards, leaseMs + idleMs + heartbeatMs * 2);
      expect(record()).toEqual(daemon);
      await healthy(daemon);
      await tool(clients[0], "board_overview");
      await clients[0].client.close();
      await stopped(daemon, boards[0]);
      expect(existsSync(join(root, ".rimewire/journal/notes.jsonl"))).toBe(
        false,
      );
    },
    15000,
  );

  it("live MCP sessions automatically replace a SIGKILLed daemon and restore both project URLs", async () => {
    const roots = [project("Alpha", "ALPHA-1"), project("Beta", "BETA-1")];
    const { clients, boards } = await urls(roots);
    const original = record();
    await tool(clients[0], "post_update", {
      wp: "ALPHA-1",
      kind: "progress",
      percent: 25,
      text: "Progress survives daemon restart",
    });
    process.kill(original.pid, "SIGKILL");
    await eventually(async () => {
      const replacement = record();
      expect(replacement.pid).not.toBe(original.pid);
      expect(replacement.token).not.toBe(original.token);
      await healthy(replacement);
    });
    // Discovery above uses no MCP calls: heartbeats themselves must trigger recovery.
    const replacement = record();
    const next = await Promise.all(
      clients.map((session) => tool<{ url: string }>(session, "board_url")),
    );
    expect(new URL(next[0].url).origin).toBe(new URL(next[1].url).origin);
    for (let index = 0; index < boards.length; index++) {
      expect(new URL(next[index].url).pathname).toBe(
        new URL(boards[index]).pathname,
      );
      expect(new URL(next[index].url).port).toBe(String(replacement.port));
    }
    const listing = await (
      await http(`${new URL(next[0].url).origin}/api/projects`)
    ).json();
    expect(listing.projects).toHaveLength(2);
    const notes = await (await http(`${next[0].url}api/notes`)).json();
    expect(notes.notes).toHaveLength(1);
    expect(notes.notes[0]).toMatchObject({
      source: "mcp",
      kind: "progress",
      wp: "ALPHA-1",
    });
    await clients[0].client.close();
    await reachable(
      next.map(({ url }) => url),
      leaseMs + idleMs,
    );
    await clients[1].client.close();
    await stopped(replacement, next[1].url);
  }, 20000);
});
