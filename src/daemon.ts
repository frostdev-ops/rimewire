/** Shared loopback board process. Its exclusive lock is also its discovery record. */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mainRepository } from "./gitinfo.js";
import { type BoardServer, createBoardServer } from "./server.js";

export interface DaemonRecord {
  version: 1;
  pid: number;
  port: number;
  token: string;
  identity?: string;
}
export interface Project {
  id: string;
  name: string;
  root: string;
  url: string;
}
export function stateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RIMEWIRE_STATE_DIR) return resolve(env.RIMEWIRE_STATE_DIR);
  const base =
    env.XDG_STATE_HOME ||
    (process.platform === "win32"
      ? env.LOCALAPPDATA || join(homedir(), "AppData/Local")
      : process.platform === "darwin"
        ? join(homedir(), "Library/Application Support")
        : join(homedir(), ".local/state"));
  return join(base, "rimewire");
}
export function readRecord(directory: string): DaemonRecord | null {
  try {
    const value = JSON.parse(
      readFileSync(join(directory, "daemon.json"), "utf8"),
    );
    if (
      value.version !== 1 ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      !Number.isInteger(value.port) ||
      value.port < 0 ||
      value.port > 65535 ||
      typeof value.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.token) ||
      (value.identity !== undefined && typeof value.identity !== "string")
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
        if (state === "Z" || state === "X") return false;
      } catch {
        /* Inaccessible process metadata does not establish death. */
      }
    }
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
export function timing(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 20)
    throw new Error(`${name} must be an integer of at least 20 milliseconds`);
  return value;
}
/** OS process start identity prevents a recycled PID from owning an old lock. */
export function processIdentity(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z" || fields[0] === "X") return undefined;
      return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${fields[19]}`;
    }
    if (process.platform === "win32")
      return (
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
          ],
          {
            encoding: "utf8",
            timeout: 3000,
            stdio: ["ignore", "pipe", "ignore"],
          },
        ).trim() || undefined
      );
    return (
      execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        timeout: 3000,
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}
export function ownerAlive(
  owner: Pick<DaemonRecord, "pid" | "identity">,
): boolean {
  if (!processAlive(owner.pid)) return false;
  if (!owner.identity) return true;
  const identity = processIdentity(owner.pid);
  // A metadata lookup failure must not evict a live owner.
  return identity === undefined || identity === owner.identity;
}
async function oldOwnerAlive(
  record: DaemonRecord,
  lock: string,
): Promise<boolean> {
  if (!ownerAlive(record)) return false;
  if (record.identity) return true;
  if (!record.port) return Date.now() - statSync(lock).mtimeMs < 30000;
  // Older discovery records had no process identity; verify their authenticated service.
  try {
    const response = await fetch(
      `http://127.0.0.1:${record.port}/_rimewire/health`,
      {
        headers: { Authorization: `Bearer ${record.token}` },
        signal: AbortSignal.timeout(3000),
      },
    );
    const health = (await response.json()) as Record<string, unknown>;
    return response.ok && health.pid === record.pid && health.version === 1;
  } catch {
    return false;
  }
}
async function acquire(
  directory: string,
  record: DaemonRecord,
): Promise<boolean> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, "daemon.json");
  const claims = join(directory, "startup");
  mkdirSync(claims, { recursive: true, mode: 0o700 });
  // A filesystem bakery election: unique claim paths are never reused, so cleanup
  // cannot unlink a replacement owner's guard. Ticket 0 announces ticket selection.
  const path = join(claims, `${record.token}.json`);
  const claim = {
    pid: record.pid,
    identity: record.identity,
    token: record.token,
    ticket: 0,
  };
  const publish = () => {
    const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify(claim), { mode: 0o600 });
    renameSync(temp, path);
  };
  const readClaims = () => {
    const live: (typeof claim)[] = [];
    for (const name of readdirSync(claims)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const file = join(claims, name);
      try {
        const other = JSON.parse(readFileSync(file, "utf8")) as typeof claim;
        if (
          other.token !== name.slice(0, -5) ||
          !Number.isSafeInteger(other.ticket) ||
          other.ticket < 0 ||
          !Number.isInteger(other.pid) ||
          typeof other.identity !== "string" ||
          !other.identity
        )
          throw new Error("invalid startup claim");
        if (ownerAlive(other)) live.push(other);
        else unlinkSync(file);
      } catch {
        /* Concurrently removed claims are normal. */
      }
    }
    return live;
  };
  publish();
  try {
    claim.ticket =
      Math.max(0, ...readClaims().map((other) => other.ticket)) + 1;
    publish();
    const deadline = Date.now() + 15000;
    while (
      readClaims().some(
        (other) =>
          other.token !== claim.token &&
          (other.ticket === 0 ||
            other.ticket < claim.ticket ||
            (other.ticket === claim.ticket && other.token < claim.token)),
      )
    ) {
      if (Date.now() > deadline)
        throw new Error("shared board startup election timed out");
      await new Promise<void>((done) => setTimeout(done, 25));
    }
    const prior = readRecord(directory);
    if (prior && (await oldOwnerAlive(prior, lock))) return false;
    if (
      !prior &&
      existsSync(lock) &&
      Date.now() - statSync(lock).mtimeMs < 30000
    )
      return false;
    const temp = join(directory, `daemon.${record.token}.tmp`);
    writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
    renameSync(temp, lock);
    return true;
  } finally {
    try {
      unlinkSync(path);
    } catch {
      /* A dead owner's unique claim may already be gone. */
    }
  }
}
function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (
    req.headers.origin !== undefined ||
    req.headers["content-type"]?.split(";")[0] !== "application/json"
  )
    throw new Error("control requests require local JSON clients");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new Error("control body too large");
    chunks.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("body must be an object");
  return value as Record<string, unknown>;
}
export async function runDaemon(
  port = 8737,
  directory = stateDirectory(),
): Promise<void> {
  const idleMs = timing("RIMEWIRE_IDLE_MS", 30000);
  const leaseMs = timing("RIMEWIRE_LEASE_MS", 15000);
  const identity = processIdentity(process.pid);
  if (!identity)
    throw new Error(
      "cannot read process start identity; shared daemon was not started",
    );
  const record: DaemonRecord = {
    version: 1,
    pid: process.pid,
    port: 0,
    token: randomBytes(32).toString("hex"),
    identity,
  };
  if (!(await acquire(directory, record))) return;
  const projects = new Map<string, { project: Project; board: BoardServer }>();
  const sessions = new Map<string, { project: string; seen: number }>();
  let idleSince = Date.now();
  let stopping = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const registry = join(directory, "projects.json");
  function register(root: string): Project {
    root = realpathSync(mainRepository(realpathSync(root)));
    const id = createHash("sha256").update(root).digest("hex").slice(0, 16);
    const existing = projects.get(id);
    if (existing) return existing.project;
    const board = createBoardServer(root, { publicPort: () => record.port });
    const project = {
      id,
      root,
      name: board.state.config.name,
      url: `/p/${id}/`,
    };
    projects.set(id, { project, board });
    return project;
  }
  function persist() {
    const temp = `${registry}.${record.token}.tmp`;
    writeFileSync(
      temp,
      JSON.stringify([...projects.values()].map(({ project }) => project.root)),
      { mode: 0o600 },
    );
    renameSync(temp, registry);
  }
  try {
    if (existsSync(registry)) {
      const roots: unknown = JSON.parse(readFileSync(registry, "utf8"));
      if (Array.isArray(roots))
        for (const root of roots)
          if (typeof root === "string") {
            try {
              register(root);
            } catch {
              /* Removed or invalid projects do not prevent startup. */
            }
          }
    }
  } catch {
    /* A corrupt registry is rebuilt by session registration. */
  }
  const server = createServer((req, res) => {
    if (stopping) {
      json(res, { error: "daemon shutting down" }, 503);
      return;
    }
    if (
      ![`127.0.0.1:${record.port}`, `localhost:${record.port}`].includes(
        req.headers.host || "",
      )
    ) {
      json(res, { error: "invalid local host" }, 403);
      req.resume();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url || "/", "http://127.0.0.1");
    } catch {
      json(res, { error: "invalid URL" }, 400);
      req.resume();
      return;
    }
    if (url.pathname.startsWith("/_rimewire/")) {
      if (
        req.headers.authorization !== `Bearer ${record.token}` ||
        req.headers.origin !== undefined
      ) {
        json(res, { error: "unauthorized" }, 403);
        req.resume();
        return;
      }
      if (url.pathname === "/_rimewire/health" && req.method === "GET") {
        json(res, { pid: record.pid, version: 1 });
        return;
      }
      if (req.method !== "POST") {
        json(res, { error: "not found" }, 404);
        req.resume();
        return;
      }
      void (async () => {
        const value = await body(req);
        if (
          typeof value.session !== "string" ||
          !/^[a-f0-9]{32}$/.test(value.session)
        )
          throw new Error("invalid session");
        if (url.pathname === "/_rimewire/register") {
          if (typeof value.root !== "string")
            throw new Error("root must be a path");
          const project = register(value.root);
          sessions.set(value.session, {
            project: project.id,
            seen: Date.now(),
          });
          persist();
          json(res, {
            project: project.id,
            url: `http://127.0.0.1:${record.port}${project.url}`,
          });
        } else if (url.pathname === "/_rimewire/heartbeat") {
          const session = sessions.get(value.session);
          if (!session) {
            json(res, { error: "unknown session" }, 404);
            return;
          }
          session.seen = Date.now();
          json(res, { ok: true });
        } else if (url.pathname === "/_rimewire/release") {
          sessions.delete(value.session);
          if (!sessions.size) idleSince = Date.now();
          json(res, { ok: true });
        } else json(res, { error: "not found" }, 404);
      })().catch((error: unknown) => {
        if (!res.writableEnded)
          json(
            res,
            {
              error:
                error instanceof Error
                  ? error.message
                  : "invalid control request",
            },
            400,
          );
      });
      return;
    }
    if (
      url.pathname === "/api/projects" &&
      (req.method === "GET" || req.method === "HEAD")
    ) {
      json(res, {
        projects: [...projects.values()].map(({ project, board }) => ({
          ...project,
          name: board.state.config.name,
          sessions: [...sessions.values()].filter(
            (session) => session.project === project.id,
          ).length,
          totals: board.state.board?.totals ?? null,
        })),
      });
      return;
    }
    if (
      url.pathname === "/" &&
      (req.method === "GET" || req.method === "HEAD")
    ) {
      const first = projects.values().next().value;
      if (first) {
        res.writeHead(302, { Location: first.project.url });
        res.end();
      } else
        json(res, { projects: [], message: "Waiting for a Rimewire session" });
      return;
    }
    const match = /^\/p\/([a-f0-9]{16})(\/.*)?$/.exec(url.pathname);
    const mounted = match?.[1] && projects.get(match[1]);
    if (!mounted) {
      json(res, { error: "unknown project" }, 404);
      req.resume();
      return;
    }
    if (!match?.[2]) {
      res.writeHead(308, { Location: `${mounted.project.url}${url.search}` });
      res.end();
      return;
    }
    req.url = `${match[2]}${url.search}`;
    mounted.board.emit("request", req, res);
  });
  await new Promise<void>((done, reject) => {
    const stop = () => {
      if (stopping) return;
      stopping = true;
      if (timer) clearInterval(timer);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      for (const { board } of projects.values()) board.close();
      server.close(() => {
        if (readRecord(directory)?.token === record.token) {
          try {
            unlinkSync(join(directory, "daemon.json"));
          } catch {
            /* Already removed. */
          }
        }
        done();
      });
      server.closeAllConnections();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    void (async () => {
      for (
        let candidate = port;
        candidate <= Math.min(65535, port + 20);
        candidate++
      ) {
        if (stopping) return;
        try {
          await new Promise<void>((started, failed) => {
            server.once("error", failed);
            server.listen(candidate, "127.0.0.1", () => {
              server.off("error", failed);
              started();
            });
          });
          break;
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== "EADDRINUSE" ||
            candidate === Math.min(65535, port + 20)
          )
            throw error;
        }
      }
      if (stopping) return;
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("daemon address unavailable");
      record.port = address.port;
      const temp = join(directory, `daemon.${record.token}.tmp`);
      writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
      renameSync(temp, join(directory, "daemon.json"));
      idleSince = Date.now();
      timer = setInterval(
        () => {
          const now = Date.now();
          const hadSessions = sessions.size > 0;
          for (const [id, session] of sessions)
            if (now - session.seen >= leaseMs) sessions.delete(id);
          if (hadSessions && !sessions.size) idleSince = now;
          if (sessions.size) idleSince = now;
          else if (now - idleSince >= idleMs) stop();
        },
        Math.max(20, Math.min(1000, idleMs / 4, leaseMs / 4)),
      );
    })().catch((error: unknown) => {
      stop();
      reject(error);
    });
  });
}
