import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RimewirePlugin, {
  type OpenCodeConfig,
} from "../adapters/opencode/index.mjs";
import {
  checkedPaths,
  installedPaths,
  nodeExecutable,
} from "../adapters/opencode/runtime.mjs";
import { loadConfig } from "../src/config.js";
import {
  append,
  journalPath,
  make,
  readJournal,
  summarize,
} from "../src/journal.js";
import {
  projectDirectory,
  removeRepo,
  tempRepo,
  write,
} from "./fixtures/helpers.js";

describe("OpenCode npm plugin adapter", () => {
  let repo: string;
  beforeEach(() => {
    repo = tempRepo();
    mkdirSync(join(repo, ".git"));
    write(
      repo,
      "docs/board/README.md",
      `# Board
## Phase 1
| ID | Title | Status |
| --- | --- | --- |
| TEST-1 | Adapter | planned |
`,
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    removeRepo(repo);
  });

  it("has only a single plugin export for OpenCode's legacy loader", async () => {
    expect(Object.keys(await import("../adapters/opencode/index.mjs"))).toEqual(
      ["default"],
    );
  });

  it("registers an absolute Node/installed CLI command, timeout, and the entire shared skill directory", async () => {
    const hooks = await RimewirePlugin({ directory: repo });
    const config: OpenCodeConfig = {};
    await hooks.config(config);
    expect(config.mcp?.rimewire).toEqual({
      type: "local",
      command: [process.execPath, join(projectDirectory, "dist/cli.js"), "mcp"],
      enabled: true,
      timeout: 10000,
    });
    expect(config.mcp?.rimewire).not.toHaveProperty("cwd");
    expect(config.skills?.paths).toEqual([join(projectDirectory, "skills")]);
    expect(nodeExecutable()).toBe(process.execPath);
    for (const path of [checkedPaths().cli, checkedPaths().skills])
      expect(isAbsolute(path)).toBe(true);
  });

  it("preserves unrelated config and deduplicates its skill path on repeat registration", async () => {
    const hooks = await RimewirePlugin({ directory: repo });
    const otherServer = { type: "remote", url: "https://example.invalid/mcp" };
    const paths = ["./team-skills", checkedPaths().skills];
    const config: OpenCodeConfig = {
      mcp: { other: otherServer },
      skills: { paths, urls: ["https://example.invalid/skills"] },
      permission: { bash: "ask" },
      plugin: ["other-plugin"],
    };
    await hooks.config(config);
    const server = config.mcp?.rimewire;
    await hooks.config(config);
    expect(config.mcp?.rimewire).toBe(server);
    expect(config.mcp?.other).toBe(otherServer);
    expect(config.skills?.paths).toBe(paths);
    expect(paths).toEqual(["./team-skills", checkedPaths().skills]);
    expect(config.skills?.urls).toEqual(["https://example.invalid/skills"]);
    expect(config.permission).toEqual({ bash: "ask" });
    expect(config.plugin).toEqual(["other-plugin"]);
  });

  it.each([
    { enabled: false },
    { type: "remote", url: "https://example.invalid/custom", enabled: true },
    { type: "local", command: ["custom", "mcp"], timeout: 22000 },
  ])(
    "deliberately preserves an existing rimewire registration (%#)",
    async (existing) => {
      const hooks = await RimewirePlugin({ directory: repo });
      const config: OpenCodeConfig = { mcp: { rimewire: existing } };
      await hooks.config(config);
      expect(config.mcp?.rimewire).toBe(existing);
      expect(config.skills?.paths).toEqual([checkedPaths().skills]);
    },
  );

  it.each([
    { mcp: null },
    { mcp: [] },
    { mcp: "private" },
    { skills: null },
    { skills: [] },
    { skills: { paths: "private" } },
    { skills: { paths: ["valid", 42] } },
  ])(
    "rejects malformed config before making any mutation (%#)",
    async (input) => {
      const hooks = await RimewirePlugin({ directory: repo });
      const original = structuredClone(input);
      await expect(hooks.config(input as OpenCodeConfig)).rejects.toThrow(
        "Rimewire requires valid OpenCode MCP and skill configuration.",
      );
      expect(input).toEqual(original);
    },
  );

  it("exports installer paths as a correctly escaped file URL, including relocated paths with spaces", () => {
    const root = join(repo, "installed package #1");
    expect(installedPaths(root)).toEqual({
      plugin: pathToFileURL(join(root, "adapters/opencode/index.mjs")).href,
      cli: join(root, "dist/cli.js"),
      skills: join(root, "skills"),
    });
    expect(() => installedPaths("relative/package")).toThrow(
      "must be absolute",
    );
    expect(() => checkedPaths(root)).toThrow(
      "installed runtime or shared setup skill is missing",
    );
  });

  async function copiedPlugin(cli: string) {
    const root = join(repo, "installed package");
    cpSync(
      join(projectDirectory, "adapters/opencode"),
      join(root, "adapters/opencode"),
      {
        recursive: true,
      },
    );
    write(root, "skills/rimewire-setup/SKILL.md", "shared skill fixture");
    write(root, "dist/cli.js", cli);
    const module = (await import(
      join(root, "adapters/opencode/index.mjs")
    )) as {
      default: typeof RimewirePlugin;
    };
    return { plugin: module.default, root };
  }

  it("relocates with the installed package and sends only fixed hook event/cwd to a child runtime", async () => {
    const { plugin, root } = await copiedPlugin(`
      const fs = require('node:fs');
      let input = '';
      process.stdin.on('data', (chunk) => input += chunk);
      process.stdin.on('end', () => fs.appendFileSync(
        JSON.parse(input).cwd + '/capture.jsonl',
        JSON.stringify({ args: process.argv.slice(2), payload: JSON.parse(input) }) + '\\n'));
    `);
    const hooks = await plugin({ directory: repo });
    const config: OpenCodeConfig = {};
    await hooks.config(config);
    expect(config.mcp?.rimewire).toMatchObject({
      command: [process.execPath, join(root, "dist/cli.js"), "mcp"],
    });
    expect(config.skills?.paths).toEqual([join(root, "skills")]);
    const secret = vi.fn(() => {
      throw new Error("PRIVATE prompt, tool arguments, or session data");
    });
    for (const type of [
      "session.created",
      "session.idle",
      "tool.execute.after",
      "message.updated",
      "session.deleted",
    ]) {
      await hooks.event({
        event: Object.defineProperty({ type }, "properties", { get: secret }),
      });
    }
    expect(secret).not.toHaveBeenCalled();
    const records = readFileSync(join(repo, "capture.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toEqual([
      { args: ["hook", "OpenCodeSessionCreated"], payload: { cwd: repo } },
      { args: ["hook", "OpenCodeSessionIdle"], payload: { cwd: repo } },
    ]);
  });

  it("fails open with a fixed diagnostic and does not expose child output or private errors", async () => {
    const { plugin } = await copiedPlugin(
      "console.error('PRIVATE-FAILURE'); console.log('PRIVATE-OUTPUT'); process.exit(1);",
    );
    const log = vi.fn(async () => undefined);
    const hooks = await plugin({ directory: repo, client: { app: { log } } });
    await expect(
      hooks.event({ event: { type: "session.idle" } }),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledExactlyOnceWith(
      {
        body: {
          service: "rimewire",
          level: "warn",
          message:
            "Optional Rimewire hook could not run; continuing without a board update.",
        },
      },
      { signal: expect.any(AbortSignal) },
    );
    log.mockRejectedValueOnce(new Error("PRIVATE log failure"));
    await expect(
      hooks.event({ event: { type: "session.created" } }),
    ).resolves.toBeUndefined();
    expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE");
  });

  it("bounds optional child hooks even if the child hangs", async () => {
    const { plugin } = await copiedPlugin("setInterval(() => {}, 1000);");
    const log = vi.fn(async () => undefined);
    const hooks = await plugin({ directory: repo, client: { app: { log } } });
    const started = Date.now();
    await hooks.event({ event: { type: "session.idle" } });
    expect(Date.now() - started).toBeLessThan(5500);
    expect(log).toHaveBeenCalledOnce();
  }, 6000);

  it("kills and waits for pending hook children on disposal, then ignores later events", async () => {
    const { plugin } = await copiedPlugin("setInterval(() => {}, 1000);");
    const log = vi.fn(async () => undefined);
    const hooks = await plugin({ directory: repo, client: { app: { log } } });
    const activity = hooks.event({ event: { type: "session.idle" } });
    const started = Date.now();
    await hooks.dispose();
    await activity;
    expect(Date.now() - started).toBeLessThan(1500);
    await hooks.event({ event: { type: "session.created" } });
    expect(log).not.toHaveBeenCalled();
  });

  it("ignores relative checkout contexts instead of borrowing the plugin or process cwd", async () => {
    const hooks = await RimewirePlugin({ directory: "." });
    await hooks.event({ event: { type: "session.created" } });
    expect(existsSync(join(repo, ".rimewire/journal/notes.jsonl"))).toBe(false);
  });

  it("keeps hooks opt-in and feeds the shared core fixed OpenCode provenance without marking completion", async () => {
    const hooks = await RimewirePlugin({ directory: repo });
    write(repo, ".rimewire/config.toml", 'name = "Adapter fixture"\n');
    await hooks.event({ event: { type: "session.created" } });
    expect(existsSync(journalPath(repo))).toBe(false);
    write(
      repo,
      ".rimewire/config.toml",
      'name = "Adapter fixture"\n[hooks]\nenabled = true\npackage = "TEST-1"\n',
    );
    const config = loadConfig(repo);
    append(
      repo,
      make(
        "TEST-1",
        "ready",
        "Explicit completed work",
        null,
        "fixture",
        "cli",
        config,
      ),
      config,
    );
    await hooks.event({
      event: { type: "session.created", prompt: "PRIVATE" },
    });
    await hooks.event({ event: { type: "session.idle", content: "PRIVATE" } });
    const notes = readJournal(journalPath(repo), "fixture", config);
    expect(notes).toHaveLength(3);
    expect(notes.slice(1)).toMatchObject([
      {
        wp: "TEST-1",
        kind: "note",
        source: "hook:OpenCodeSessionCreated",
        text: "OpenCode session created.",
        percent: null,
      },
      {
        wp: "TEST-1",
        kind: "note",
        source: "hook:OpenCodeSessionIdle",
        text: "OpenCode session idle.",
        percent: null,
      },
    ]);
    expect(summarize(notes)["TEST-1"].ready).not.toBeNull();
    expect(readFileSync(journalPath(repo), "utf8")).not.toContain("PRIVATE");
  });
});
