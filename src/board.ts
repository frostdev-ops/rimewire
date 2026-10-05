/** Read-only tracker snapshots, specs, Git state, and checkout-local agent updates. */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { type Config, loadConfig } from "./config.js";
import {
  branchDetail,
  type Commit,
  commits,
  type GitDetail,
  gitDirectories,
  matchWorktree,
  type Worktree,
  worktrees,
} from "./gitinfo.js";
import { type JournalEntry, journals, readAll, summarize } from "./journal.js";
import {
  classify,
  empty,
  type Item,
  isPackageId,
  type Lane,
  newItem,
  parseReadme,
  parseSpec,
  plain,
  type Spec,
  shortStatus,
  type Totals,
  totals,
} from "./tracker.js";

export type {
  Item,
  Lane,
  Readme,
  Spec,
  StatusClass,
  Totals,
} from "./tracker.js";
export {
  CLASSES,
  COUNTED,
  classify,
  empty,
  isSeparator,
  parseReadme,
  parseSpec,
  plain,
  shortStatus,
  slug,
  splitHeading,
  splitRow,
  totals,
} from "./tracker.js";

export type NextRow = Pick<
  Item,
  "key" | "id" | "title" | "cls" | "status_short"
>;
export type MilestoneState = "done" | "active" | "next" | "later";
export interface Roadmap {
  platforms: {
    id: string;
    label: string;
    totals: Totals;
    few: boolean;
    unlabelled: number;
    note: string;
    next: NextRow[];
  }[];
  workstreams: { id: string; title: string; totals: Totals; next: NextRow[] }[];
  milestones: {
    id: string;
    kind: string;
    title: string;
    state: MilestoneState;
    derived: boolean;
    lane: string;
    totals: Totals | null;
    note: string;
    doc: string;
    next: NextRow[];
  }[];
}

