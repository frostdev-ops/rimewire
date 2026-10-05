/** MCP session lease on the detached shared board. No project journals travel over HTTP. */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type DaemonRecord,
  ownerAlive,
  readRecord,
  stateDirectory,
  timing,
} from "./daemon.js";

export async function control(
  record: DaemonRecord,
  action: string,
  value?: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `http://127.0.0.1:${record.port}/_rimewire/${action}`,
    {
      method: value === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${record.token}`,
        ...(value === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(3000)])
        : AbortSignal.timeout(3000),
    },
  );
  if (!response.ok)
    throw new Error(`board ${action} failed (${response.status})`);
  return (await response.json()) as Record<string, unknown>;
}
async function alive(
  record: DaemonRecord,
  signal: AbortSignal,
): Promise<boolean> {
  if (!record.port || !ownerAlive(record)) return false;
  try {
    const health = await control(record, "health", undefined, signal);
    return health.pid === record.pid && health.version === 1;
  } catch {
    return false;
  }
}
async function ensureDaemon(
  directory: string,
  port: number,
  signal: AbortSignal,
): Promise<DaemonRecord> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 15000;
  let lastSpawn = 0;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const record = readRecord(directory);
    if (record && (await alive(record, signal))) return record;
    if (
      (!record || !ownerAlive(record) || !record.identity) &&
      Date.now() - lastSpawn > 1000
    ) {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("./cli.js", import.meta.url)),
          "serve",
          "--daemon",
          "--port",
          String(port),
        ],
        {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, RIMEWIRE_STATE_DIR: directory },
        },
      );
      await new Promise<void>((done, reject) => {
        child.once("error", reject);
        child.once("spawn", done);
      });
      child.unref();
      lastSpawn = Date.now();
    }
    await new Promise<void>((done) => setTimeout(done, 50));
  }
  throw new Error(
    "shared board did not become ready; inspect the Rimewire state directory or retry",
  );
}
export class SharedBoardSession {
  private readonly directory = stateDirectory();
  private readonly session = randomBytes(16).toString("hex");
  private record: DaemonRecord | undefined;
  private pending: Promise<string> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly startup = new AbortController();
  private readonly heartbeatMs = timing("RIMEWIRE_HEARTBEAT_MS", 5000);
  constructor(
    private readonly root: string,
    private readonly port = 8737,
  ) {}

  getUrl(): Promise<string> {
    if (this.stopped) return Promise.reject(new Error("session is closing"));
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const record = await ensureDaemon(
        this.directory,
        this.port,
        this.startup.signal,
      );
      const registered = await control(
        record,
        "register",
        {
          session: this.session,
          root: this.root,
        },
        this.startup.signal,
      );
      if (
        typeof registered.url !== "string" ||
        !registered.url.startsWith(`http://127.0.0.1:${record.port}/p/`)
      )
        throw new Error("invalid board URL");
      this.record = record;
      this.schedule();
      return registered.url;
    })()
      .catch((error: unknown) => {
        this.schedule();
        throw error;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  private schedule() {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.heartbeat();
    }, this.heartbeatMs);
  }
  private async heartbeat() {
    if (this.stopped) return;
    try {
      if (!this.record) throw new Error("no board");
      await control(this.record, "heartbeat", { session: this.session });
      this.schedule();
    } catch {
      this.record = undefined;
      if (this.stopped) return;
      try {
        await this.getUrl();
      } catch {
        this.schedule();
      }
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.startup.abort();
    if (this.timer) clearTimeout(this.timer);
    try {
      await this.pending;
    } catch {
      /* Failed startup has no lease to release. */
    }
    if (this.record) {
      try {
        await control(this.record, "release", { session: this.session });
      } catch {
        /* Expiration handles failed release. */
      }
    }
  }
}
