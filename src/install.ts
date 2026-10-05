/** Harness registration, with an ownership receipt for conservative removal. */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  applyEdits,
  modify,
  type ParseError,
  parse as parseJson,
} from "jsonc-parser";
import { parse as parseToml, stringify } from "smol-toml";

export type Harness = "codex" | "opencode" | "pi";
export interface InstallOptions {
  scope?: "user" | "project";
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  packageRoot?: string;
  nodePath?: string;
  hooks?: boolean;
}
export interface InstallResult {
  changed: string[];
  instructions: string[];
}
type Mutation = {
  file: string;
  key: string[];
  value: unknown;
  kind: "value" | "array" | "toml";
  block?: string;
  separator?: boolean;
};
type Receipt = {
  version: 1;
  harness: Harness;
  mutations: Mutation[];
  files: Record<string, string>;
};
const begin = "# rimewire:install:begin";
const end = "# rimewire:install:end";
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
type FileData = string | Buffer;
const hash = (text: FileData) =>
  createHash("sha256").update(text).digest("hex");

function location(harness: Harness, options: InstallOptions) {
  if (!["codex", "opencode", "pi"].includes(harness))
    throw new Error("unsupported harness; choose codex, opencode, or pi");
  const project = options.scope === "project";
  const env = options.env ?? process.env;
  const home = resolve(options.home ?? homedir());
  const cwd = resolve(options.cwd ?? process.cwd());
  const root = resolve(
    options.packageRoot ?? fileURLToPath(new URL("../", import.meta.url)),
  );
  const base = project
    ? join(cwd, `.${harness}`)
    : harness === "codex"
      ? resolve(env.CODEX_HOME ?? join(home, ".codex"))
      : harness === "opencode"
        ? join(
            resolve(env.XDG_CONFIG_HOME ?? join(home, ".config")),
            "opencode",
          )
        : resolve(env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent"));
  let config = join(
    base,
    harness === "codex"
      ? "config.toml"
      : harness === "pi"
        ? "settings.json"
        : "opencode.json",
  );
  if (harness === "opencode") {
    const dir = project ? cwd : base;
    config = join(
      dir,
      existsSync(join(dir, "opencode.jsonc"))
        ? "opencode.jsonc"
        : "opencode.json",
    );
  }
  const skill = join(
    project ? cwd : home,
    ".agents",
    "skills",
    "rimewire-setup",
  );
  return {
    project,
    root,
    base,
    config,
    skill,
    receipt: join(base, "rimewire-install.json"),
    node: options.nodePath ?? process.execPath,
  };
}
function safe(path: string) {
  for (let current = resolve(path); ; ) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink())
        throw new Error(`installation target uses a symlink: ${current}`);
      if (current !== resolve(path) && !stat.isDirectory())
        throw new Error("installation parent is not a directory");
      if (current === resolve(path) && !stat.isFile())
        throw new Error("installation target is not a regular file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function read(path: string) {
  safe(path);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}
function readBytes(path: string): Buffer | undefined {
  safe(path);
  return existsSync(path) ? readFileSync(path) : undefined;
}
function json(text: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value = parseJson(text, errors, { allowTrailingComma: true });
  if (
    errors.length ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    throw new Error("harness JSON configuration must be a valid object");
  return value;
}
function at(value: unknown, key: string[]): unknown {
  let current = value;
  for (const part of key) {
    if (!current || typeof current !== "object" || Array.isArray(current))
      return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
function patch(text: string, key: string[], value: unknown) {
  return applyEdits(
    text,
    modify(text, key, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  );
}
function receiptAt(path: string, harness: Harness): Receipt | undefined {
  const text = read(path);
  if (text === undefined) return;
  let data: Receipt;
  try {
    data = JSON.parse(text) as Receipt;
  } catch {
    throw new Error("invalid Rimewire installation receipt");
  }
  if (
    data.version !== 1 ||
    data.harness !== harness ||
    !Array.isArray(data.mutations) ||
    !data.files ||
    typeof data.files !== "object"
  )
    throw new Error("invalid Rimewire installation receipt");
  return data;
}
function validateReceipt(
  receipt: Receipt | undefined,
  loc: ReturnType<typeof location>,
  harness: Harness,
) {
  if (!receipt) return;
  for (const mutation of receipt.mutations) {
    if (
      !mutation ||
      !Array.isArray(mutation.key) ||
      mutation.key.some((part) => typeof part !== "string") ||
      !["array", "value", "toml"].includes(mutation.kind)
    )
      throw new Error("invalid Rimewire installation receipt");
    const key = mutation.key.join(".");
    const allowed =
      harness === "codex"
        ? (mutation.file === loc.config &&
            key === "mcp_servers.rimewire" &&
            mutation.kind === "toml") ||
          (mutation.file === join(loc.base, "hooks.json") &&
            /^hooks\.(SessionStart|SessionEnd|SubagentStart|SubagentStop|Stop)$/.test(
              key,
            ) &&
            mutation.kind === "array")
        : mutation.file === loc.config &&
          mutation.kind === "array" &&
          (harness === "opencode"
            ? key === "plugin"
            : ["skills", "extensions"].includes(key));
    if (!allowed)
      throw new Error(
        "installation receipt paths do not match this harness and scope",
      );
  }
  for (const [path, digest] of Object.entries(receipt.files)) {
    if (
      harness !== "codex" ||
      !path.startsWith(`${loc.skill}/`) ||
      resolve(path) !== path ||
      !/^[a-f0-9]{64}$/.test(digest)
    )
      throw new Error("invalid installed skill ownership receipt");
  }
}
function pruneEmpty(directory: string) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true }))
    if (entry.isDirectory()) pruneEmpty(join(directory, entry.name));
  if (readdirSync(directory).length === 0) rmdirSync(directory);
}
function ownedToml(text: string, value: unknown, mutation: Mutation): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(text);
  } catch {
    throw new Error("invalid harness TOML configuration");
  }
  if (
    !isDeepStrictEqual(
      plain(at(parsed, ["mcp_servers", "rimewire"]) ?? null),
      value,
    )
  )
    throw new Error("Rimewire MCP settings changed; preserving user edits");
  const lines = text.split(/(?<=\n)/);
  const starts = lines.flatMap((line, i) => (line.trim() === begin ? [i] : []));
  const ends = lines.flatMap((line, i) => (line.trim() === end ? [i] : []));
  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0])
    throw new Error(
      "Rimewire TOML ownership block changed; preserving user edits",
    );
  const owned = lines.slice(starts[0], ends[0] + 1).join("");
  if (mutation.block && owned !== mutation.block)
    throw new Error(
      "Rimewire TOML ownership block changed; preserving user edits",
    );
  const block = lines.slice(starts[0] + 1, ends[0]).join("");
  try {
    if (
      !isDeepStrictEqual(plain(parseToml(block)), {
        mcp_servers: { rimewire: value },
      })
    )
      throw new Error();
  } catch {
    throw new Error("Rimewire TOML ownership block contains user edits");
  }
  const before = lines.slice(0, starts[0]).join("");
  return (
    (mutation.separator ? before.slice(0, -1) : before) +
    lines.slice(ends[0] + 1).join("")
  );
}
function removeMutation(text: string, mutation: Mutation) {
  if (mutation.kind === "toml")
    return ownedToml(text, mutation.value, mutation);
  const current = at(json(text), mutation.key);
  if (mutation.kind === "array") {
    if (
      !Array.isArray(current) ||
      current.filter((item) => isDeepStrictEqual(item, mutation.value))
        .length !== 1
    )
      throw new Error("Rimewire registration changed; preserving user edits");
    return patch(
      text,
      mutation.key,
      current.filter((item) => !isDeepStrictEqual(item, mutation.value)),
    );
  }
  if (!isDeepStrictEqual(current, mutation.value))
    throw new Error("Rimewire registration changed; preserving user edits");
  return patch(text, mutation.key, undefined);
}
function tree(directory: string): Record<string, Buffer> {
  const result: Record<string, Buffer> = {};
  function walk(dir: string) {
    if (lstatSync(dir).isSymbolicLink())
      throw new Error("skill directories must not be symlinks");
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) result[path] = readFileSync(path);
      else throw new Error("skill assets must be regular files");
    }
  }
  walk(directory);
  return result;
}
function apply(plan: Map<string, FileData | undefined>): string[] {
  const changed: string[] = [];
  const previous = new Map<string, Buffer | undefined>();
  for (const [path, next] of plan) {
    const old = readBytes(path);
    const data = typeof next === "string" ? Buffer.from(next) : next;
    if (
      old === undefined
        ? data !== undefined
        : data === undefined || !old.equals(data)
    ) {
      previous.set(path, old);
      changed.push(path);
    }
  }
  try {
    for (const path of changed) {
      const next = plan.get(path);
      if (next === undefined) {
        rmSync(path);
        continue;
      }
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temp, next, {
          mode: existsSync(path) ? lstatSync(path).mode & 0o777 : 0o600,
        });
        renameSync(temp, path);
      } finally {
        rmSync(temp, { force: true });
      }
    }
  } catch (error) {
    for (const [path, old] of previous) {
      if (old === undefined) rmSync(path, { force: true });
      else writeFileSync(path, old);
    }
    throw error;
  }
  return changed;
}
function locked<T>(receipt: string, action: () => T): T {
  safe(receipt);
  const lock = `${receipt}.lock`;
  safe(lock);
  const created: string[] = [];
  for (let dir = dirname(lock); !existsSync(dir); dir = dirname(dir))
    created.push(dir);
  mkdirSync(dirname(lock), { recursive: true });
  try {
    writeFileSync(lock, "install\n", { flag: "wx", mode: 0o600 });
  } catch {
    throw new Error(
      "another Rimewire installation is running (or its lock remains)",
    );
  }
  try {
    return action();
  } finally {
    rmSync(lock, { force: true });
    for (const dir of created) {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
    }
  }
}
function instruction(harness: Harness, project: boolean) {
  return [
    `Restart ${harness} to load Rimewire, then invoke rimewire-setup and verify board_url.`,
    ...(harness === "codex" && project
      ? [
          "Codex loads project config and skills only under its project trust rules.",
        ]
      : []),
  ];
}

