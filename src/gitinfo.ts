import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Config } from "./config.js";
import { linesOf } from "./tracker.js";

export const GIT_TIMEOUT = 3000;
export interface Worktree {
  path: string;
  name: string;
  branch?: string;
  head?: string;
}
export interface Commit {
  sha: string;
  time: number;
  subject: string;
}
export interface GitDetail {
  branch: string;
  last?: Commit;
  ahead?: number;
  dirty?: number;
}

/** No shell, no optional locks, and a bounded wait for every read-only Git operation. */
export function git(repo: string, args: string[], cwd = repo): string | null {
  try {
    return execFileSync("git", ["--no-optional-locks", ...args], {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

export function parseWorktrees(text: string, repo: string): Worktree[] {
  const entries: Worktree[] = [];
  let current: Partial<Worktree> = {};
  for (const line of [...linesOf(text), ""]) {
    if (!line) {
      if (current.path && resolve(current.path) !== resolve(repo))
        entries.push({
          path: current.path,
          name: current.name ?? basename(current.path),
          ...current,
        });
      current = {};
    } else if (line.startsWith("worktree ")) {
      current.path = line.slice(9);
      current.name = basename(current.path);
    } else if (line.startsWith("branch "))
      current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line.startsWith("HEAD ")) current.head = line.slice(5, 12);
  }
  return entries;
}

export function worktrees(repo: string): Worktree[] {
  const output = git(repo, ["worktree", "list", "--porcelain"]);
  return output ? parseWorktrees(output, repo) : [];
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Explicit tracker branch wins, followed by directory ID and the configured branch convention. */
export function matchWorktree(
  item: { id: string; branch: string },
  trees: Worktree[],
  config: Pick<Config, "branchPrefix"> & Partial<Pick<Config, "branchAliases">>,
): Worktree | null {
  const exact = trees.find(
    (tree) => item.branch && tree.branch === item.branch,
  );
  if (exact) return exact;
  const named = trees.find(
    (tree) => tree.name.toLowerCase() === item.id.toLowerCase(),
  );
  if (named) return named;
  const prefix = config.branchPrefix.replace(/\/+$/, "");
  // Both a complete ID and its conventional prefix-stripped form are valid.
  const id = item.id.toLowerCase();
  const short = id.startsWith(`${prefix.toLowerCase()}-`)
    ? id.slice(prefix.length + 1)
    : id;
  const ids = [...new Set([id, short])].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(
    `^(?:${[prefix, ...(config.branchAliases ?? [])].map((value) => escapeRegex(value.replace(/\/+$/, ""))).join("|")})/(?:${ids.map(escapeRegex).join("|")})(?:-|$)`,
    "i",
  );
  return trees.find((tree) => pattern.test(tree.branch ?? "")) ?? null;
}

export function parseCommits(text: string): Commit[] {
  const result: Commit[] = [];
  for (const line of linesOf(text)) {
    const parts = line.split("\x1f");
    if (parts.length === 3 && /^\d+$/.test(parts[1]))
      result.push({ sha: parts[0], time: Number(parts[1]), subject: parts[2] });
  }
  return result;
}

/** Preserve master when present, and work in repositories using main or another default branch. */
export function mainRef(repo: string): string {
  if (
    git(repo, ["show-ref", "--verify", "--quiet", "refs/heads/master"]) !== null
  )
    return "master";
  if (
    git(repo, ["show-ref", "--verify", "--quiet", "refs/heads/main"]) !== null
  )
    return "main";
  const origin = git(repo, [
    "symbolic-ref",
    "--quiet",
    "refs/remotes/origin/HEAD",
  ])?.trim();
  return origin || "HEAD";
}

export function commits(repo: string, count = 14): Commit[] {
  const args = ["log", `-n${count}`, "--format=%h%x1f%ct%x1f%s"];
  let output = git(repo, [...args, "master", "--"]);
  if (output === null) output = git(repo, [...args, mainRef(repo), "--"]);
  if (output === null) output = git(repo, [...args, "HEAD", "--"]);
  return parseCommits(output ?? "");
}

export function branchDetail(
  repo: string,
  branch: string,
  checkout?: string,
): GitDetail | null {
  if (!branch || branch.startsWith("-") || !/^[\p{L}\p{N}_./-]+$/u.test(branch))
    return null;
  const info: GitDetail = { branch };
  const output = git(repo, [
    "log",
    "-1",
    "--format=%h%x1f%ct%x1f%s",
    branch,
    "--",
  ]);
  // Unlike the commit feed, a subject may contain a separator; split at the first two.
  const last = output?.trim().split("\x1f");
  if (last && last.length >= 3 && /^\d+$/.test(last[1])) {
    info.last = {
      sha: last[0],
      time: Number(last[1]),
      subject: last.slice(2).join("\x1f"),
    };
    const ahead = git(repo, [
      "rev-list",
      "--count",
      `${mainRef(repo)}..${branch}`,
      "--",
    ]);
    if (ahead !== null && /^\d+$/.test(ahead.trim()))
      info.ahead = Number(ahead.trim());
  }
  if (checkout && existsSync(checkout)) {
    const status = git(repo, ["status", "--porcelain"], checkout);
    if (status !== null)
      info.dirty = linesOf(status).filter((line) => line.trim()).length;
  }
  return info;
}

/** Resolve linked-worktree .git files as well as ordinary repositories, including unborn repos. */
export function gitDirectories(repo: string): {
  local: string;
  common: string;
} {
  let local = join(repo, ".git");
  try {
    const pointer = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(local, "utf8"));
    if (pointer) local = resolve(repo, pointer[1].trim());
  } catch {
    /* A normal .git is a directory; missing Git is also supported. */
  }
  let common = local;
  try {
    const pointer = readFileSync(join(local, "commondir"), "utf8").trim();
    common = isAbsolute(pointer) ? pointer : resolve(local, pointer);
  } catch {
    /* The main checkout has no commondir file. */
  }
  return { local: resolve(local), common: resolve(common) };
}

export function mainRepository(repo: string): string {
  const { common } = gitDirectories(repo);
  return basename(common) === ".git" ? dirname(common) : repo;
}