export interface Snapshot {
  generated: number;
  readme_mtime: number;
  totals: Totals;
  lanes: (Lane & { totals: Totals })[];
  roadmap: Roadmap;
  untracked: Item[];
  owner_actions: { done: boolean; text: string }[];
  docs: string[];
  recent: Pick<Item, "key" | "id" | "mtime" | "file">[];
  commits: Commit[];
  activity: JournalEntry[];
  activity_total: number;
}
export type Board = Snapshot;
export interface Detail {
  item: Item;
  spec: Spec | null;
  markdown: string;
  source: string;
  git: GitDetail | null;
  updates: JournalEntry[];
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Specs are local siblings of the tracker; symlinks must resolve inside that directory. */
export function safeSpecPath(
  directory: string,
  file: string,
  checkout?: string,
): string | null {
  if (!file || basename(file) !== file || file.includes("\\")) return null;
  try {
    const root = realpathSync(directory);
    const path = realpathSync(join(directory, file));
    const project = checkout ? realpathSync(checkout) : root;
    return inside(project, root) &&
      inside(root, path) &&
      statSync(path).isFile()
      ? path
      : null;
  } catch {
    return null;
  }
}

function readText(path: string, strict = false): string {
  // Python's text reader normalizes universal newlines; specs replace invalid UTF-8.
  const decoder = new TextDecoder("utf-8", { fatal: strict, ignoreBOM: true });
  return decoder.decode(readFileSync(path)).replace(/\r\n|\r/g, "\n");
}

export function platformsOf(
  osCell: string,
  config: Pick<Config, "roadmap">,
): Set<string> {
  const text = plain(osCell)
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ");
  const tokens = new Map<string, string[]>();
  for (const platform of config.roadmap.platforms) {
    for (const token of platform.tokens) {
      const ids = tokens.get(token.toLowerCase()) ?? [];
      ids.push(platform.id);
      tokens.set(token.toLowerCase(), ids);
    }
  }
  const found = new Set<string>();
  let other = false;
  for (const token of text.split(/[^a-z0-9-]+/)) {
    if (!token) continue;
    const ids = tokens.get(token);
    if (ids) for (const id of ids) found.add(id);
    else if (!["compile", "tested", "cross", "model"].includes(token))
      other = true;
  }
  const shared =
    config.roadmap.platforms.find((platform) => platform.id === "shared") ??
    config.roadmap.platforms.find((platform) => platform.tokens.length === 0);
  if ((other || !found.size) && shared) found.add(shared.id);
  return found;
}

export function nextRows(items: Item[], limit = 3): NextRow[] {
  return items
    .filter((item) => item.cls !== "done" && item.cls !== "aside")
    .sort((a, b) => Number(b.cls === "active") - Number(a.cls === "active"))
    .slice(0, limit)
    .map(({ key, id, title, cls, status_short }) => ({
      key,
      id,
      title,
      cls,
      status_short,
    }));
}

export function laneState(count: Totals): MilestoneState {
  if (count.counted && count.done === count.counted) return "done";
  return count.done || count.active ? "active" : "next";
}

export function roadmap(
  lanes: Lane[],
  config: Pick<Config, "roadmap">,
): Roadmap {
  const items = lanes.flatMap((lane) => lane.items);
  const buckets = new Map(
    items.map((item) => [item, platformsOf(item.os, config)]),
  );
  const platforms = config.roadmap.platforms.map((platform) => {
    const rows = items.filter((item) => buckets.get(item)?.has(platform.id));
    const count = totals(rows);
    const shared = platform.id === "shared" || platform.tokens.length === 0;
    return {
      id: platform.id,
      label: platform.label,
      totals: count,
      few: count.counted < config.roadmap.fewRows,
      unlabelled: shared ? rows.filter((item) => empty(item.os)).length : 0,
      note: platform.note ?? "",
      next: nextRows(rows),
    };
  });
  const workstreams = lanes.map((lane) => ({
    id: lane.id,
    title: lane.title,
    totals: totals(lane.items),
    next: nextRows(lane.items),
  }));
  const milestones = config.roadmap.milestones.map((milestone) => {
    const lanePattern = milestone.lane ? new RegExp(milestone.lane, "i") : null;
    const lane = lanes.find((candidate) => lanePattern?.test(candidate.title));
    let rows = lane?.items ?? [];
    if (milestone.include) {
      const pattern = new RegExp(milestone.include);
      rows = rows.filter((item) => pattern.test(item.id));
    }
    if (milestone.exclude) {
      const pattern = new RegExp(milestone.exclude);
      rows = rows.filter((item) => !pattern.test(item.id));
    }
    const count = rows.length ? totals(rows) : null;
    const state = milestone.state ?? (count ? laneState(count) : "later");
    return {
      id: milestone.id,
      kind: milestone.kind,
      title: milestone.title,
      state,
      derived: milestone.state === undefined && count !== null,
      lane: lane && rows.length ? lane.id : "",
      totals: count,
      note: milestone.note ?? "",
      doc: milestone.doc ?? "",
      next: state === "done" ? [] : nextRows(rows),
    };
  });
  return { platforms, workstreams, milestones };
}

// Internal paths stay out of snapshots; a deserialized snapshot can rediscover them from Git.
const checkoutPaths = new WeakMap<Snapshot, Worktree[]>();

/** Effective journal state. Explicit ready completes; subsequent progress or blocker reopens. */
function applyUpdates(items: Item[], updates: JournalEntry[]): void {
  const summaries = summarize(updates);
  const reopened = new Set<string>();
  const seenReady = new Set<string>();
  const lastAction = new Map<string, string>();
  for (const note of updates) {
    if (note.kind === "ready") {
      seenReady.add(note.wp);
      reopened.delete(note.wp);
    } else if (
      (note.kind === "progress" || note.kind === "blocker") &&
      seenReady.has(note.wp)
    )
      reopened.add(note.wp);
    if (["ready", "progress", "blocker", "unblock"].includes(note.kind))
      lastAction.set(note.wp, note.kind);
  }
  for (const item of items) {
    item.agent = summaries[item.id] ?? null;
    if (item.agent?.ready) {
      item.cls = "done";
      item.status_short = "ready";
    } else if (
      item.agent?.blocker &&
      (item.cls !== "done" || reopened.has(item.id))
    ) {
      item.cls = "blocked";
      item.status_short = "blocked";
    } else if (
      reopened.has(item.id) ||
      (lastAction.get(item.id) === "progress" &&
        item.cls !== "done" &&
        item.cls !== "aside")
    ) {
      item.cls = "active";
      item.status_short = "in progress";
    }
    // A stale legacy blocker cannot undo a merged tracker row.
    if (item.cls === "done" && item.agent?.blocker)
      item.agent = { ...item.agent, blocker: null };
    item.in_flight =
      item.cls === "active" ||
      (item.worktree !== null && item.cls !== "done" && item.cls !== "aside");
  }
}

export function build(repo: string, config?: Config, withGit = true): Snapshot {
  repo = resolve(repo);
  const settings = config ?? loadConfig(repo);
  const readmePath = resolve(repo, settings.tracker);
  const directory = dirname(readmePath);
  const trackerPath = safeSpecPath(directory, basename(readmePath), repo);
  if (!trackerPath)
    throw new Error(
      `Tracker is missing or outside the project: ${settings.tracker}`,
    );
  const readme = parseReadme(readText(trackerPath, true), settings);
  const files = new Set(
    readdirSync(directory).filter((name) => name.endsWith(".md")),
  );
  const trees = withGit ? worktrees(repo) : [];
  const items = readme.lanes.flatMap((lane) => lane.items);
  const trackedIds = new Set(items.map((item) => item.id));
  for (const item of items)
    if (!item.file && files.has(`${item.id}.md`)) item.file = `${item.id}.md`;
  const untracked: Item[] = [];
  for (const file of [...files].sort()) {
    if (
      file === basename(readmePath) ||
      !isPackageId(file.slice(0, -3), settings) ||
      readme.links.has(file)
    )
      continue;
    const id = file.slice(0, -3);
    if (trackedIds.has(id)) continue;
    untracked.push(
      newItem({
        key: id,
        id,
        title: "",
        status: "not in the tracker",
        cls: "planned",
        lane: "untracked",
        status_short: "not in the tracker",
        file,
        tracked: false,
      }),
    );
  }
  for (const item of [...items, ...untracked]) {
    const path = files.has(item.file)
      ? safeSpecPath(directory, item.file, repo)
      : null;
    if (path) {
      item.file_exists = true;
      let spec = parseSpec("");
      try {
        item.mtime = statSync(path).mtimeMs / 1000;
        spec = parseSpec(readText(path));
      } catch {
        /* A spec can be removed while a snapshot is being built. */
      }
      item.h1 = spec.h1;
      item.has_report = spec.has_report;
      if (!item.tracked) {
        item.title =
          spec.h1.replace(/^[\p{L}\p{N}_.-]+(\s*\([^)]*\))?\s*[:—-]\s*/u, "") ||
          spec.h1;
        if (spec.has_report) {
          item.status_short = "report filed";
          item.cls = "done";
        } else if (spec.status) {
          item.status = spec.status;
          [item.status_short, item.status_note] = shortStatus(spec.status);
          item.cls = classify(spec.status, settings);
        }
      }
    }
    const tree = matchWorktree(item, trees, settings);
    if (tree) {
      item.worktree = {
        name: tree.name,
        branch: tree.branch ?? "",
        head: tree.head ?? "",
      };
      if (!item.branch && tree.branch) item.branch = tree.branch;
    }
  }
  const updates = readAll(
    repo,
    trees.map((tree) => tree.path),
    settings,
  );
  applyUpdates([...items, ...untracked], updates);
  const recent = [...items, ...untracked]
    .filter((item) => item.mtime)
    .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
    .slice(0, 10);
  const snapshot: Snapshot = {
    generated: Date.now() / 1000,
    readme_mtime: statSync(readmePath).mtimeMs / 1000,
    totals: totals(items),
    lanes: readme.lanes.map((lane) => ({
      ...lane,
      totals: totals(lane.items),
    })),
    roadmap: roadmap(readme.lanes, settings),
    untracked,
    owner_actions: readme.owner_actions,
    docs: [...files].sort(),
    recent: recent.map(({ key, id, mtime, file }) => ({
      key,
      id,
      mtime,
      file,
    })),
    commits: withGit ? commits(repo) : [],
    activity: updates.slice().reverse().slice(0, 24),
    activity_total: updates.length,
  };
  checkoutPaths.set(snapshot, trees);
  return snapshot;
}

