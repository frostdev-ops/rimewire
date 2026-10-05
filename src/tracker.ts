import { basename } from "node:path";
import type { StatusClass } from "./config.js";

export { CLASSES, type StatusClass } from "./config.js";

export const COUNTED = [
  "done",
  "active",
  "spec",
  "planned",
  "blocked",
] as const;
export interface StatusConfig {
  statuses?: Partial<Record<StatusClass, string[]>>;
}
export interface TrackerConfig extends StatusConfig {
  idPattern?: string;
}
export function isPackageId(
  id: string,
  config?: Pick<TrackerConfig, "idPattern">,
): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(id)) return false;
  return (
    !config?.idPattern ||
    new RegExp(`^(?:${config.idPattern})$`).exec(id)?.[0] === id
  );
}

export interface Item {
  key: string;
  id: string;
  title: string;
  status: string;
  cls: StatusClass;
  lane: string;
  group: string;
  id_note: string;
  status_short: string;
  status_note: string;
  os: string;
  depends: string;
  branch: string;
  file: string;
  file_exists: boolean;
  fields: [string, string][];
  tags: string[];
  h1: string;
  has_report: boolean;
  mtime: number | null;
  worktree: { name: string; branch: string; head: string } | null;
  in_flight: boolean;
  tracked: boolean;
  arrived_at: number | null;
  arrived?: boolean;
  changed_at: number | null;
  previous_cls: string;
  agent: AgentSummary | null;
}

export interface AgentSummary {
  count: number;
  percent: number | null;
  step: string;
  blocker: { text: string; author: string; time: number } | null;
  ready: { text: string; author: string; time: number } | null;
  last: {
    kind: string;
    text: string;
    author: string;
    time: number;
    percent: number | null;
  } | null;
  authors: string[];
}

export interface Lane {
  id: string;
  title: string;
  subtitle: string;
  notes: string[];
  items: Item[];
}

export interface Readme {
  lanes: Lane[];
  owner_actions: { done: boolean; text: string }[];
  links: Set<string>;
}

export interface Spec {
  h1: string;
  why: string;
  meta: [string, string][];
  report_title: string;
  report: string;
  status: string;
  has_report: boolean;
}

export function newItem(
  values: Pick<Item, "key" | "id" | "title" | "status" | "cls" | "lane"> &
    Partial<Item>,
): Item {
  return {
    group: "",
    id_note: "",
    status_short: "",
    status_note: "",
    os: "",
    depends: "",
    branch: "",
    file: "",
    file_exists: false,
    fields: [],
    tags: [],
    h1: "",
    has_report: false,
    mtime: null,
    worktree: null,
    in_flight: false,
    tracked: true,
    arrived_at: null,
    changed_at: null,
    previous_cls: "",
    agent: null,
    ...values,
  };
}

const LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;
// Match Python's str.splitlines, including documents written with CR-only line endings.
export function linesOf(text: string): string[] {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Python str.splitlines recognizes these Unicode line separators.
  const lines = text.split(/\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function plain(text: string): string {
  return text
    .replace(LINK, "$1")
    .replaceAll("**", "")
    .replaceAll("`", "")
    .trim();
}

const STATUS_DEFAULTS: Record<StatusClass, string[]> = {
  blocked: ["^blocked"],
  aside: ["^(split|superseded|cut|\\(superseded)"],
  done: [
    "^(merged|frozen|design landed|done|landed)",
    "(?<![\\p{L}\\p{N}_])done(?![\\p{L}\\p{N}_])",
  ],
  active: ["^(delegated|in review|in progress|review|implementing)"],
  spec: ["^spec"],
  planned: [],
};

export function classify(status: string, config?: StatusConfig): StatusClass {
  const text = plain(status).toLowerCase();
  for (const cls of [
    "blocked",
    "aside",
    "done",
    "active",
    "spec",
    "planned",
  ] as const) {
    const patterns = config?.statuses?.[cls] ?? STATUS_DEFAULTS[cls];
    if (patterns.some((pattern) => new RegExp(pattern, "iu").test(text)))
      return cls;
  }
  return "planned";
}

export function shortStatus(status: string): [string, string] {
  const text = plain(status);
  const match = /^([^(;]*?)\s*[(;]\s*(.*?)\)?\s*$/.exec(text);
  return match?.[1] ? [match[1].trim(), match[2].trim()] : [text, ""];
}

export function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let buffer = "";
  let inCode = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\\" && text[i + 1] === "|") {
      buffer += "|";
      i++;
      continue;
    }
    if (char === "`") inCode = !inCode;
    if (char === "|" && !inCode) {
      cells.push(buffer.trim());
      buffer = "";
    } else buffer += char;
  }
  cells.push(buffer.trim());
  return cells;
}

export function isSeparator(line: string): boolean {
  if (!line.trim().startsWith("|")) return false;
  const cells = splitRow(line);
  return (
    cells.length > 0 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell.replaceAll(" ", "")))
  );
}

export function empty(cell: string): boolean {
  return ["", "—", "-", "–"].includes(plain(cell));
}

