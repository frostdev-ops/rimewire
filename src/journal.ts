/** Append-only, checkout-local agent updates, merged by time for the board. */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { Config } from "./config.js";

export const KINDS = [
  "note",
  "progress",
  "blocker",
  "unblock",
  "ready",
] as const;
export const MAX_TEXT = 4000;
export const MAX_AUTHOR = 64;
export const MAX_ID = 48;
export const JOURNAL_DIR = ".rimewire/journal";
export const JOURNAL_NAME = "notes.jsonl";
export const WP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;

export type Kind = (typeof KINDS)[number];
export type Source = "legacy" | "cli" | "mcp" | "web" | `hook:${string}`;
export type JournalConfig = Pick<Config, "journalDir" | "idPattern">;

export interface Note {
  id: string;
  wp: string;
  kind: Kind;
  text: string;
  percent: number | null;
  author: string;
  time: number;
  source: Source;
}

export interface JournalEntry extends Note {
  checkout: string;
}

type Handoff = Pick<Note, "text" | "author" | "time">;
export interface Summary {
  count: number;
  percent: number | null;
  step: string;
  blocker: Handoff | null;
  ready: Handoff | null;
  last: Pick<Note, "kind" | "text" | "author" | "time" | "percent"> | null;
  authors: string[];
}

function isKind(kind: unknown): kind is Kind {
  return KINDS.some((value) => value === kind);
}