export function* everyItem(
  snapshot: Pick<Snapshot, "lanes" | "untracked">,
): Generator<Item> {
  for (const lane of snapshot.lanes) yield* lane.items;
  yield* snapshot.untracked;
}

export function find(
  snapshot: Pick<Snapshot, "lanes" | "untracked">,
  key: string,
): Item | null {
  for (const item of everyItem(snapshot)) if (item.key === key) return item;
  return null;
}

export function detail(
  repo: string,
  snapshot: Snapshot,
  key: string,
  config?: Config,
): Detail | null {
  const item = find(snapshot, key);
  if (!item) return null;
  repo = resolve(repo);
  const settings = config ?? loadConfig(repo);
  const trackerDirectory = dirname(settings.tracker);
  const discovered = worktrees(repo);
  const trees = discovered.length
    ? discovered
    : (checkoutPaths.get(snapshot) ?? []);
  let tree: Worktree | undefined;
  if (item.worktree) {
    tree = trees.find(
      (candidate) =>
        candidate.name === item.worktree?.name &&
        (candidate.branch ?? "") === item.worktree?.branch,
    );
    tree ??= {
      path: join(repo, ".worktrees", item.worktree.name),
      name: item.worktree.name,
    };
  }
  const out: Detail = {
    item,
    spec: null,
    markdown: "",
    source: "",
    git: null,
    updates: readAll(
      repo,
      [
        ...new Set([
          ...trees.map((candidate) => candidate.path),
          ...(tree ? [tree.path] : []),
        ]),
      ],
      settings,
    )
      .filter((note) => note.wp === item.id)
      .reverse(),
  };
  const candidates: [source: string, directory: string, checkout: string][] = [
    [trackerDirectory, resolve(repo, trackerDirectory), repo],
  ];
  if (tree)
    candidates.push([
      relative(repo, tree.path).split(sep).join("/"),
      resolve(tree.path, trackerDirectory),
      tree.path,
    ]);
  for (const [source, directory, checkout] of candidates) {
    const path = safeSpecPath(directory, item.file, checkout);
    if (!path) continue;
    try {
      out.markdown = readText(path);
      out.spec = parseSpec(out.markdown);
      out.source = `${source}/${item.file}`;
      break;
    } catch {
      /* Try the worktree if the main spec disappeared during the read. */
    }
  }
  out.git = branchDetail(repo, item.branch, tree?.path);
  return out;
}

