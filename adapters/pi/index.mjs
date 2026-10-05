import { execFileSync, spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

/** Native Pi embeds Bun, so resolve the actual Node executable on PATH once. */
export function nodeExecutable() {
  try {
    const runtime = process.versions.bun
      ? JSON.parse(
          execFileSync(
            "node",
            [
              "-e",
              "process.stdout.write(JSON.stringify({path:process.execPath,version:process.versions.node,bun:!!process.versions.bun}))",
            ],
            {
              encoding: "utf8",
              timeout: 3000,
              killSignal: "SIGKILL",
              maxBuffer: 4096,
              stdio: ["ignore", "pipe", "ignore"],
            },
          ),
        )
      : { path: process.execPath, version: process.versions.node, bun: false };
    if (
      runtime?.bun !== false ||
      typeof runtime.path !== "string" ||
      !isAbsolute(runtime.path) ||
      typeof runtime.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(runtime.version) ||
      Number(runtime.version.split(".")[0]) < 24
    )
      throw new Error();
    return runtime.path;
  } catch {
    throw new Error("Rimewire requires an available Node.js 24+ runtime.");
  }
}

/** Forward only the event context's checkout directory to the shared opt-in gate. */
async function activity(node, event, cwd) {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return;
  try {
    await new Promise((resolve) => {
      const child = spawn(node, [cli, "hook", event], {
        cwd,
        stdio: ["pipe", "ignore", "ignore"],
        timeout: 1500,
        killSignal: "SIGKILL",
      });
      child.once("error", resolve);
      child.once("close", resolve);
      // A failed or timed-out child may close stdin before reading the payload.
      child.stdin.on("error", () => {});
      child.stdin.end(`${JSON.stringify({ cwd })}\n`);
    });
  } catch {
    // Optional activity must neither interrupt Pi nor echo private event data.
  }
}

/** A Pi package entry: built-in MCP owns tools, connections, and shutdown. */
export default function rimewire(pi) {
  const node = nodeExecutable();
  pi.registerMcpServer("rimewire", {
    command: node,
    args: [cli, "mcp"],
    exposure: "direct",
  });

  for (const [event, hook] of [
    ["session_start", "PiSessionStart"],
    ["agent_end", "PiAgentEnd"],
    ["session_shutdown", "PiSessionShutdown"],
  ]) {
    pi.on(event, async (_event, ctx) => activity(node, hook, ctx.cwd));
  }
}
