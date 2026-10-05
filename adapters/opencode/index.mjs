import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { checkedPaths, nodeExecutable } from "./runtime.mjs";

/**
 * OpenCode legacy plugin entry. Export only this plugin: OpenCode calls every
 * function export as a plugin. Installer helpers live in runtime.mjs instead.
 * @param {{directory: string, client?: {app?: {log?: (input: unknown, options?: {signal: AbortSignal}) => Promise<unknown>}}}} context
 */
export default async function RimewirePlugin({ directory, client }) {
  const paths = checkedPaths();
  /** @type {string | undefined} */
  let node;
  let disposed = false;
  /** @type {Set<import('node:child_process').ChildProcess>} */
  const children = new Set();
  /** @type {Set<Promise<void>>} */
  const pending = new Set();
  const runtime = () => (node ??= nodeExecutable());

  async function diagnostic() {
    try {
      await client?.app?.log?.(
        {
          body: {
            service: "rimewire",
            level: "warn",
            message:
              "Optional Rimewire hook could not run; continuing without a board update.",
          },
        },
        { signal: AbortSignal.timeout(500) },
      );
    } catch {
      // Optional activity cannot interrupt a session, even if logging fails.
    }
  }

  /** Feed only cwd and a fixed event name to the Node CLI's shared hook handler.
   * @param {string} event
   */
  async function activity(event) {
    if (disposed || typeof directory !== "string" || !isAbsolute(directory))
      return;
    try {
      /** @type {Promise<void>} */
      const operation = new Promise((resolve) => {
        const child = execFile(
          runtime(),
          [paths.cli, "hook", event],
          { timeout: 3000, killSignal: "SIGKILL", windowsHide: true },
          (error) => {
            children.delete(child);
            if (error && !disposed) void diagnostic();
            resolve();
          },
        );
        children.add(child);
        child.stdin?.on("error", () => {});
        child.stdin?.end(JSON.stringify({ cwd: directory }));
      });
      pending.add(operation);
      try {
        await operation;
      } finally {
        pending.delete(operation);
      }
    } catch {
      if (!disposed) void diagnostic();
    }
  }

  return {
    /** @param {{mcp?: Record<string, unknown>, skills?: {paths?: string[], [key: string]: unknown}}} config */
    config: async (config) => {
      if (
        (config.mcp !== undefined &&
          (config.mcp === null ||
            typeof config.mcp !== "object" ||
            Array.isArray(config.mcp))) ||
        (config.skills !== undefined &&
          (config.skills === null ||
            typeof config.skills !== "object" ||
            Array.isArray(config.skills))) ||
        (config.skills?.paths !== undefined &&
          (!Array.isArray(config.skills.paths) ||
            config.skills.paths.some((path) => typeof path !== "string")))
      )
        throw new Error(
          "Rimewire requires valid OpenCode MCP and skill configuration.",
        );
      const existing = Object.hasOwn(config.mcp ?? {}, "rimewire");
      // Preserve a user's server, including an explicit enabled:false override.
      const server = existing
        ? undefined
        : {
            type: "local",
            command: [runtime(), paths.cli, "mcp"],
            enabled: true,
            timeout: 10000,
          };
      if (server) {
        config.mcp ??= {};
        config.mcp.rimewire = server;
      }
      config.skills ??= {};
      config.skills.paths ??= [];
      const skills = config.skills.paths;
      if (!skills.includes(paths.skills)) skills.push(paths.skills);
    },
    // No event properties, prompts, tool args/results, or session IDs are read.
    /** @param {{event: {type: string}}} input */
    event: async ({ event }) => {
      if (event.type === "session.created")
        await activity("OpenCodeSessionCreated");
      else if (event.type === "session.idle")
        await activity("OpenCodeSessionIdle");
    },
    dispose: async () => {
      disposed = true;
      for (const child of children) child.kill("SIGKILL");
      await Promise.all(pending);
    },
  };
}