export function installHarness(
  harness: Harness,
  options: InstallOptions = {},
): InstallResult {
  const loc = location(harness, options);
  return locked(loc.receipt, () => {
    read(join(loc.root, "dist", "cli.js")) ??
      (() => {
        throw new Error("build or install the Rimewire runtime first");
      })();
    const previous = receiptAt(loc.receipt, harness);
    validateReceipt(previous, loc, harness);
    const plan = new Map<string, FileData | undefined>();
    const positions = new Map<string, number>();
    const contents = (path: string) =>
      plan.has(path) ? plan.get(path)?.toString() : read(path);
    if (previous) {
      for (const mutation of previous.mutations) {
        const text = contents(mutation.file);
        if (text === undefined)
          throw new Error("owned harness configuration was removed");
        if (mutation.kind === "array") {
          const values = at(json(text), mutation.key) as unknown[];
          positions.set(
            `${mutation.file}:${mutation.key.join(".")}`,
            values.findIndex((value) =>
              isDeepStrictEqual(value, mutation.value),
            ),
          );
        }
        plan.set(mutation.file, removeMutation(text, mutation));
      }
      for (const [path, digest] of Object.entries(previous.files)) {
        const text = readBytes(path);
        if (text === undefined || hash(text) !== digest)
          throw new Error(
            "installed Rimewire skill changed; preserving user edits",
          );
        plan.set(path, undefined);
      }
      if (Object.keys(previous.files).length && existsSync(loc.skill)) {
        const extra = Object.keys(tree(loc.skill)).filter(
          (path) => !Object.hasOwn(previous.files, path),
        );
        if (extra.length)
          throw new Error(
            "installed Rimewire skill contains additional files; preserving user edits",
          );
      }
    }
    const receipt: Receipt = { version: 1, harness, mutations: [], files: {} };
    function add(
      file: string,
      key: string[],
      value: unknown,
      kind: "array" | "value" = "value",
    ) {
      let text = contents(file) ?? "{}\n";
      const current = at(json(text), key);
      // Validate intermediate containers rather than replacing a user's scalar setting.
      for (let i = 1; i < key.length; i++) {
        const parent = at(json(text), key.slice(0, i));
        if (
          parent !== undefined &&
          (!parent || typeof parent !== "object" || Array.isArray(parent))
        )
          throw new Error(
            "harness configuration has an incompatible settings container",
          );
      }
      if (kind === "array") {
        if (current !== undefined && !Array.isArray(current))
          throw new Error("harness registration list must be an array");
        if (
          (current as unknown[] | undefined)?.some((item) =>
            isDeepStrictEqual(item, value),
          )
        )
          throw new Error(
            "Rimewire registration already exists outside this installer",
          );
        const values = [...((current as unknown[]) ?? [])];
        values.splice(
          positions.get(`${file}:${key.join(".")}`) ?? values.length,
          0,
          value,
        );
        text = patch(text, key, values);
      } else {
        if (current !== undefined)
          throw new Error(
            "Rimewire registration already exists outside this installer",
          );
        text = patch(text, key, value);
      }
      plan.set(file, text);
      receipt.mutations.push({ file, key, value, kind });
    }
    if (harness === "codex") {
      const value = {
        command: loc.node,
        args: [join(loc.root, "dist", "cli.js"), "mcp"],
        startup_timeout_sec: 60,
      };
      const text = contents(loc.config) ?? "";
      let data: Record<string, unknown>;
      try {
        data = parseToml(text);
      } catch {
        throw new Error("invalid harness TOML configuration");
      }
      if (
        at(data, ["mcp_servers", "rimewire"]) !== undefined ||
        text.includes(begin) ||
        text.includes(end)
      )
        throw new Error(
          "Rimewire MCP registration already exists outside this installer",
        );
      const separator = Boolean(text && !text.endsWith("\n"));
      const block = `${begin}\n${stringify({ mcp_servers: { rimewire: value } })}${end}\n`;
      const next = text + (separator ? "\n" : "") + block;
      try {
        parseToml(next);
      } catch {
        throw new Error(
          "cannot append Rimewire to this TOML layout without changing user settings",
        );
      }
      plan.set(loc.config, next);
      receipt.mutations.push({
        file: loc.config,
        key: ["mcp_servers", "rimewire"],
        value,
        kind: "toml",
        block,
        separator,
      });
      const source = join(loc.root, "skills", "rimewire-setup");
      if (!existsSync(source))
        throw new Error("Rimewire setup skill is missing");
      if (!previous && existsSync(loc.skill))
        throw new Error(
          "Rimewire setup skill already exists outside this installer",
        );
      for (const [path, text] of Object.entries(tree(source))) {
        const target = join(loc.skill, path.slice(source.length + 1));
        plan.set(target, text);
        receipt.files[target] = hash(text);
      }
      if (
        options.hooks ??
        previous?.mutations.some((m) => m.file === join(loc.base, "hooks.json"))
      ) {
        for (const event of [
          "SessionStart",
          "SessionEnd",
          "SubagentStart",
          "SubagentStop",
          "Stop",
        ]) {
          const quote = (value: string) =>
            `'${value.replaceAll("'", "'\\''")}'`;
          const hook = {
            hooks: [
              {
                type: "command",
                command: `${quote(loc.node)} ${quote(join(loc.root, "dist", "cli.js"))} hook Codex${event}`,
                timeout: 1,
              },
            ],
          };
          add(join(loc.base, "hooks.json"), ["hooks", event], hook, "array");
        }
      }
    } else if (harness === "opencode") {
      // The plugin owns its runtime MCP and skill injection, not the user's config.
      const plugin = join(loc.root, "adapters", "opencode", "index.mjs");
      if (read(plugin) === undefined)
        throw new Error("OpenCode adapter is missing");
      if (
        at(json(contents(loc.config) ?? "{}"), ["mcp", "rimewire"]) !==
        undefined
      )
        throw new Error("OpenCode already has a Rimewire MCP registration");
      add(loc.config, ["plugin"], pathToFileURL(plugin).href, "array");
    } else {
      const extension = join(loc.root, "adapters", "pi", "index.mjs");
      if (read(extension) === undefined)
        throw new Error("Pi adapter is missing");
      const mcp = read(join(loc.base, "mcp.json"));
      if (mcp && at(json(mcp), ["mcpServers", "rimewire"]) !== undefined)
        throw new Error("Pi already has a Rimewire MCP registration");
      add(loc.config, ["extensions"], extension, "array");
      add(
        loc.config,
        ["skills"],
        join(loc.root, "skills", "rimewire-setup"),
        "array",
      );
    }
    plan.set(loc.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
    return {
      changed: apply(plan),
      instructions: [
        ...instruction(harness, loc.project),
        ...(harness === "codex" && options.hooks
          ? [
              "Review and trust the installed hooks through Codex /hooks; installation does not trust them.",
            ]
          : []),
      ],
    };
  });
}
export function uninstallHarness(
  harness: Harness,
  options: InstallOptions = {},
): InstallResult {
  const loc = location(harness, options);
  return locked(loc.receipt, () => {
    const receipt = receiptAt(loc.receipt, harness);
    validateReceipt(receipt, loc, harness);
    if (!receipt) return { changed: [], instructions: [] };
    const plan = new Map<string, FileData | undefined>();
    for (const mutation of receipt.mutations) {
      const text = plan.get(mutation.file)?.toString() ?? read(mutation.file);
      if (text === undefined)
        throw new Error(
          "owned harness configuration was removed; preserve the receipt for manual recovery",
        );
      plan.set(mutation.file, removeMutation(text, mutation));
    }
    for (const [path, digest] of Object.entries(receipt.files)) {
      const text = readBytes(path);
      if (text === undefined || hash(text) !== digest)
        throw new Error(
          "installed Rimewire skill changed; preserving user edits",
        );
      plan.set(path, undefined);
    }
    if (
      Object.keys(receipt.files).length &&
      existsSync(loc.skill) &&
      Object.keys(tree(loc.skill)).some(
        (path) => !Object.hasOwn(receipt.files, path),
      )
    )
      throw new Error(
        "installed Rimewire skill contains additional files; preserving user edits",
      );
    plan.set(loc.receipt, undefined);
    return {
      changed: (() => {
        const changed = apply(plan);
        if (Object.keys(receipt.files).length) pruneEmpty(loc.skill);
        return changed;
      })(),
      instructions: [
        `Restart ${harness} to unload Rimewire. Project config, trackers, agent instructions, and journals are preserved.`,
      ],
    };
  });
}
