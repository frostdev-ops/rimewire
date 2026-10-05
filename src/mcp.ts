/** Harness-independent MCP tools; the caller owns transports and the web board lifecycle. */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { build, detail, everyItem, type Snapshot } from "./board.js";
import { loadConfig } from "./config.js";
import { mainRepository, worktrees } from "./gitinfo.js";
import {
  append,
  KINDS,
  MAX_AUTHOR,
  MAX_ID,
  MAX_TEXT,
  make,
  readAll,
  WP_ID,
} from "./journal.js";

export interface McpOptions {
  boardUrl?: () => Promise<string> | string;
}

const packageId = z.string().trim().min(1).max(MAX_ID).regex(WP_ID);
const noArguments = z.object({}).strict();
const packageArguments = z.object({ wp: packageId }).strict();
const updateArguments = z
  .object({
    wp: packageId,
    kind: z.enum(KINDS),
    text: z.string().trim().max(MAX_TEXT).default(""),
    percent: z.number().int().min(0).max(100).optional(),
    author: z.string().trim().max(MAX_AUTHOR).optional(),
  })
  .strict()
  .superRefine((update, ctx) => {
    if (!update.text && (update.kind === "note" || update.kind === "blocker"))
      ctx.addIssue({
        code: "custom",
        path: ["text"],
        message: `a ${update.kind} needs text`,
      });
    if (
      update.kind === "progress" &&
      update.percent === undefined &&
      !update.text
    )
      ctx.addIssue({
        code: "custom",
        message: "a progress update needs percent, text, or both",
      });
    if (
      update.percent !== undefined &&
      update.kind !== "progress" &&
      update.kind !== "ready"
    )
      ctx.addIssue({
        code: "custom",
        path: ["percent"],
        message: "only progress and ready updates carry a percent",
      });
  });
const listArguments = z
  .object({
    wp: packageId.optional(),
    limit: z.number().int().min(1).max(200).default(20),
  })
  .strict();
const readOnly = { readOnlyHint: true, openWorldHint: false };

function result(structuredContent: Record<string, unknown>): CallToolResult {
  return {
    structuredContent,
    content: [
      { type: "text", text: JSON.stringify(structuredContent, null, 2) },
    ],
  };
}

function requirePackage(board: Snapshot, wp: string) {
  for (const item of everyItem(board)) if (item.id === wp) return item;
  throw new Error(`Unknown work-package ID: ${wp}`);
}

/** Every call rereads config, tracker, Git worktrees, and their journals. */
export function createMcpServer(
  checkout: string,
  options: McpOptions = {},
): McpServer {
  checkout = resolve(checkout);
  const server = new McpServer({ name: "rimewire", version: "0.1.0" });

  function state() {
    const repo = mainRepository(checkout);
    const config = loadConfig(
      existsSync(join(checkout, ".rimewire", "config.toml")) ? checkout : repo,
    );
    return { repo, config, board: build(repo, config) };
  }

  // The official SDK reports schema and handler failures as isError tool results.
  server.registerTool(
    "board_overview",
    {
      description:
        "Fresh project board: phases, packages, status counts, active work, blockers, and recent updates.",
      inputSchema: noArguments,
      annotations: readOnly,
    },
    () => {
      const { config, board } = state();
      return result({
        ...board,
        project: {
          name: config.name,
          tracker: config.tracker,
          journalDir: config.journalDir,
        },
      });
    },
  );
  server.registerTool(
    "get_package",
    {
      description:
        "Package detail including spec, status, branch/worktree, and updates.",
      inputSchema: packageArguments,
      annotations: readOnly,
    },
    ({ wp }) => {
      const { repo, config, board } = state();
      const item = requirePackage(board, wp);
      const packageDetail = detail(repo, board, item.key, config);
      if (!packageDetail) throw new Error(`Unknown work-package ID: ${wp}`);
      return result({ ...packageDetail });
    },
  );
  server.registerTool(
    "post_update",
    {
      description:
        "Append a checkout-local update. Progress needs percent or text; explicit ready completes a package, and later progress/blocker reopens it.",
      inputSchema: updateArguments,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ wp, kind, text, percent, author }) => {
      const { config, board } = state();
      requirePackage(board, wp);
      const note = make(wp, kind, text, percent ?? null, author, "mcp", config);
      append(checkout, note, config);
      return result({ note });
    },
  );
  server.registerTool(
    "list_updates",
    {
      description:
        "Updates from all project worktrees, newest first; optionally filter by package.",
      inputSchema: listArguments,
      annotations: readOnly,
    },
    ({ wp, limit }) => {
      const { repo, config, board } = state();
      if (wp !== undefined) requirePackage(board, wp);
      const updates = readAll(
        repo,
        worktrees(repo).map((tree) => tree.path),
        config,
      )
        .filter((note) => wp === undefined || note.wp === wp)
        .reverse()
        .slice(0, limit);
      return result({ updates });
    },
  );
  server.registerTool(
    "board_url",
    {
      description: "URL of the running web board for this project.",
      inputSchema: noArguments,
      annotations: readOnly,
    },
    async () => {
      if (!options.boardUrl) throw new Error("Board not started");
      return result({ url: await options.boardUrl() });
    },
  );
  return server;
}