export function slug(text: string): string {
  return (
    plain(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "lane"
  );
}

export function splitHeading(text: string): [string, string] {
  text = plain(text);
  const dated = /\s*\(([^()]*\d{4}-\d{2}-\d{2}[^()]*)\)/.exec(text);
  if (dated)
    return [
      (
        text.slice(0, dated.index) + text.slice(dated.index + dated[0].length)
      ).replace(/^[ ,]+|[ ,]+$/g, ""),
      dated[1].trim(),
    ];
  const started = /,\s*(started\s+\d{4}-\d{2}-\d{2})\s*$/.exec(text);
  if (started)
    return [
      text.slice(0, started.index).replace(/^[ ,]+|[ ,]+$/g, ""),
      started[1],
    ];
  return [text, ""];
}

export function rowItem(
  header: string[],
  cells: string[],
  lane: Lane,
  group: string,
  seenIds: Map<string, number>,
  config?: TrackerConfig,
): Item | null {
  if (!cells.length || empty(cells[0])) return null;
  const first = cells[0].trim();
  const link = /^\[([^\]]+)\]\(([^)\s]+)\)\s*(.*)$/.exec(first);
  let id: string,
    rest: string,
    file = "";
  if (link) {
    id = plain(link[1]);
    rest = link[3].trim();
    if (link[2].endsWith(".md") && !link[2].includes("/"))
      file = basename(link[2]);
  } else {
    const parts = /^(\S+)(?:\s+(.*))?$/s.exec(plain(first));
    if (!parts) return null;
    id = parts[1];
    rest = parts[2] ?? "";
  }
  if (!isPackageId(id, config)) return null;
  const columns = new Map<string, string>();
  const fields: [string, string][] = [];
  for (let i = 1; i < header.length; i++) {
    const name = header[i],
      cell = cells[i] ?? "";
    if (
      ["status", "title", "scope", "os", "depends on", "branch"].includes(name)
    )
      columns.set(name, cell);
    else if (!empty(cell)) fields.push([name, cell]);
  }
  const status = (columns.get("status") ?? "").trim();
  let title = columns.get("title") || columns.get("scope") || "";
  let idNote = "";
  if (title) idNote = plain(rest).replace(/^[() ]+|[() ]+$/g, "");
  else title = rest;
  const count = (seenIds.get(id) ?? 0) + 1;
  seenIds.set(id, count);
  const [statusShort, statusNote] = shortStatus(status);
  const haystack = `${title} ${status} ${idNote}`.toLowerCase();
  const tags: string[] = [];
  if (
    haystack.includes("(lead") ||
    haystack.includes("lead only") ||
    idNote === "lead"
  )
    tags.push("lead");
  if (haystack.includes("owner-attended")) tags.push("owner-attended");
  const branch = plain(columns.get("branch") ?? "");
  return newItem({
    key: count === 1 ? id : `${id}~${count}`,
    id,
    title: title.trim(),
    status,
    cls: classify(status, config),
    lane: lane.id,
    group,
    id_note: idNote,
    status_short: statusShort,
    status_note: statusNote,
    os: empty(columns.get("os") ?? "") ? "" : plain(columns.get("os") ?? ""),
    depends: empty(columns.get("depends on") ?? "")
      ? ""
      : (columns.get("depends on") ?? "").trim(),
    branch: empty(branch) ? "" : branch,
    file,
    fields,
    tags,
  });
}

