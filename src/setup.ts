/** Deterministic project setup mechanics; the skill chooses the project's customization. */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
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
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "smol-toml";
import { type Config, loadConfig, parseConfig } from "./config.js";

const BEGIN = "<!-- rimewire:begin -->";
const END = "<!-- rimewire:end -->";
export interface SetupOptions {
  config?: unknown;
  agentFiles?: string[];
}
function contained(root: string, target: string) {
  const rel = relative(root, target);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
function safeTarget(root: string, name: string): string {
  if (
    isAbsolute(name) ||
    name.split(/[\\/]/).includes("..") ||
    name.split(/[\\/]/).includes(".git")
  )
    throw new Error(`setup path must stay inside the project: ${name}`);
  const target = resolve(root, name);
  if (!contained(root, target))
    throw new Error(`setup path escapes project: ${name}`);
  let ancestor = target;
  for (;;) {
    try {
      lstatSync(ancestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      ancestor = dirname(ancestor);
    }
  }
  if (ancestor !== target && !statSync(ancestor).isDirectory())
    throw new Error(`setup parent is not a directory: ${name}`);
  if (!contained(root, realpathSync(ancestor)))
    throw new Error(`setup path escapes project through symlink: ${name}`);
  try {
    if (lstatSync(target).isSymbolicLink())
      throw new Error(`setup will not replace a symlink: ${name}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return target;
}
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function shellPath(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}
export function managedBlock(config: Config): string {
  const fallback = `node ${shellPath(fileURLToPath(new URL("./cli.js", import.meta.url)))}`;
  return `${BEGIN}
## Rimewire board

Read the project board before starting work: use \`board_overview\` and \`get_package\`,
or read \`${config.tracker}\` and use the checkout-local CLI. Read \`list_updates\` when resuming work.
Use \`board_url\` for the live web board.
Keep the tracker synchronized when plans, dependencies, or work-package scope change.
Every agent and subagent must post meaningful progress, blockers, decisions, and review handoffs
using \`post_update\`. Use real package IDs from the tracker; never invent an ID just to post an update.
Explicit \`ready\` marks completion only after the work and required checks pass; later progress
or a blocker reopens it. Session exit alone never establishes completion.

When MCP is unavailable, run \`rimewire list\`, \`rimewire progress <id> --percent <n> --text <update>\`,
\`rimewire blocker <id> --text <reason>\`, or \`rimewire ready <id> --text <evidence>\` from your own
checkout. If \`rimewire\` is not on PATH, substitute \`${fallback}\` for it. Rerun setup after moving
or updating the plugin if this fallback path changes.
Pass these board-use instructions to delegated workers; use the local CLI when they lack MCP tools.
Keep journals in \`${config.journalDir}\` inside each checkout, and keep them gitignored.
Never put secrets, credentials, or private prompt contents in board updates.
${END}`;
}
export function replaceManaged(text: string, block: string): string {
  const starts = text.split(BEGIN).length - 1;
  const ends = text.split(END).length - 1;
  if (!starts && !ends)
    return `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}${block}\n`;
  if (starts !== 1 || ends !== 1 || text.indexOf(END) < text.indexOf(BEGIN))
    throw new Error(
      "malformed or duplicate Rimewire managed markers; fix them before setup",
    );
  return (
    text.slice(0, text.indexOf(BEGIN)) +
    block +
    text.slice(text.indexOf(END) + END.length)
  );
}
export function setupProject(
  project: string,
  options: SetupOptions = {},
): { changed: string[]; config: Config } {
  const root = realpathSync(project);
  const configFile = safeTarget(root, ".rimewire/config.toml");
  const oldConfig = read(configFile);
  const current = oldConfig === undefined ? undefined : loadConfig(root);
  const config =
    options.config === undefined
      ? (current ?? parseConfig({ name: basename(root) }))
      : parseConfig(options.config);
  const planned = new Map<string, string>();
  if (
    oldConfig === undefined ||
    (options.config !== undefined &&
      JSON.stringify(current) !== JSON.stringify(config))
  )
    planned.set(configFile, stringify(config));
  const tracker = safeTarget(root, config.tracker);
  if (tracker === configFile || tracker === resolve(root, ".gitignore"))
    throw new Error("tracker must be separate from config and gitignore");
  if (/[\r\n]/.test(config.journalDir))
    throw new Error(
      "journal directory cannot contain line breaks in gitignore",
    );
  const journal = safeTarget(root, config.journalDir);
  if (existsSync(journal) && !statSync(journal).isDirectory())
    throw new Error("journal directory must be a directory");
  if (contained(journal, tracker) || contained(journal, configFile))
    throw new Error(
      "journal directory must not contain the tracker or project config",
    );
  if (read(tracker) === undefined)
    planned.set(
      tracker,
      `# ${config.name} board\n\n## Plan\n\n| ID | Title | OS | Depends on | Status | Branch |\n|---|---|---|---|---|---|\n`,
    );
  const agents = new Set([
    "AGENTS.md",
    "CLAUDE.md",
    ...(options.agentFiles ?? []),
  ]);
  for (const name of [
    "AGENTS.override.md",
    "CLAUDE.local.md",
    "GEMINI.md",
    ".cursorrules",
    ".github/copilot-instructions.md",
  ])
    if (present(join(root, name))) agents.add(name);
  const rules = join(root, ".cursor/rules");
  if (present(rules)) safeTarget(root, ".cursor/rules");
  if (present(rules))
    for (const name of readdirSync(rules))
      if (/\.(md|mdc)$/.test(name)) agents.add(`.cursor/rules/${name}`);
  const block = managedBlock(config);
  for (const name of agents) {
    const target = safeTarget(root, name);
    if (contained(journal, target))
      throw new Error("journal directory must not contain agent instructions");
    if (
      target === tracker ||
      target === configFile ||
      target === resolve(root, ".gitignore")
    )
      throw new Error(
        "agent files must be separate from tracker, config and gitignore",
      );
    planned.set(target, replaceManaged(read(target) ?? "", block));
  }
  const ignoreFile = safeTarget(root, ".gitignore");
  const ignore = read(ignoreFile) ?? "";
  const journalName =
    process.platform === "win32"
      ? config.journalDir.replaceAll("\\", "/")
      : config.journalDir;
  const pattern = `/${journalName.replace(/\/$/, "")}/`;
  // Escape gitignore metacharacters in configured paths.
  const escaped = pattern.replace(/[\\!*?[\]# ]/g, "\\$&");
  const ignored = ignore.split(/\r?\n/).includes(escaped);
  if (!ignored)
    planned.set(
      ignoreFile,
      `${ignore}${ignore && !ignore.endsWith("\n") ? "\n" : ""}${escaped}\n`,
    );
  const changed: string[] = [];
  // Preflight every target and managed block before applying any change.
  for (const [target, text] of planned) {
    if (read(target) === text) continue;
    safeTarget(root, relative(root, target));
    mkdirSync(dirname(target), { recursive: true });
    const temp = `${target}.rimewire-${randomUUID()}.tmp`;
    const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o644;
    try {
      writeFileSync(temp, text, { flag: "wx", mode });
      renameSync(temp, target);
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        /* Successful rename already removed it. */
      }
    }
    changed.push(relative(root, target));
  }
  return { changed, config };
}
