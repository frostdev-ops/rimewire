import { execFile } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  append,
  journalPath,
  make,
  readJournal,
  summarize,
} from "../src/journal.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const adapter = join(root, "adapters/pi/index.mjs");
const run = promisify(execFile);
const events = [
  ["session_start", "PiSessionStart", "Pi session started."],
  ["agent_end", "PiAgentEnd", "Pi agent ended."],
  ["session_shutdown", "PiSessionShutdown", "Pi session shut down."],
] as const;
type Handler = (event: unknown, ctx: { cwd: string }) => Promise<void>;
type McpConfig = { command: string; args: string[]; exposure: string };
type PiAPI = {
  registerMcpServer: (name: string, config: McpConfig) => void;
  on: (event: string, handler: Handler) => void;
};
const temporary: string[] = [];

function directory() {
  const path = mkdtempSync(join(tmpdir(), "rimewire-pi-"));
  temporary.push(path);
  return path;
}
function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
async function load(path = adapter) {
  const handlers = new Map<string, Handler>();
  const servers = new Map<string, McpConfig>();
  const module = (await import(pathToFileURL(path).href)) as {
    default: (pi: PiAPI) => void;
  };
  module.default({
    registerMcpServer: (name, config) => servers.set(name, config),
    on: (event, handler) => handlers.set(event, handler),
  });
  return { handlers, servers };
}
function project(hooks: string, status = "planned") {
  const repo = directory();
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, "src/nested"), { recursive: true });
  write(
    join(repo, ".rimewire/config.toml"),
    `tracker = "plans/packages.md"\nidPattern = "TASK-[0-9]+"\njournalDir = "local/activity"\n[hooks]\n${hooks}\n`,
  );
  write(
    join(repo, "plans/packages.md"),
    `# Packages\n## Phase 1\n| ID | Title | Status |\n| --- | --- | --- |\n| TASK-1 | First | ${status} |\n| TASK-2 | Second | planned |\n`,
  );
  return repo;
}
function notes(repo: string) {
  const config = loadConfig(repo);
  return readJournal(journalPath(repo, config), "fixture", config);
}
async function probeNode(script?: string, native = true) {
  const path = directory();
  if (script !== undefined) {
    write(join(path, "node"), `#!${process.execPath}\n${script}`);
    chmodSync(join(path, "node"), 0o755);
  }
  return run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `${native ? 'Object.defineProperty(process.versions, "bun", { value: "fixture" });' : ""}
const { nodeExecutable } = await import(${JSON.stringify(pathToFileURL(adapter).href)});
try { console.log(JSON.stringify({ path: nodeExecutable() })); }
catch (error) { console.log(JSON.stringify({ error: error.message })); }`,
    ],
    { env: { PATH: path }, timeout: 5000 },
  );
}
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("Pi extension", () => {
  it("uses the Node host executable without a PATH lookup", async () => {
    const { stdout, stderr } = await probeNode(undefined, false);
    expect(JSON.parse(stdout)).toEqual({ path: process.execPath });
    expect(stderr).toBe("");
  });

  it("resolves native Pi's PATH shim to an absolute Node executable", async () => {
    const { stdout, stderr } = await probeNode(
      "process.stdout.write(JSON.stringify({path:process.execPath,version:process.versions.node,bun:!!process.versions.bun}));",
    );
    expect(JSON.parse(stdout)).toEqual({ path: process.execPath });
    expect(stderr).toBe("");
  });

  it.each([
    ["missing node", undefined],
    [
      "nonzero exit",
      'console.error("PRIVATE runtime stderr"); process.exit(1);',
    ],
    ["invalid JSON", 'console.log("PRIVATE invalid output");'],
    ["oversized JSON", 'console.log("PRIVATE".repeat(2000));'],
    ["null", 'console.log("null");'],
    [
      "old Node",
      'console.log(JSON.stringify({path:process.execPath,version:"22.23.3",bun:false}));',
    ],
    [
      "relative path",
      'console.log(JSON.stringify({path:"node",version:"26.8.2",bun:false}));',
    ],
    [
      "Bun shim",
      'console.log(JSON.stringify({path:process.execPath,version:"26.8.2",bun:true}));',
    ],
    [
      "missing bun flag",
      'console.log(JSON.stringify({path:process.execPath,version:"26.8.2"}));',
    ],
    [
      "invalid version",
      'console.log(JSON.stringify({path:process.execPath,version:"26.bad",bun:false}));',
    ],
  ])("reports a fixed runtime diagnostic for %s", async (_case, script) => {
    const { stdout, stderr } = await probeNode(script);
    expect(JSON.parse(stdout)).toEqual({
      error: "Rimewire requires an available Node.js 24+ runtime.",
    });
    expect(stderr).toBe("");
  });

  it("bounds the native Pi Node probe to three seconds", async () => {
    const started = Date.now();
    const { stdout } = await probeNode("setTimeout(() => {}, 10000);");
    expect(Date.now() - started).toBeLessThan(4500);
    expect(JSON.parse(stdout)).toEqual({
      error: "Rimewire requires an available Node.js 24+ runtime.",
    });
  });

  it("registers built-in direct MCP with an absolute CLI path and host executable", async () => {
    const { servers, handlers } = await load();
    expect([...servers]).toEqual([
      [
        "rimewire",
        {
          command: process.execPath,
          args: [join(root, "dist/cli.js"), "mcp"],
          exposure: "direct",
        },
      ],
    ]);
    expect([...handlers.keys()]).toEqual(events.map(([event]) => event));
  });

  it.each(events)(
    "%s forwards only ctx.cwd through the relocated CLI",
    async (event, hook) => {
      const installed = directory();
      const entry = join(installed, "adapters/pi/index.mjs");
      mkdirSync(join(installed, "adapters/pi"), { recursive: true });
      cpSync(adapter, entry);
      write(
        join(installed, "dist/cli.js"),
        `const fs = require("node:fs"); let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  fs.writeFileSync("hook.json", JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), execPath: process.execPath, input: JSON.parse(input) }));
});`,
      );
      const cwd = join(directory(), "checkout with spaces");
      mkdirSync(cwd);
      const { servers, handlers } = await load(entry);
      const privateEvent = new Proxy(
        {},
        {
          get() {
            throw new Error("private event was read");
          },
          ownKeys() {
            throw new Error("private event was serialized");
          },
        },
      );
      const ctx = {
        cwd,
        get sessionManager() {
          throw new Error("private history was read");
        },
      };
      await handlers.get(event)?.(privateEvent, ctx);
      expect(servers.get("rimewire")?.args).toEqual([
        join(installed, "dist/cli.js"),
        "mcp",
      ]);
      expect(JSON.parse(readFileSync(join(cwd, "hook.json"), "utf8"))).toEqual({
        args: ["hook", hook],
        cwd,
        execPath: process.execPath,
        input: { cwd },
      });
    },
  );

  it("contains optional CLI failures and invalid cwd without using process.cwd", async () => {
    const { handlers } = await load();
    const start = handlers.get("session_start");
    for (const cwd of ["", "relative", join(directory(), "missing")])
      await expect(start?.({}, { cwd })).resolves.toBeUndefined();
  });

  it("bounds a hanging hook subprocess", async () => {
    const installed = directory();
    const entry = join(installed, "adapters/pi/index.mjs");
    mkdirSync(join(installed, "adapters/pi"), { recursive: true });
    cpSync(adapter, entry);
    write(
      join(installed, "dist/cli.js"),
      'require("node:fs").writeFileSync("pid", String(process.pid)); setTimeout(() => {}, 10000);',
    );
    const { handlers } = await load(entry);
    const cwd = directory();
    const started = Date.now();
    await handlers.get("session_shutdown")?.({}, { cwd });
    expect(Date.now() - started).toBeLessThan(4000);
    const pid = Number(readFileSync(join(cwd, "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("uses the shared configured package gate for fixed notes from nested cwd", async () => {
    const repo = project('enabled = true\npackage = "TASK-2"');
    const { handlers } = await load();
    for (const [event] of events)
      await handlers.get(event)?.(
        { transcript: "private" },
        { cwd: join(repo, "src/nested") },
      );
    expect(
      notes(repo).map(({ wp, kind, text, percent, source }) => ({
        wp,
        kind,
        text,
        percent,
        source,
      })),
    ).toEqual(
      events.map(([, hook, text]) => ({
        wp: "TASK-2",
        kind: "note",
        text,
        percent: null,
        source: `hook:${hook}`,
      })),
    );
    expect(
      readFileSync(journalPath(repo, loadConfig(repo)), "utf8"),
    ).not.toContain("private");
  });

  it.each([
    'enabled = false\npackage = "TASK-1"',
    'package = "TASK-1"',
    "enabled = true",
    'enabled = true\npackage = "TASK-99"',
    'enabled = true\npackage = "../TASK-1"',
  ])("skips activity when the shared gate rejects %s", async (hooks) => {
    const repo = project(hooks);
    const { handlers } = await load();
    for (const [event] of events)
      await handlers.get(event)?.({}, { cwd: repo });
    expect(existsSync(journalPath(repo, loadConfig(repo)))).toBe(false);
  });

  it("session and agent exits neither complete work nor reopen explicit readiness", async () => {
    const repo = project('enabled = true\npackage = "TASK-1"');
    const { handlers } = await load();
    for (const event of ["agent_end", "session_shutdown"])
      await handlers.get(event)?.({}, { cwd: repo });
    expect(summarize(notes(repo))["TASK-1"].ready).toBeNull();
    const config = loadConfig(repo);
    append(
      repo,
      make("TASK-1", "ready", "Checks passed.", null, "fixture", "cli", config),
      config,
    );
    for (const [event] of events)
      await handlers.get(event)?.({}, { cwd: repo });
    expect(summarize(notes(repo))["TASK-1"].ready?.text).toBe("Checks passed.");
  });
});

// Opt in with official npm and/or native Pi paths; no credentials needed.
describe.each([
  ["node", process.env.RIMEWIRE_PI_CLI],
  ["native", process.env.RIMEWIRE_PI_NATIVE],
])("real %s Pi isolated package loading and MCP", (host, pi) => {
  it.skipIf(!pi).each(["package", "settings"])(
    "loads the .mjs entry and shared skill via %s",
    async (mode) => {
      const repo = project('enabled = true\npackage = "TASK-1"');
      const profile = directory();
      const installed = directory();
      mkdirSync(join(installed, "adapters/pi"), { recursive: true });
      cpSync(adapter, join(installed, "adapters/pi/index.mjs"));
      symlinkSync(join(root, "dist"), join(installed, "dist"), "dir");
      symlinkSync(join(root, "skills"), join(installed, "skills"), "dir");
      write(
        join(installed, "package.json"),
        JSON.stringify({
          name: "rimewire-pi-fixture",
          type: "module",
          pi: {
            extensions: ["adapters/pi/index.mjs"],
            skills: ["skills/rimewire-setup"],
          },
        }),
      );
      const settings =
        mode === "package"
          ? { packages: [installed] }
          : {
              extensions: [join(installed, "adapters/pi/index.mjs")],
              skills: [join(installed, "skills/rimewire-setup")],
            };
      write(join(profile, "settings.json"), JSON.stringify(settings));
      const fixture = join(profile, "fixture.mjs");
      write(
        fixture,
        `import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import { writeFileSync } from "node:fs";
export default function(pi) {
  let step = 0;
  const calls = [
    ["board_overview", {}], ["get_package", { wp: "TASK-1" }],
    ["post_update", { wp: "TASK-1", kind: "note", text: "Isolated Pi MCP fixture." }],
    ["list_updates", { wp: "TASK-1" }], ["board_url", {}]
  ];
  pi.registerProvider("rimewire-fixture", {
    api: "rimewire-fixture", apiKey: "local-fixture", baseUrl: "http://127.0.0.1",
    models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
    streamSimple(model, context) {
      if (step === 0) writeFileSync("evidence.json", JSON.stringify({ tools: getCurrentTools(context.messages).map(t => t.name), commands: pi.getCommands(), runtime: pi.getMcpServers().find(server => server.name === "rimewire").config.command }));
      const call = calls[step++];
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content: call ? [{ type: "toolCall", id: "fixture-" + step, name: "mcp__rimewire__" + call[0], arguments: call[1] }] : [{ type: "text", text: "Fixture complete." }],
        stopReason: call ? "toolUse" : "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); return stream;
    }
  });
}`,
      );
      const state = join(profile, "state");
      try {
        const pending = run(
          host === "native" ? (pi ?? "") : process.execPath,
          [
            ...(host === "node" ? [pi ?? ""] : []),
            "--offline",
            ...(host === "node" ? ["--print"] : []),
            "--mode",
            host === "native" ? "rpc" : "json",
            "--no-session",
            "--no-approve",
            "--no-context-files",
            "--no-prompt-templates",
            "--no-themes",
            "--extension",
            fixture,
            "--provider",
            "rimewire-fixture",
            "--model",
            "fixture",
            ...(host === "node" ? ["Exercise the local fixture."] : []),
          ],
          {
            cwd: repo,
            env: {
              PATH: process.env.PATH,
              PI_CODING_AGENT_DIR: profile,
              PI_OFFLINE: "1",
              PI_TELEMETRY: "0",
              XDG_STATE_HOME: state,
              RIMEWIRE_IDLE_MS: "100",
              RIMEWIRE_LEASE_MS: "1000",
              RIMEWIRE_HEARTBEAT_MS: "100",
            },
            timeout: 25000,
            maxBuffer: 1024 * 1024,
          },
        );
        if (host === "native") {
          let buffer = "";
          pending.child.stdout?.setEncoding("utf8");
          pending.child.stdout?.on("data", (chunk: string) => {
            buffer += chunk;
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (JSON.parse(line).type === "agent_settled")
                pending.child.stdin?.end();
            }
          });
          pending.child.stdin?.write(
            `${JSON.stringify({ id: "pi-acceptance", type: "prompt", message: "Exercise the local fixture." })}\n`,
          );
        } else pending.child.stdin?.end();
        const { stdout, stderr } = await pending;
        expect(stderr).not.toMatch(/failed|error|cannot/i);
        const messages = stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        if (host === "native") {
          expect(messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: "pi-acceptance",
                type: "response",
                command: "prompt",
                success: true,
              }),
              expect.objectContaining({ type: "agent_settled" }),
            ]),
          );
        }
        const results = messages.filter(
          (message) => message.type === "tool_execution_end",
        );
        expect(results).toHaveLength(5);
        expect(results.every((message) => !message.isError)).toBe(true);
        const evidence = JSON.parse(
          readFileSync(join(repo, "evidence.json"), "utf8"),
        );
        expect(isAbsolute(evidence.runtime)).toBe(true);
        if (host === "node") expect(evidence.runtime).toBe(process.execPath);
        const runtime = await run(evidence.runtime, [
          "-e",
          "process.stdout.write(JSON.stringify({version:process.versions.node,bun:!!process.versions.bun}))",
        ]);
        expect(JSON.parse(runtime.stdout)).toMatchObject({ bun: false });
        expect(
          Number(JSON.parse(runtime.stdout).version.split(".")[0]),
        ).toBeGreaterThanOrEqual(24);
        expect(
          evidence.tools.filter((name: string) =>
            name.startsWith("mcp__rimewire__"),
          ),
        ).toEqual(
          expect.arrayContaining(
            [
              "board_overview",
              "get_package",
              "post_update",
              "list_updates",
              "board_url",
            ].map((name) => `mcp__rimewire__${name}`),
          ),
        );
        expect(evidence.commands).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "skill:rimewire-setup",
              source: "skill",
            }),
          ]),
        );
        expect(notes(repo).map((note) => note.kind)).not.toContain("ready");
        expect(notes(repo)).toEqual(
          expect.arrayContaining(
            events.map(([, event, text]) =>
              expect.objectContaining({ source: `hook:${event}`, text }),
            ),
          ),
        );
        expect(notes(repo)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              source: "mcp",
              text: "Isolated Pi MCP fixture.",
            }),
          ]),
        );
      } finally {
        const lock = join(state, "rimewire/daemon.json");
        if (existsSync(lock)) {
          const { pid } = JSON.parse(readFileSync(lock, "utf8"));
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            /* Isolated daemon already exited. */
          }
        }
      }
    },
    30000,
  );
});
