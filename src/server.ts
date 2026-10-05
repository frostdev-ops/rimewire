import { readFileSync, realpathSync, statSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build, detail, everyItem, signature } from "./board.js";
import { type Config, loadConfig } from "./config.js";
import { worktrees } from "./gitinfo.js";
import { append, make, readAll } from "./journal.js";
import { parseSpec } from "./tracker.js";

export const MAX_POST = 16 * 1024;
const STATIC = fileURLToPath(new URL("../static/", import.meta.url));
const DOC_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const STATIC_FILES: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/board.js": ["board.js", "text/javascript; charset=utf-8"],
  "/appearance.js": ["appearance.js", "text/javascript; charset=utf-8"],
  "/mark.png": ["mark.png", "image/png"],
  "/board.css": ["board.css", "text/css; charset=utf-8"],
  "/mark.svg": ["mark.svg", "image/svg+xml"],
};
const IMAGE_TYPES: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  ico: "image/x-icon",
};

export interface BoardServerOptions {
  config?: Config;
  staticDir?: string;
  /** Change polling and SSE heartbeat intervals, in milliseconds. */
  pollInterval?: number;
  heartbeatInterval?: number;
  withGit?: boolean;
  /** Outer listener port when this board is mounted by the shared daemon. */
  publicPort?: () => number;
}

