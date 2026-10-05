/** Optional harness lifecycle activity; the payload contributes only its checkout cwd. */
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { build, everyItem } from "./board.js";
import { type Config, loadConfig } from "./config.js";
import { mainRepository } from "./gitinfo.js";
import { append, make } from "./journal.js";
import { isPackageId } from "./tracker.js";

const messages = {
  SessionStart: "Claude session started.",
  SessionEnd: "Claude session ended.",
  SubagentStart: "Claude subagent started.",
  SubagentStop: "Claude subagent stopped.",
  Stop: "Claude agent stopped.",
  CodexSessionStart: "Codex session started.",
  CodexSessionEnd: "Codex session ended.",
  CodexSubagentStart: "Codex subagent started.",
  CodexSubagentStop: "Codex subagent stopped.",
  CodexStop: "Codex agent stopped.",
  OpenCodeSessionCreated: "OpenCode session created.",
  OpenCodeSessionIdle: "OpenCode session idle.",
  PiSessionStart: "Pi session started.",
  PiSessionShutdown: "Pi session shut down.",
  PiAgentEnd: "Pi agent ended.",
} as const;
type HookEvent = keyof typeof messages;

const startContext =
  "Rimewire: Read the project board with board_overview and get_package before starting work. " +
  "Keep it updated with post_update, inspect recent activity with list_updates, and use board_url to locate the local board.";

function checkoutAt(cwd: string): string | undefined {
  if (!isAbsolute(cwd) || !statSync(cwd).isDirectory()) return;
  let directory = realpathSync(cwd);
  for (;;) {
    if (existsSync(join(directory, ".git"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

function knownPackage(wp: string, roots: string[], config: Config): boolean {
  for (const root of new Set(roots)) {
    try {
      // No Git subprocesses: a lifecycle hook needs only the local board model.
      for (const item of everyItem(build(root, config, false)))
        if (item.id === wp) return true;
    } catch {
      // An uncommitted or missing worktree tracker may still exist in the main repo.
    }
  }
  return false;
}

/**
 * Start events return plain contextual instructions for the CLI to print.
 * All updates are fixed activity notes; neither starts nor exits alter readiness.
 * Hook failures are optional, with a fixed diagnostic that cannot echo private input.
 */
export async function runHook(
  event: string,
  payload: unknown,
): Promise<string | undefined> {
  try {
    if (!Object.hasOwn(messages, event)) return;
    if (
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    )
      return;
    // Never spread, serialize, or read any other hook payload field.
    const cwd = (payload as { cwd?: unknown }).cwd;
    if (typeof cwd !== "string" || !cwd.trim()) return;
    const checkout = checkoutAt(cwd);
    if (!checkout) return;
    const repo = mainRepository(checkout);
    const config = loadConfig(
      existsSync(join(checkout, ".rimewire", "config.toml")) ? checkout : repo,
    );
    const wp = config.hooks.package;
    if (
      config.hooks.enabled !== true ||
      typeof wp !== "string" ||
      !isPackageId(wp, config) ||
      !knownPackage(wp, [checkout, repo], config)
    )
      return;
    const hookEvent = event as HookEvent;
    append(
      checkout,
      make(
        wp,
        "note",
        messages[hookEvent],
        null,
        "agent",
        `hook:${hookEvent}`,
        config,
      ),
      config,
    );
    if (
      [
        "SessionStart",
        "SubagentStart",
        "CodexSessionStart",
        "CodexSubagentStart",
        "OpenCodeSessionCreated",
        "PiSessionStart",
      ].includes(hookEvent)
    )
      return startContext;
  } catch {
    try {
      process.stderr.write(
        "rimewire: optional hook could not run; continuing without a board update.\n",
      );
    } catch {
      // Even unavailable diagnostics must not interrupt the user's session.
    }
  }
}