function isSource(source: unknown): source is Exclude<Source, "legacy"> {
  return (
    source === "cli" ||
    source === "mcp" ||
    source === "web" ||
    (typeof source === "string" &&
      /^hook:[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(source))
  );
}

function validId(wp: unknown, config?: JournalConfig): wp is string {
  if (
    typeof wp !== "string" ||
    wp.length > MAX_ID ||
    WP_ID.exec(wp)?.[0] !== wp
  )
    return false;
  const pattern = new RegExp(
    `^(?:${config?.idPattern ?? "[A-Za-z][A-Za-z0-9._-]*"})$`,
  );
  return pattern.exec(wp)?.[0] === wp;
}

function validPercent(percent: unknown): percent is number {
  return (
    typeof percent === "number" &&
    Number.isInteger(percent) &&
    percent >= 0 &&
    percent <= 100
  );
}

function truncate(text: string, length: number): string {
  return Array.from(text).slice(0, length).join("");
}

function validate(
  wp: string,
  kind: string,
  text: string,
  percent: number | null,
  author: string,
  source: string,
  config?: JournalConfig,
): Omit<Note, "id" | "time"> {
  wp = (wp || "").trim();
  if (!validId(wp, config)) {
    throw new Error(`not a work-package id: ${JSON.stringify(wp)}`);
  }
  if (!isKind(kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
  text = (text || "").trim();
  if (!text && (kind === "note" || kind === "blocker")) {
    throw new Error(`a ${kind} needs text`);
  }
  if (Array.from(text).length > MAX_TEXT) {
    throw new Error(`text is longer than ${MAX_TEXT} characters`);
  }
  if (percent !== null) {
    if (!validPercent(percent)) {
      throw new Error("percent must be a whole number from 0 to 100");
    }
    if (kind !== "progress" && kind !== "ready") {
      throw new Error("only progress and ready updates carry a percent");
    }
  }
  source = (source || "").trim();
  if (!isSource(source))
    throw new Error("source must be cli, mcp, web, or hook:<event>");
  if (kind === "ready" && source.startsWith("hook:")) {
    throw new Error("hooks cannot mark a work package ready");
  }
  author = truncate((author || "").trim(), MAX_AUTHOR) || "agent";
  return { wp, kind, text, percent, author, source };
}

/** A validated update. Errors are intended to be shown directly to the caller. */
export function make(
  wp: string,
  kind: string,
  text: string,
  percent: number | null = null,
  author = "",
  source = "cli",
  config?: JournalConfig,
): Note {
  const fields = validate(wp, kind, text, percent, author, source, config);
  return {
    id: randomBytes(8).toString("hex"),
    ...fields,
    time: Date.now() / 1000,
  };
}

export function journalPath(checkout: string, config?: JournalConfig): string {
  return join(checkout, config?.journalDir ?? JOURNAL_DIR, JOURNAL_NAME);
}

function assertContained(root: string, path: string): void {
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("journal path must stay inside its checkout");
  }
}

/** Check existing ancestors before mkdir so a symlink cannot create directories outside. */
function checkJournalLocation(checkout: string, path: string): void {
  assertContained(resolve(checkout), resolve(path));
  const root = realpathSync(checkout);
  let ancestor = resolve(path);
  while (true) {
    try {
      lstatSync(ancestor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      ancestor = dirname(ancestor);
      continue;
    }
    assertContained(root, realpathSync(ancestor));
    return;
  }
}

/**
 * One O_APPEND write keeps records intact on local filesystems with atomic append.
 * Legacy Python writers also issue one O_APPEND write. We do not acquire their flock;
 * network filesystems that emulate append, or other writers that split records, are unsupported.
 */
export function append(
  checkout: string,
  note: Note,
  config?: JournalConfig,
): string {
  const fields = validate(
    note.wp,
    note.kind,
    note.text,
    note.percent,
    note.author,
    note.source ?? "cli",
    config,
  );
  if (typeof note.id !== "string" || !note.id)
    throw new Error("an update needs an id");
  if (typeof note.time !== "number" || !Number.isFinite(note.time)) {
    throw new Error("time must be a finite number");
  }
  const line = Buffer.from(
    `${JSON.stringify({ ...note, ...fields })}\n`,
    "utf8",
  );
  const path = journalPath(checkout, config);
  checkJournalLocation(checkout, path);
  mkdirSync(dirname(path), { recursive: true });
  checkJournalLocation(checkout, path);
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      (constants.O_NOFOLLOW ?? 0),
    0o644,
  );
  try {
    // Do not use writeFileSync: it can split a record across multiple writes.
    if (writeSync(fd, line) !== line.length)
      throw new Error("short write to the journal");
  } finally {
    closeSync(fd);
  }
  return path;
}

/** Normalize legacy entries without confusing checkout labels with update provenance. */
export function clean(
  raw: unknown,
  checkout: string,
  config?: JournalConfig,
): JournalEntry | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return null;
  const entry = raw as Record<string, unknown>;
  const { wp, time } = entry;
  if (
    !validId(wp, config) ||
    typeof time !== "number" ||
    !Number.isFinite(time)
  ) {
    return null;
  }
  const kind = isKind(entry.kind) ? entry.kind : "note";
  // Older journals have no source; older exported feeds used source for the checkout.
  const source = isSource(entry.source) ? entry.source : "legacy";
  if (
    kind === "ready" &&
    typeof entry.source === "string" &&
    entry.source.startsWith("hook:")
  )
    return null;
  return {
    id:
      typeof entry.id === "string" && entry.id
        ? entry.id
        : `${checkout}:${time}:${wp}`,
    wp,
    kind,
    text: truncate(String(entry.text || ""), MAX_TEXT),
    percent: validPercent(entry.percent) ? entry.percent : null,
    author: truncate(String(entry.author || "agent"), MAX_AUTHOR),
    time,
    source,
    checkout,
  };
}

/** Every usable line; malformed JSON, invalid UTF-8, and half-written lines are skipped. */
export function readJournal(
  path: string,
  checkout: string,
  config?: JournalConfig,
): JournalEntry[] {
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch {
    return [];
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const out: JournalEntry[] = [];
  let start = 0;
  for (let end = 0; end <= data.length; end++) {
    if (end < data.length && data[end] !== 10 && data[end] !== 13) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(decoder.decode(data.subarray(start, end)));
    } catch {
      start = end + 1;
      continue;
    }
    const note = clean(raw, checkout, config);
    if (note !== null) out.push(note);
    start = end + 1;
  }
  return out;
}

/** Journals in the main repo, supplied worktrees, and .worktrees/*; real paths once. */
export function journals(
  repo: string,
  checkouts: readonly string[] = [],
  config?: JournalConfig,
): [checkout: string, path: string][] {
  const found = new Map<string, string>();
  const add = (root: string, checkout: string) => {
    const path = journalPath(root, config);
    try {
      if (!statSync(path).isFile()) return;
      const real = realpathSync(path);
      if (!found.has(real)) found.set(real, checkout);
    } catch {
      // Missing, inaccessible, or concurrently removed worktrees are normal.
    }
  };
  add(repo, "main");
  const roots = [...checkouts];
  const worktrees = join(repo, ".worktrees");
  try {
    for (const name of readdirSync(worktrees)) {
      const root = join(worktrees, name);
      try {
        if (statSync(root).isDirectory()) roots.push(root);
      } catch {
        // A worktree can disappear while the board is reading it.
      }
    }
  } catch {
    // Repositories without a .worktrees directory still have their main journal.
  }
  for (const root of roots) add(root, basename(resolve(root)));
  return Array.from(found, ([path, checkout]) => [checkout, path]);
}

/** All checkout journals, oldest first, each id once (the main copy wins duplicates). */
export function readAll(
  repo: string,
  checkouts: readonly string[] = [],
  config?: JournalConfig,
): JournalEntry[] {
  const seen = new Map<string, JournalEntry>();
  for (const [checkout, path] of journals(repo, checkouts, config)) {
    for (const note of readJournal(path, checkout, config)) {
      if (!seen.has(note.id)) seen.set(note.id, note);
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.time - b.time);
}

/** Notes must be oldest first. Blockers survive until unblock/ready; progress reopens ready. */
export function summarize(notes: readonly Note[]): Record<string, Summary> {
  const out: Record<string, Summary> = Object.create(null);
  for (const note of notes) {
    if (note.kind === "ready" && note.source?.startsWith("hook:")) continue;
    let summary = out[note.wp];
    if (!summary) {
      summary = {
        count: 0,
        percent: null,
        step: "",
        blocker: null,
        ready: null,
        last: null,
        authors: [],
      };
      out[note.wp] = summary;
    }
    summary.count++;
    const { kind, text, author, time, percent } = note;
    summary.last = { kind, text, author, time, percent };
    if (!summary.authors.includes(author)) summary.authors.push(author);
    if (kind === "progress") {
      if (percent !== null) summary.percent = percent;
      if (text) summary.step = text;
      summary.ready = null;
    } else if (kind === "blocker") {
      summary.blocker = { text, author, time };
      summary.ready = null;
    } else if (kind === "unblock") {
      summary.blocker = null;
    } else if (kind === "ready") {
      summary.ready = { text, author, time };
      summary.blocker = null;
      summary.percent = percent ?? 100;
    }
  }
  return out;
}

/** Journal size and nanosecond mtime for the board's change signature. */
export function signatureParts(
  repo: string,
  config?: JournalConfig,
): [name: string, mtime: number, size: number][] {
  const parts: [string, number, number][] = [];
  for (const [checkout, path] of journals(repo, [], config)) {
    try {
      const stat = statSync(path);
      parts.push([`journal:${checkout}`, stat.mtimeMs * 1_000_000, stat.size]);
    } catch {
      // A checkout can be removed between discovery and stat.
    }
  }
  return parts;
}