export function parseReadme(text: string, config?: TrackerConfig): Readme {
  const lines = linesOf(text);
  const lanes: Lane[] = [];
  const ownerActions: Readme["owner_actions"] = [];
  const links = new Set(
    [...text.matchAll(LINK)]
      .filter((m) => m[2].endsWith(".md"))
      .map((m) => basename(m[2])),
  );
  let lane: Lane | undefined,
    group = "",
    i = 0;
  const seenIds = new Map<string, number>();
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("## ")) {
      const [title, subtitle] = splitHeading(line.slice(3));
      lane = { id: slug(title), title, subtitle, notes: [], items: [] };
      lanes.push(lane);
      group = "";
      i++;
      continue;
    }
    if (line.startsWith("### ")) {
      group = plain(line.slice(4));
      i++;
      continue;
    }
    if (
      line.trim().startsWith("|") &&
      i + 1 < lines.length &&
      isSeparator(lines[i + 1])
    ) {
      const header = splitRow(line).map((c) => plain(c).toLowerCase());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|"))
        rows.push(splitRow(lines[i++]));
      if (lane && header.includes("status")) {
        for (const cells of rows) {
          const item = rowItem(header, cells, lane, group, seenIds, config);
          if (item) lane.items.push(item);
        }
      }
      continue;
    }
    const check = /^\s*- \[([ xX])\]\s+(.*)$/.exec(line);
    if (check) {
      const body = [check[2]];
      i++;
      while (i < lines.length && lines[i].startsWith("  ") && lines[i].trim())
        body.push(lines[i++].trim());
      ownerActions.push({ done: check[1] !== " ", text: body.join(" ") });
      continue;
    }
    if (line.trim() && lane && !/^\s*([-*+]\s|\d+\.\s|\||#)/.test(line)) {
      const para = [line.trim()];
      i++;
      while (i < lines.length && lines[i].trim() && !/^[#|]/.test(lines[i]))
        para.push(lines[i++].trim());
      if (lane.notes.length < 3) lane.notes.push(para.join(" "));
      continue;
    }
    i++;
  }
  return {
    lanes: lanes.filter((ln) => ln.items.length),
    owner_actions: ownerActions,
    links,
  };
}

export function paragraphs(lines: string[]): string[] {
  const out: string[] = [],
    buffer: string[] = [];
  for (const line of lines) {
    if (line.trim()) buffer.push(line.trim());
    else if (buffer.length) {
      out.push(buffer.join(" "));
      buffer.length = 0;
    }
  }
  if (buffer.length) out.push(buffer.join(" "));
  return out;
}

export function parseSpec(text: string): Spec {
  const spec: Spec = {
    h1: "",
    why: "",
    meta: [],
    report_title: "",
    report: "",
    status: "",
    has_report: false,
  };
  const sections: [string, string[]][] = [["", []]];
  let inFence = false;
  for (const line of linesOf(text)) {
    if (line.startsWith("```")) inFence = !inFence;
    if (!inFence && line.startsWith("# ") && !spec.h1) {
      spec.h1 = line.slice(2).trim();
      continue;
    }
    if (
      !inFence &&
      !spec.h1 &&
      sections.length === 1 &&
      /^#{3,6} /.test(line)
    ) {
      spec.h1 = line.replace(/^#+/, "").trim();
      continue;
    }
    if (!inFence && line.startsWith("## ")) {
      sections.push([line.slice(3).trim(), []]);
      continue;
    }
    sections[sections.length - 1][1].push(line);
  }
  const preamble = sections[0][1];
  for (const line of preamble) {
    const match = /^- \*\*([^*]+?):?\*\*:?\s*(.*)$/.exec(line);
    if (match)
      spec.meta.push([match[1].replace(/:+$/, "").trim(), match[2].trim()]);
    else if (line.startsWith("  ") && spec.meta.length && line.trim())
      spec.meta[spec.meta.length - 1][1] += ` ${line.trim()}`;
  }
  const status =
    /\*\*Status:?\*\*:?\s*([^\n*]+)|\*\*Status:\s*([^*]+)\*\*/.exec(
      preamble.join("\n"),
    );
  if (status)
    spec.status = (status[1] || status[2] || "").replace(/^[ .]+|[ .]+$/g, "");
  for (const [name, value] of spec.meta) {
    if (name.toLowerCase() === "status" && !spec.status)
      spec.status = plain(value);
    if (["goal", "why"].includes(name.toLowerCase()) && !spec.why)
      spec.why = value;
  }
  const paras = paragraphs(preamble).filter(
    (p) => !/^(?:-|\||```|\* {3})/.test(p),
  );
  for (const para of paras) {
    if (spec.why) break;
    if (/^\*\*(Why|Goal)[.:]?\*\*/.test(para)) {
      spec.why = para;
      break;
    }
  }
  if (!spec.why) {
    for (const [name, body] of sections.slice(1)) {
      if (/^(why|goal)\b/.test(name.toLowerCase())) {
        const found = paragraphs(body).filter((p) => !/^(?:\||```)/.test(p));
        if (found.length) {
          spec.why = found[0];
          break;
        }
      }
    }
  }
  if (!spec.why && paras.length)
    spec.why = paras[0].replace(/^\*\*Status:[^*]*\*\*\s*/, "");
  for (const [name, body] of sections.slice(1)) {
    if (name.toLowerCase().startsWith("report")) {
      spec.report_title = name;
      spec.report = paragraphs(body).slice(0, 2).join("\n\n");
    }
  }
  spec.has_report = Boolean(spec.report_title);
  return spec;
}

export type Totals = Record<
  StatusClass | "items" | "counted" | "percent",
  number
>;
export function totals(items: Pick<Item, "cls">[]): Totals {
  const result: Totals = {
    done: 0,
    active: 0,
    spec: 0,
    planned: 0,
    blocked: 0,
    aside: 0,
    items: items.length,
    counted: 0,
    percent: 0,
  };
  for (const item of items) result[item.cls]++;
  result.counted = COUNTED.reduce((sum, cls) => sum + result[cls], 0);
  if (result.counted) {
    const percent = (100 * result.done) / result.counted;
    // Python rounds exact halfway values to even. At one decimal the binary-exact
    // halfway fractions are .25 and .75; toFixed handles the other binary values.
    const quarters = percent * 4;
    if (Number.isInteger(quarters) && quarters % 2 === 1) {
      const lower = Math.floor(percent * 10);
      result.percent = (lower + (lower % 2)) / 10;
    } else result.percent = Number(percent.toFixed(1));
  }
  return result;
}
