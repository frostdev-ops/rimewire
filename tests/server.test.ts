import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { everyItem } from "../src/board.js";
import { loadConfig } from "../src/config.js";
import { append, journalPath, make } from "../src/journal.js";
import {
  type BoardServer,
  createBoardServer,
  MAX_POST,
} from "../src/server.js";

const tracker = (status = "planned", extra = "") => `# Packages
## Phase 1
| ID | Title | Status |
| --- | --- | --- |
| [TASK-1](TASK-1.md) | First package | ${status} |
${extra}`;

describe("board HTTP server", () => {
  let repo: string;
  let outside: string;
  let server: BoardServer;
  let url: string;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "rimewire-server-"));
    outside = mkdtempSync(join(tmpdir(), "rimewire-outside-"));
    mkdirSync(join(repo, "docs", "tasks"), { recursive: true });
    mkdirSync(join(repo, ".rimewire"));
    writeFileSync(
      join(repo, ".rimewire", "config.toml"),
      'name = "Example project"\ntracker = "docs/tasks/README.md"\n',
    );
    writeFileSync(join(repo, "docs", "tasks", "README.md"), tracker());
    writeFileSync(
      join(repo, "docs", "tasks", "TASK-1.md"),
      "# First spec\n\nA safe document.\n",
    );
    server = createBoardServer(repo, {
      withGit: false,
      pollInterval: 60000,
      heartbeatInterval: 60000,
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing server address");
    url = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server.listening)
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
    else server.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  function post(body: string, headers: Record<string, string> = {}) {
    return fetch(`${url}/api/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
  }

  it("serves only the configured stylesheet and detects edits and escaping symlinks", async () => {
    writeFileSync(join(repo, "custom.css"), ".panel { border-radius: 20px; }");
    writeFileSync(
      join(repo, ".rimewire/config.toml"),
      'tracker = "docs/tasks/README.md"\nstylesheet = "custom.css"\n',
    );
    server.poll();
    expect(
      (await (await fetch(`${url}/api/board`)).json()).project.stylesheet,
    ).toBe("/brand/custom.css");
    expect(await (await fetch(`${url}/brand/custom.css`)).text()).toContain(
      "20px",
    );
    writeFileSync(join(repo, "custom.css"), ".panel { border-radius: 40px; }");
    expect(server.state.poll()).toBe(true);
    expect(await (await fetch(`${url}/brand/custom.css`)).text()).toContain(
      "40px",
    );
    rmSync(join(repo, "custom.css"));
    writeFileSync(join(outside, "private.css"), "private");
    symlinkSync(join(outside, "private.css"), join(repo, "custom.css"));
    expect((await fetch(`${url}/brand/custom.css`)).status).toBe(404);
  });

  it("reloads and exposes palette and font settings with their browser module", async () => {
    writeFileSync(
      join(repo, ".rimewire/config.toml"),
      'tracker = "docs/tasks/README.md"\n[palette]\nmode = "dark"\n[palette.dark]\naccent = "#89cbd5"\n[fonts]\nsans = "Georgia, serif"\n',
    );
    server.rebuild();
    const board = await (await fetch(`${url}/api/board`)).json();
    expect(board.project.palette.dark.accent).toBe("#89cbd5");
    expect(board.project.fonts.sans).toBe("Georgia, serif");
    expect((await fetch(`${url}/appearance.js`)).status).toBe(200);
    expect((await fetch(`${url}/mark.png`)).headers.get("content-type")).toBe(
      "image/png",
    );
  });

  it("serves the generic UI, configured project, package detail, docs, and HEAD", async () => {
    const home = await fetch(url);
    expect(home.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await home.text()).toContain("Rimewire");
    const board = await (await fetch(`${url}/api/board`)).json();
    expect(board.project.name).toBe("Example project");
    expect(board.project.tracker).toBe("docs/tasks/README.md");
    expect(board.version).toBe(1);
    const item = await (await fetch(`${url}/api/wp?key=TASK-1`)).json();
    expect(item.item.id).toBe("TASK-1");
    expect(item.markdown).toContain("A safe document.");
    const doc = await (await fetch(`${url}/api/doc?file=TASK-1.md`)).json();
    expect(doc.h1).toBe("First spec");
    const head = await fetch(`${url}/api/doc?file=TASK-1.md`, {
      method: "HEAD",
    });
    expect(Number(head.headers.get("content-length"))).toBeGreaterThan(0);
    expect(await head.text()).toBe("");
    expect((await fetch(`${url}/api/wp?key=unknown`)).status).toBe(404);
    expect((await fetch(`${url}/missing`)).status).toBe(404);
  });

  it("rejects traversal, non-Markdown files, and symlinks outside the allowed documents", async () => {
    writeFileSync(join(outside, "private.md"), "PRIVATE CONTENT");
    writeFileSync(join(repo, "secret.md"), "PROJECT SECRET");
    symlinkSync(
      join(outside, "private.md"),
      join(repo, "docs", "tasks", "escape.md"),
    );
    symlinkSync(
      join(repo, "secret.md"),
      join(repo, "docs", "tasks", "elsewhere.md"),
    );
    for (const name of [
      "../secret.md",
      "README.txt",
      "escape.md",
      "elsewhere.md",
      "missing.md",
      "/etc/passwd",
    ]) {
      const res = await fetch(
        `${url}/api/doc?file=${encodeURIComponent(name)}`,
      );
      expect(res.status, name).toBe(404);
      expect(await res.text()).not.toContain("PRIVATE CONTENT");
    }
    symlinkSync(outside, join(repo, "external-docs"));
    writeFileSync(
      join(repo, ".rimewire", "config.toml"),
      'tracker = "external-docs/README.md"\n',
    );
    server.poll();
    expect((await fetch(`${url}/api/doc?file=private.md`)).status).toBe(404);
  });

  it("serves only configured in-project logos and reloads logo changes", async () => {
    writeFileSync(
      join(repo, "logo.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    );
    writeFileSync(
      join(repo, ".rimewire", "config.toml"),
      'tracker = "docs/tasks/README.md"\nlogo = "logo.svg"\n',
    );
    server.poll();
    const safe = await fetch(`${url}/brand/mark.svg`);
    expect(safe.status).toBe(200);
    expect(safe.headers.get("content-type")).toBe("image/svg+xml");
    await safe.text();
    writeFileSync(join(outside, "private.svg"), "PRIVATE LOGO");
    symlinkSync(join(outside, "private.svg"), join(repo, "escape.svg"));
    writeFileSync(
      join(repo, ".rimewire", "config.toml"),
      'tracker = "docs/tasks/README.md"\nlogo = "escape.svg"\n',
    );
    server.poll();
    const unsafeLogo = await fetch(`${url}/brand/mark.svg`);
    expect(unsafeLogo.status).toBe(404);
    expect(await unsafeLogo.text()).not.toContain("PRIVATE LOGO");
  });

  it("appends explicit web updates and returns filtered notes newest first", async () => {
    const res = await post(
      JSON.stringify({
        wp: "TASK-1",
        kind: "progress",
        text: "offers done",
        percent: 60,
        author: "owner",
        source: "hook:exit",
      }),
    );
    expect(res.status).toBe(201);
    const { note } = await res.json();
    expect(note.source).toBe("web");
    expect(note.percent).toBe(60);
    const saved = JSON.parse(readFileSync(journalPath(repo), "utf8"));
    expect(saved.id).toBe(note.id);
    const next = make(
      "TASK-2",
      "note",
      "another package",
      null,
      "agent",
      "cli",
    );
    next.time = note.time + 1;
    append(repo, next);
    const filtered = await (
      await fetch(`${url}/api/notes?wp=TASK-1&limit=0`)
    ).json();
    expect(filtered.notes).toHaveLength(1);
    expect(filtered.notes[0].checkout).toBe("main");
    const all = await (await fetch(`${url}/api/notes?limit=0`)).json();
    expect(all.notes.map((entry: { wp: string }) => entry.wp)).toEqual([
      "TASK-2",
      "TASK-1",
    ]);
    expect(
      (await (await fetch(`${url}/api/notes?limit=1`)).json()).notes,
    ).toHaveLength(1);
  });

  it("includes external Git worktree updates in the API, board feed, and package detail", async () => {
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
    append(
      external,
      make("TASK-1", "progress", "external progress", 55, "worker", "cli"),
    );
    await new Promise<void>((done) => server.close(() => done()));
    server = createBoardServer(repo, { withGit: true, pollInterval: 60000 });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing address");
    url = `http://127.0.0.1:${address.port}`;
    const notes = await (await fetch(`${url}/api/notes`)).json();
    expect(notes.notes[0]).toMatchObject({
      text: "external progress",
      checkout: "external-worker",
      source: "cli",
    });
    const board = await (await fetch(`${url}/api/board`)).json();
    expect(board.activity[0].text).toBe("external progress");
    const item = await (await fetch(`${url}/api/wp?key=TASK-1`)).json();
    expect(item.updates[0].text).toBe("external progress");
    expect(item.item.agent.percent).toBe(55);
  });

  it("uses spec heading fallback and rejects malformed request URLs without crashing", async () => {
    writeFileSync(
      join(repo, "docs", "tasks", "legacy.md"),
      "### Legacy heading\n\nDetails\n",
    );
    const doc = await (await fetch(`${url}/api/doc?file=legacy.md`)).json();
    expect(doc.h1).toBe("Legacy heading");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing address");
    const status = await new Promise<number>((done, reject) => {
      const req = request(
        { host: "127.0.0.1", port: address.port, path: "http://[" },
        (res) => {
          res.resume();
          res.on("end", () => done(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(400);
    expect((await fetch(`${url}/api/board`)).status).toBe(200);
  });

  it("allows local JSON clients and rejects foreign origins and non-JSON content", async () => {
    const body = JSON.stringify({ wp: "TASK-1", text: "hello" });
    for (const origin of [url, url.replace("127.0.0.1", "localhost")]) {
      const res = await post(body, { Origin: origin });
      expect(res.status).toBe(201);
      await res.text();
    }
    for (const origin of [
      "https://evil.example",
      `${url}.evil.example`,
      "null",
      "http://localhost:1",
    ]) {
      const res = await post(body, { Origin: origin });
      expect(res.status).toBe(403);
      await res.text();
    }
    expect((await post(body, { "Content-Type": "text/plain" })).status).toBe(
      403,
    );
    expect(
      (await fetch(`${url}/api/notes`, { method: "OPTIONS" })).status,
    ).toBe(405);
  });

  it("requires a bounded Content-Length and validates note fields", async () => {
    const missing = await new Promise<number>((done, reject) => {
      const req = request(
        `${url}/api/notes`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Transfer-Encoding": "chunked",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => done(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
    expect(missing).toBe(411);
    expect((await post("x".repeat(MAX_POST + 1))).status).toBe(413);
    expect((await post("")).status).toBe(413);
    for (const body of [
      "broken",
      "[]",
      "null",
      '{"wp":"../escape","text":"x"}',
      '{"wp":"TASK-1","text":{}}',
      '{"wp":"TASK-1","kind":"progress","percent":true}',
      JSON.stringify({ wp: "TASK-1", text: "x".repeat(4001) }),
    ]) {
      const res = await post(body);
      expect(res.status, body.slice(0, 100)).toBe(400);
      await res.text();
    }
  });

  it("tracks arriving cards and class changes without marking initial cards new", () => {
    const first = [
      ...everyItem(
        server.state.board ??
          (() => {
            throw new Error("missing board");
          })(),
      ),
    ][0];
    expect(first.arrived_at).toBeNull();
    writeFileSync(
      join(repo, "docs", "tasks", "README.md"),
      tracker("in progress", "| TASK-2 | Second | planned |\n"),
    );
    server.poll();
    const items = [
      ...everyItem(
        server.state.board ??
          (() => {
            throw new Error("missing board");
          })(),
      ),
    ];
    expect(items[0].previous_cls).toBe("planned");
    expect(items[0].changed_at).toBeGreaterThan(0);
    expect(items[1].arrived_at).toBeGreaterThan(0);
    const arrived = items[1].arrived_at;
    server.rebuild();
    expect(
      [
        ...everyItem(
          server.state.board ??
            (() => {
              throw new Error("missing board");
            })(),
        ),
      ][1].arrived_at,
    ).toBe(arrived);
  });

  it("keeps the last good snapshot on rebuild errors and recovers after config edits", async () => {
    const version = server.state.version;
    writeFileSync(join(repo, ".rimewire", "config.toml"), "name = [\n");
    server.poll();
    const failed = await (await fetch(`${url}/api/board`)).json();
    expect(failed.error).toContain("Invalid Rimewire config");
    expect(failed.version).toBeGreaterThan(version);
    expect(failed.project.name).toBe("Example project");
    writeFileSync(
      join(repo, ".rimewire", "config.toml"),
      'name = "Renamed"\ntracker = "docs/tasks/README.md"\n',
    );
    server.poll();
    expect(server.state.error).toBe("");
    expect(server.state.config.name).toBe("Renamed");
    expect(loadConfig(repo).name).toBe("Renamed");
  });

  it("streams initial and changed versions and closes active SSE clients cleanly", async () => {
    const response = await fetch(`${url}/events`);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing stream");
    const initial = new TextDecoder().decode((await reader.read()).value);
    expect(initial).toContain(
      `event: version\ndata: 1@${server.state.started}`,
    );
    append(repo, make("TASK-1", "note", "live update"));
    server.poll();
    const update = new TextDecoder().decode((await reader.read()).value);
    expect(update).toContain(`data: 2@${server.state.started}`);
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    expect((await reader.read()).done).toBe(true);
    const version = server.state.version;
    await new Promise<void>((done) => setTimeout(done, 25));
    expect(server.state.version).toBe(version);
  });
});