/** A resolved file must stay inside both the project and its allowed document directory. */
function safeFile(repo: string, root: string, name: string): string | null {
  const inside = (base: string, target: string) => {
    const rel = relative(base, target);
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  try {
    const project = realpathSync(repo);
    const directory = realpathSync(root);
    const path = realpathSync(resolve(root, name));
    return inside(project, directory) &&
      inside(directory, path) &&
      statSync(path).isFile()
      ? path
      : null;
  } catch {
    return null;
  }
}

export class BoardState {
  board: ReturnType<typeof build> | null = null;
  config: Config;
  version = 0;
  error = "";
  readonly started = Date.now() / 1000;
  private firstSeen = new Map<string, number | null>();
  private lastClass = new Map<string, string>();
  private changed = new Map<string, [number, string]>();
  private sig = "";

  constructor(
    readonly repo: string,
    private options: BoardServerOptions,
  ) {
    this.config = options.config ?? loadConfig(repo);
  }

  rebuild(): void {
    try {
      const config = this.options.config ?? loadConfig(this.repo);
      const fresh = build(this.repo, config, this.options.withGit ?? true);
      const now = Date.now() / 1000;
      for (const item of everyItem(fresh)) {
        if (!this.firstSeen.has(item.key))
          this.firstSeen.set(item.key, this.board === null ? null : now);
        const previous = this.lastClass.get(item.key);
        if (previous !== undefined && previous !== item.cls)
          this.changed.set(item.key, [now, previous]);
        this.lastClass.set(item.key, item.cls);
        item.arrived_at = this.firstSeen.get(item.key) ?? null;
        item.arrived = item.arrived_at !== null;
        const change = this.changed.get(item.key);
        if (change) [item.changed_at, item.previous_cls] = change;
      }
      this.config = config;
      this.board = fresh;
      this.error = "";
    } catch (error) {
      this.error =
        error instanceof Error ? error.message : "Could not rebuild the board";
    }
    this.version += 1;
  }

  poll(): boolean {
    let next: string;
    try {
      const config = this.options.config ?? loadConfig(this.repo);
      const stylesheet =
        config.stylesheet && safeFile(this.repo, this.repo, config.stylesheet);
      next = JSON.stringify([
        config,
        signature(this.repo, config),
        stylesheet ? readFileSync(stylesheet, "utf8") : null,
      ]);
    } catch (error) {
      next = `error:${error instanceof Error ? error.message : "unavailable"}`;
    }
    if (next === this.sig) return false;
    this.sig = next;
    this.rebuild();
    return true;
  }

  snapshot() {
    return (
      this.board && {
        ...this.board,
        project: {
          name: this.config.name,
          tracker: this.config.tracker,
          journalDir: this.config.journalDir,
          palette: this.config.palette,
          fonts: this.config.fonts,
          stylesheet: this.config.stylesheet ? "/brand/custom.css" : null,
          logo: this.config.logo ? "/brand/mark.svg" : null,
        },
        version: this.version,
        server_started: this.started,
        error: this.error,
      }
    );
  }
}

export type BoardServer = Server & {
  state: BoardState;
  rebuild(): void;
  poll(): void;
};

/** Create an unbound HTTP server. The CLI binds it only to 127.0.0.1. */
export function createBoardServer(
  repo: string,
  options: BoardServerOptions = {},
): BoardServer {
  const state = new BoardState(resolve(repo), options);
  state.poll();
  const clients = new Set<ServerResponse>();
  const broadcast = () => {
    for (const client of clients)
      client.write(
        `event: version\ndata: ${state.version}@${state.started}\n\n`,
      );
  };

  function bytes(
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer | string,
    type: string,
    status = 200,
  ) {
    res.writeHead(status, {
      "Content-Type": type,
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  }
  function json(
    req: IncomingMessage,
    res: ServerResponse,
    value: unknown,
    status = 200,
  ) {
    bytes(
      req,
      res,
      JSON.stringify(value),
      "application/json; charset=utf-8",
      status,
    );
  }

  async function post(req: IncomingMessage, res: ServerResponse) {
    const address = server.address();
    const port =
      options.publicPort?.() ??
      (address && typeof address !== "string" ? address.port : 0);
    const origin = req.headers.origin;
    const type = req.headers["content-type"]
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    if (
      type !== "application/json" ||
      (origin !== undefined &&
        ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(
          origin,
        ))
    ) {
      json(
        req,
        res,
        {
          error:
            "send JSON from a local client (Content-Type: application/json)",
        },
        403,
      );
      req.resume();
      return;
    }
    const lengthHeader = req.headers["content-length"];
    if (!lengthHeader || !/^\d+$/.test(lengthHeader)) {
      json(req, res, { error: "Content-Length required" }, 411);
      req.resume();
      return;
    }
    const length = Number(lengthHeader);
    if (length <= 0 || length > MAX_POST) {
      json(req, res, { error: `body must be 1 to ${MAX_POST} bytes` }, 413);
      req.resume();
      return;
    }
    let note: ReturnType<typeof make>;
    try {
      const chunks: Buffer[] = [];
      let received = 0;
      for await (const chunk of req) {
        received += chunk.length;
        if (received > MAX_POST)
          throw new Error(`body must be 1 to ${MAX_POST} bytes`);
        chunks.push(chunk);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error("body must be a JSON object");
      const value = body as Record<string, unknown>;
      for (const field of ["wp", "kind", "text", "author"]) {
        if (value[field] !== undefined && typeof value[field] !== "string")
          throw new Error(`${field} must be a string`);
      }
      note = make(
        (value.wp as string) ?? "",
        (value.kind as string) ?? "note",
        (value.text as string) ?? "",
        (value.percent ?? null) as number | null,
        (value.author as string) || "api",
        "web",
        state.config,
      );
    } catch (error) {
      json(
        req,
        res,
        { error: error instanceof Error ? error.message : "Invalid note" },
        400,
      );
      return;
    }
    try {
      append(state.repo, note, state.config);
    } catch (error) {
      json(
        req,
        res,
        {
          error: `could not write the journal: ${error instanceof Error ? error.message : "unavailable"}`,
        },
        500,
      );
      return;
    }
    json(req, res, { note }, 201);
    server.poll();
  }

  const server = createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      json(req, res, { error: "invalid request URL" }, 400);
      req.resume();
      return;
    }
    const path = url.pathname;
    if (req.method === "POST") {
      if (path === "/api/notes")
        void post(req, res).catch(() => {
          if (!res.writableEnded) res.destroy();
        });
      else {
        json(req, res, { error: "not found" }, 404);
        req.resume();
      }
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      json(req, res, { error: "method not allowed" }, 405);
      req.resume();
      return;
    }
    try {
      const file = STATIC_FILES[path];
      if (file)
        bytes(
          req,
          res,
          readFileSync(resolve(options.staticDir ?? STATIC, file[0])),
          file[1],
        );
      else if (path === "/brand/mark.svg") {
        const logo = state.config.logo;
        const type =
          logo && IMAGE_TYPES[logo.split(".").pop()?.toLowerCase() ?? ""];
        const target = logo && type && safeFile(state.repo, state.repo, logo);
        if (!target || !type) json(req, res, { error: "unknown logo" }, 404);
        else bytes(req, res, readFileSync(target), type);
      } else if (path === "/brand/custom.css") {
        const stylesheet = state.config.stylesheet;
        const target =
          stylesheet && safeFile(state.repo, state.repo, stylesheet);
        if (!target) json(req, res, { error: "unknown stylesheet" }, 404);
        else bytes(req, res, readFileSync(target), "text/css; charset=utf-8");
      } else if (path === "/api/board") {
        const snapshot = state.snapshot();
        json(
          req,
          res,
          snapshot ?? { error: state.error || "starting" },
          snapshot ? 200 : 503,
        );
      } else if (path === "/api/wp") {
        const found =
          state.board &&
          detail(
            state.repo,
            state.board,
            url.searchParams.get("key") ?? "",
            state.config,
          );
        json(
          req,
          res,
          found ?? { error: "unknown work package" },
          found ? 200 : 404,
        );
      } else if (path === "/api/doc") {
        const name = url.searchParams.get("file") ?? "";
        const target =
          DOC_NAME.test(name) &&
          safeFile(
            state.repo,
            dirname(resolve(state.repo, state.config.tracker)),
            name,
          );
        if (!target) json(req, res, { error: "unknown document" }, 404);
        else {
          const markdown = readFileSync(target, "utf8");
          const h1 = parseSpec(markdown).h1;
          json(req, res, { file: name, h1, markdown });
        }
      } else if (path === "/api/notes") {
        const wp = url.searchParams.get("wp");
        const raw = url.searchParams.get("limit") ?? "50";
        const limit = /^-?\d+$/.test(raw) ? Math.max(0, Number(raw)) : 50;
        const checkouts = worktrees(state.repo).map((tree) => tree.path);
        let notes = readAll(state.repo, checkouts, state.config)
          .filter((note) => !wp || note.wp === wp)
          .reverse();
        if (limit) notes = notes.slice(0, limit);
        json(req, res, { notes });
      } else if (path === "/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Content-Type-Options": "nosniff",
        });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        res.write(
          `retry: 2000\n\nevent: version\ndata: ${state.version}@${state.started}\n\n`,
        );
        clients.add(res);
        res.on("close", () => clients.delete(res));
      } else json(req, res, { error: "not found" }, 404);
    } catch (error) {
      json(
        req,
        res,
        {
          error:
            error instanceof Error ? error.message : "Could not read the board",
        },
        500,
      );
    }
  }) as BoardServer;
  server.state = state;
  server.rebuild = () => {
    state.rebuild();
    broadcast();
  };
  server.poll = () => {
    if (state.poll()) broadcast();
  };
  const pollTimer = setInterval(
    server.poll,
    Math.max(10, options.pollInterval ?? 1000),
  );
  const heartbeat = setInterval(
    () => {
      for (const client of clients) client.write(": ping\n\n");
    },
    Math.max(10, options.heartbeatInterval ?? 15000),
  );
  pollTimer.unref();
  heartbeat.unref();
  const close = server.close.bind(server);
  server.close = (callback?: (error?: Error) => void) => {
    clearInterval(pollTimer);
    clearInterval(heartbeat);
    for (const client of clients) client.end();
    clients.clear();
    return close(callback);
  };
  return server;
}