/** Deterministic, serializable change key for every input used by the board. */
export function signature(repo: string, config?: Config): string {
  repo = resolve(repo);
  const settings = config ?? loadConfig(repo);
  const parts: (string | string[])[][] = [["config", JSON.stringify(settings)]];
  const add = (name: string, path: string) => {
    try {
      const stat = statSync(path, { bigint: true });
      parts.push([name, stat.mtimeNs.toString(), stat.size.toString()]);
    } catch {
      /* Missing files and worktrees are ordinary input states. */
    }
  };
  add("config-file", join(repo, ".rimewire", "config.toml"));
  const directory = dirname(resolve(repo, settings.tracker));
  try {
    for (const file of readdirSync(directory))
      if (file.endsWith(".md")) add(`doc:${file}`, join(directory, file));
  } catch {
    /* The server keeps its last good snapshot if its tracker is removed. */
  }
  // A tracker need not itself have a .md extension.
  add("tracker", resolve(repo, settings.tracker));
  const { local, common } = gitDirectories(repo);
  const refs = (root: string, prefix: string) => {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name),
          name = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) refs(path, name);
        else add(name, path);
      }
    } catch {
      /* No loose refs is valid, particularly in an unborn repository. */
    }
  };
  refs(join(common, "refs"), "refs");
  for (const file of ["HEAD", "packed-refs", "config"])
    add(`git:${file}`, join(common, file));
  add("git:checkout-HEAD", join(local, "HEAD"));
  const trees = worktrees(repo);
  for (const tree of trees) {
    const tracker = resolve(tree.path, settings.tracker);
    add(`worktree:${tree.path}:tracker`, tracker);
    try {
      for (const file of readdirSync(dirname(tracker)))
        if (file.endsWith(".md"))
          add(
            `worktree:${tree.path}:doc:${file}`,
            join(dirname(tracker), file),
          );
    } catch {
      /* A linked worktree may not contain tracker documents yet. */
    }
  }
  try {
    const names = readdirSync(join(common, "worktrees")).sort();
    parts.push(["worktrees", names]);
    for (const name of names)
      for (const file of ["HEAD", "gitdir", "commondir"])
        add(`worktree:${name}:${file}`, join(common, "worktrees", name, file));
  } catch {
    /* No linked worktrees. */
  }
  for (const [checkout, path] of journals(
    repo,
    trees.map((tree) => tree.path),
    settings,
  ))
    add(`journal:${checkout}:${path}`, path);
  parts.sort((a, b) =>
    String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0,
  );
  return JSON.stringify(parts);
}
