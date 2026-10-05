/** Real OpenCode acceptance in a disposable profile; no model or credentials. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { installedPaths } from "./runtime.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const sandbox = mkdtempSync(join(tmpdir(), "rimewire-opencode-smoke-"));
const project = join(sandbox, "project");
const state = join(sandbox, "rimewire-state");
const env = {
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
  LANG: "C.UTF-8",
  XDG_CONFIG_HOME: join(sandbox, "config"),
  XDG_DATA_HOME: join(sandbox, "data"),
  XDG_CACHE_HOME: join(sandbox, "cache"),
  XDG_STATE_HOME: join(sandbox, "state"),
  TMPDIR: join(sandbox, "tmp"),
  OPENCODE_TEST_HOME: join(sandbox, "private-home"),
  OPENCODE_CONFIG_DIR: join(sandbox, "custom-opencode"),
  OPENCODE_DISABLE_AUTOUPDATE: "true",
  OPENCODE_DISABLE_MODELS_FETCH: "true",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
  RIMEWIRE_STATE_DIR: state,
  RIMEWIRE_HEARTBEAT_MS: "100",
  RIMEWIRE_LEASE_MS: "500",
  RIMEWIRE_IDLE_MS: "300",
};
for (const path of [
  project,
  env.TMPDIR,
  env.OPENCODE_CONFIG_DIR,
  env.OPENCODE_TEST_HOME,
])
  mkdirSync(path, { recursive: true });
const run = (command, args, cwd = project) =>
  execFileSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  });
function write(path, content) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}
const journal = join(project, ".rimewire/journal/notes.jsonl");
const notes = () =>
  existsSync(journal)
    ? readFileSync(journal, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const hookConfig = (enabled) =>
  `name = "OpenCode acceptance"\n[hooks]\nenabled = ${enabled}\npackage = "TEST-1"\n`;
let server;
let installed;
let diagnostics = "";
let childPids = [];
async function until(predicate, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  do {
    if (await predicate()) return;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
    }
    return true;
  } catch {
    return false;
  }
}
function runtimePids() {
  if (process.platform !== "linux") return [];
  return readdirSync("/proc")
    .filter((id) => /^\d+$/.test(id))
    .flatMap((id) => {
      try {
        const args = readFileSync(`/proc/${id}/cmdline`, "utf8").split("\0");
        return args.includes(installedPaths(installed).cli) &&
          args.includes("mcp")
          ? [Number(id)]
          : [];
      } catch {
        return [];
      }
    });
}
try {
  const version = run("opencode", ["--version"]).trim();
  console.log(`OpenCode ${version}; Node ${process.versions.node}`);
  run("opencode", ["--help"]);
  run("npm", ["run", "build"], root);
  const packed = JSON.parse(
    run(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", sandbox],
      root,
    ),
  );
  const prefix = join(sandbox, "installed package #1");
  run("npm", [
    "install",
    "--prefix",
    prefix,
    "--cache",
    join(sandbox, "npm-cache"),
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    join(sandbox, packed[0].filename),
  ]);
  installed = join(prefix, "node_modules/rimewire");
  const paths = installedPaths(installed);
  assert.ok(
    existsSync(fileURLToPath(paths.plugin)),
    "npm package contains the adapter entry",
  );
  // No copy of the setup skill into the profile: discovery must use skills.paths.
  run("git", ["init", "--initial-branch=main"]);
  write(join(project, ".rimewire/config.toml"), hookConfig(false));
  write(
    join(project, "docs/board/README.md"),
    "# Board\n\n## Phase 1\n\n| ID | Title | Status |\n| --- | --- | --- |\n| TEST-1 | OpenCode adapter acceptance | planned |\n",
  );
  write(
    join(project, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugin: [paths.plugin],
    }),
  );
  const globalConfig = join(env.XDG_CONFIG_HOME, "opencode");
  write(
    join(globalConfig, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "acceptance/global-json",
    }),
  );
  write(
    join(globalConfig, "opencode.jsonc"),
    '{\n// Keep global JSON and JSONC.\n"$schema": "https://opencode.ai/config.json", "model": "acceptance/global-jsonc"\n}',
  );
  assert.equal(
    JSON.parse(run("opencode", ["debug", "config"])).model,
    "acceptance/global-jsonc",
  );
  const projectJSON = JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "acceptance/project-json",
  });
  write(join(project, "opencode.json"), projectJSON);
  write(
    join(project, "opencode.jsonc"),
    '{\n// Keep project JSON and JSONC.\n"$schema": "https://opencode.ai/config.json", "model": "acceptance/project-jsonc"\n}',
  );
  run(process.execPath, [
    paths.cli,
    "install",
    "opencode",
    "--project",
    "--json",
  ]);
  assert.equal(
    readFileSync(join(project, "opencode.json"), "utf8"),
    projectJSON,
  );
  const registeredJSONC = readFileSync(join(project, "opencode.jsonc"), "utf8");
  assert.ok(registeredJSONC.includes(paths.plugin));
  assert.ok(registeredJSONC.includes("// Keep project JSON and JSONC."));
  run(process.execPath, [
    paths.cli,
    "install",
    "opencode",
    "--project",
    "--json",
  ]);
  assert.equal(
    readFileSync(join(project, "opencode.jsonc"), "utf8"),
    registeredJSONC,
  );
  const resolved = JSON.parse(run("opencode", ["debug", "config"]));
  assert.equal(resolved.model, "acceptance/project-jsonc");
  console.log(
    "Config precedence: global and project JSONC override same-directory JSON.",
  );
  assert.deepEqual(resolved.mcp.rimewire.command, [
    process.execPath,
    paths.cli,
    "mcp",
  ]);
  assert.equal(resolved.mcp.rimewire.timeout, 10000);
  assert.equal(resolved.mcp.rimewire.cwd, undefined);
  assert.ok(resolved.skills.paths.includes(paths.skills));
  const skills = JSON.parse(run("opencode", ["debug", "skill"]));
  const setup = skills.find((skill) => skill.name === "rimewire-setup");
  assert.ok(setup, "real OpenCode discovers the shared setup skill");
  assert.ok(setup.location.startsWith(paths.skills));
  assert.ok(setup.content.includes("board_url"));
  const status = run("opencode", ["mcp", "list"]);
  assert.match(status, /rimewire/);
  assert.match(status, /connected/);
  console.log(
    "Packed install: config injection, shared skill discovery, MCP connection passed.",
  );

  server = spawn(
    "opencode",
    ["serve", "--hostname", "127.0.0.1", "--port", "0"],
    { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout.on("data", (chunk) => {
    diagnostics += chunk;
  });
  server.stderr.on("data", (chunk) => {
    diagnostics += chunk;
  });
  server.on("error", (error) => {
    diagnostics += error.message;
  });
  await until(
    () => /http:\/\/127\.0\.0\.1:\d+/.test(diagnostics),
    "OpenCode headless server",
  );
  const origin = diagnostics.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const api = async (path, body) => {
    const separator = path.includes("?") ? "&" : "?";
    const response = await fetch(
      `${origin}${path}${separator}directory=${encodeURIComponent(project)}`,
      {
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
        signal: AbortSignal.timeout(12000),
      },
    );
    assert.ok(
      response.ok,
      `${path}: ${response.status} ${await response.clone().text()}`,
    );
    return response.json();
  };
  assert.equal((await api("/mcp")).rimewire.status, "connected");
  childPids = runtimePids();
  if (process.platform === "linux") assert.ok(childPids.length > 0);
  await until(() => existsSync(join(state, "daemon.json")), "board daemon");
  const lock = JSON.parse(readFileSync(join(state, "daemon.json"), "utf8"));
  const board = await fetch(`http://127.0.0.1:${lock.port}/api/projects`);
  assert.ok(board.ok, "board reachable while OpenCode runs");
  assert.ok(
    (await board.json()).projects.some((item) => item.root === project),
    "MCP registers the actual checkout, not the installed package directory",
  );

  const disabled = await api("/session", {});
  await api(`/session/${disabled.id}/abort`, {});
  await delay(500);
  assert.equal(notes().length, 0, "disabled project writes no journal");
  write(join(project, ".rimewire/config.toml"), hookConfig(true));
  const active = await api("/session", {});
  await until(
    () => notes().some((note) => note.source === "hook:OpenCodeSessionCreated"),
    "real session.created hook",
  );
  await api(`/session/${active.id}/shell`, {
    agent: "build",
    model: { providerID: "opencode", modelID: "acceptance-no-model" },
    command: "printf 'PRIVATE-OPENCODE-SMOKE'",
  });
  await until(
    () => notes().some((note) => note.source === "hook:OpenCodeSessionIdle"),
    "real session.idle hook",
  );
  assert.ok(
    notes().every((note) => note.kind === "note" && note.percent === null),
  );
  assert.ok(!readFileSync(journal, "utf8").includes("PRIVATE-OPENCODE-SMOKE"));
  console.log(
    "Real session events: opt-in gate, fixed OpenCode notes, privacy, no completion passed.",
  );

  await api("/instance/dispose", {});
  await until(
    () => childPids.every((pid) => !alive(pid)) && runtimePids().length === 0,
    "MCP child disposal",
    5000,
  );
  await until(() => !alive(lock.pid), "detached board idle exit", 5000);
  server.kill("SIGTERM");
  await until(() => !alive(server.pid), "OpenCode shutdown", 5000);
  console.log(
    "Instance disposal and shutdown: MCP children and private board daemon exited.",
  );
  run(process.execPath, [
    paths.cli,
    "uninstall",
    "opencode",
    "--project",
    "--json",
  ]);
  assert.equal(
    readFileSync(join(project, "opencode.json"), "utf8"),
    projectJSON,
  );
  const uninstalledJSONC = readFileSync(
    join(project, "opencode.jsonc"),
    "utf8",
  );
  assert.ok(!uninstalledJSONC.includes(paths.plugin));
  assert.ok(uninstalledJSONC.includes("// Keep project JSON and JSONC."));
  assert.ok(uninstalledJSONC.includes("acceptance/project-jsonc"));
  console.log(
    "Installer: JSONC selection, preservation, idempotence and uninstall passed.",
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (server?.pid && alive(server.pid)) server.kill("SIGKILL");
  for (const pid of installed ? runtimePids() : childPids)
    if (alive(pid)) process.kill(pid, "SIGKILL");
  if (existsSync(join(state, "daemon.json"))) {
    const { pid } = JSON.parse(
      readFileSync(join(state, "daemon.json"), "utf8"),
    );
    if (alive(pid)) process.kill(pid, "SIGTERM");
  }
  rmSync(sandbox, { recursive: true, force: true });
}
