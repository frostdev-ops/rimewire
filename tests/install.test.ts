import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installHarness, uninstallHarness } from "../src/install.js";
import { removeRepo, tempRepo, write } from "./fixtures/helpers.js";

type Harness = Parameters<typeof installHarness>[0];
type Options = NonNullable<Parameters<typeof installHarness>[1]>;
type Scope = "user" | "project";
const harnesses = ["codex", "opencode", "pi"] as const;
const scopes = ["user", "project"] as const;
const cases = harnesses.flatMap((harness) =>
  scopes.map((scope) => ({ harness, scope })),
);
const codexEvents = [
  "SessionStart",
  "SessionEnd",
  "SubagentStart",
  "SubagentStop",
  "Stop",
] as const;
const PRIVATE = "PRIVATE-install-test-credential-and-prompt";

/** Include directories, links, bytes and mtimes to catch partial preflight writes. */
function snapshot(root: string): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  function visit(directory: string) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      const key = relative(root, path);
      if (stat.isSymbolicLink()) entries[key] = { link: readlinkSync(path) };
      else if (stat.isDirectory()) {
        entries[key] = { directory: true };
        visit(path);
      } else {
        entries[key] = {
          bytes: readFileSync(path),
          mode: stat.mode & 0o777,
          mtime: stat.mtimeMs,
        };
      }
    }
  }
  visit(root);
  return entries;
}

function ageFiles(root: string) {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) ageFiles(path);
    else if (stat.isFile()) utimesSync(path, 1_600_000_000, 1_600_000_000);
  }
}

function json(path: string): Record<string, unknown> {
  const errors: Parameters<typeof parseJsonc>[1] = [];
  const value = parseJsonc(readFileSync(path, "utf8"), errors, {
    allowTrailingComma: true,
  });
  expect(errors).toEqual([]);
  return value;
}

function editJson(path: string, key: string, value: unknown) {
  const text = readFileSync(path, "utf8");
  writeFileSync(
    path,
    applyEdits(
      text,
      modify(text, [key], value, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    ),
  );
}

describe("harness installation ownership and preservation", () => {
  let root: string;
  let home: string;
  let cwd: string;
  let packageRoot: string;
  let nodePath: string;

  beforeEach(() => {
    root = tempRepo();
    home = join(root, "home");
    cwd = join(root, "project");
    packageRoot = join(root, "package's [local] space");
    nodePath = join(root, 'node runtime "quoted"', "node");
    mkdirSync(home);
    mkdirSync(cwd);
    write(packageRoot, "dist/cli.js", "// fixture CLI, never executed\n");
    write(packageRoot, "adapters/opencode/index.mjs", "export default {};\n");
    write(packageRoot, "adapters/pi/index.mjs", "export default () => {};\n");
    write(
      packageRoot,
      "skills/rimewire-setup/SKILL.md",
      "---\nname: rimewire-setup\ndescription: Fixture setup skill.\n---\nRead references/installation.md.\n",
    );
    write(
      packageRoot,
      "skills/rimewire-setup/references/installation.md",
      "# Fixture installation reference\n",
    );
    write(
      packageRoot,
      "skills/rimewire-setup/scripts/nested/setup.mjs",
      "export const setup = true;\n",
    );
    write(packageRoot, "skills/rimewire-setup/.metadata", "fixture metadata\n");
    const binary = join(
      packageRoot,
      "skills/rimewire-setup/assets/payload.bin",
    );
    mkdirSync(dirname(binary), { recursive: true });
    writeFileSync(binary, Buffer.from([0, 255, 13, 10, 128]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    removeRepo(root);
  });

  function options(scope: Scope = "user", extra: Options = {}): Options {
    return { scope, cwd, home, env: {}, packageRoot, nodePath, ...extra };
  }

  function layout(harness: Harness, scope: Scope, jsonc = false) {
    const user = scope === "user";
    switch (harness) {
      case "codex": {
        const directory = join(user ? home : cwd, ".codex");
        return {
          config: join(directory, "config.toml"),
          manifest: join(directory, "rimewire-install.json"),
          skill: join(user ? home : cwd, ".agents/skills/rimewire-setup"),
          hooks: join(directory, "hooks.json"),
        };
      }
      case "opencode":
        return {
          config: join(
            user ? join(home, ".config/opencode") : cwd,
            jsonc ? "opencode.jsonc" : "opencode.json",
          ),
          manifest: join(
            user ? join(home, ".config/opencode") : join(cwd, ".opencode"),
            "rimewire-install.json",
          ),
        };
      case "pi": {
        const directory = join(user ? home : cwd, user ? ".pi/agent" : ".pi");
        return {
          config: join(directory, "settings.json"),
          manifest: join(directory, "rimewire-install.json"),
        };
      }
    }
  }

  function seedSettings(harness: Harness, scope: Scope, jsonc = false) {
    const paths = layout(harness, scope, jsonc);
    const text =
      harness === "codex"
        ? '# Keep this model comment.\nmodel = "custom-model" # inline comment\n\n[mcp_servers.other]\ncommand = "other-server"\nargs = ["serve"]\n# Keep this final comment.\n'
        : harness === "opencode"
          ? '{\n  // Keep this model comment.\n  "model": "custom-model",\n  "plugin": ["existing-plugin"],\n  "mcp": {"other": {"type": "local", "command": ["other-server"]}},\n  // Keep this final comment.\n}\n'
          : '{\n  // Keep this model comment.\n  "defaultModel": "custom-model",\n  "extensions": ["existing-extension"],\n  "skills": ["existing-skill"],\n  "theme": "custom-theme",\n  // Keep this final comment.\n}\n';
    write(root, relative(root, paths.config), text);
    return { ...paths, text };
  }

  function assertInstalled(harness: Harness, config: string) {
    if (harness === "codex") {
      const data = parseToml(readFileSync(config, "utf8"));
      expect(data).toMatchObject({
        mcp_servers: {
          rimewire: {
            command: nodePath,
            args: [join(packageRoot, "dist/cli.js"), "mcp"],
            startup_timeout_sec: 60,
          },
        },
      });
    } else if (harness === "opencode") {
      expect(json(config).plugin).toContain(
        pathToFileURL(join(packageRoot, "adapters/opencode/index.mjs")).href,
      );
    } else {
      expect(json(config).extensions).toContain(
        join(packageRoot, "adapters/pi/index.mjs"),
      );
      expect(json(config).skills).toContain(
        join(packageRoot, "skills/rimewire-setup"),
      );
    }
  }

  function rejectWithoutWrites(action: () => unknown) {
    const before = snapshot(root);
    expect(action).toThrow();
    expect(snapshot(root)).toEqual(before);
  }

  it.each(cases)(
    "installs $harness at $scope scope with a synchronous result and correct ownership location",
    ({ harness, scope }) => {
      const paths = layout(harness, scope);
      const result = installHarness(harness, options(scope));
      expect(result).not.toBeInstanceOf(Promise);
      expect(result.changed.length).toBeGreaterThan(0);
      expect(new Set(result.changed).size).toBe(result.changed.length);
      expect(result.instructions).toEqual(expect.any(Array));
      for (const instruction of result.instructions)
        expect(typeof instruction).toBe("string");
      assertInstalled(harness, paths.config);
      expect(existsSync(paths.manifest)).toBe(true);
      expect(() =>
        JSON.parse(readFileSync(paths.manifest, "utf8")),
      ).not.toThrow();
      if (harness === "codex") {
        expect(existsSync(paths.hooks as string)).toBe(false);
        for (const name of [
          "SKILL.md",
          "references/installation.md",
          "scripts/nested/setup.mjs",
          ".metadata",
          "assets/payload.bin",
        ])
          expect(readFileSync(join(paths.skill as string, name))).toEqual(
            readFileSync(join(packageRoot, "skills/rimewire-setup", name)),
          );
      } else {
        // These adapters load their skills from the installed package.
        expect(existsSync(join(home, ".agents"))).toBe(false);
        expect(existsSync(join(cwd, ".agents"))).toBe(false);
      }
      const otherScope = scope === "user" ? "project" : "user";
      expect(existsSync(layout(harness, otherScope).config)).toBe(false);
      expect(existsSync(layout(harness, otherScope).manifest)).toBe(false);
    },
  );

  it.each(cases)(
    "$harness $scope reinstall preserves every byte and mtime",
    ({ harness, scope }) => {
      const paths = seedSettings(harness, scope);
      installHarness(harness, options(scope));
      ageFiles(root);
      const before = snapshot(root);
      expect(installHarness(harness, options(scope)).changed).toEqual([]);
      expect(snapshot(root)).toEqual(before);
      assertInstalled(harness, paths.config);
      const text = readFileSync(paths.config, "utf8");
      expect(text).toContain("Keep this model comment.");
      expect(text).toContain("Keep this final comment.");
      if (harness === "codex") {
        expect(text).toContain(paths.text);
        expect(text.match(/\[mcp_servers\.rimewire\]/g)).toHaveLength(1);
      }
    },
  );

  it.each(cases)(
    "$harness $scope uninstall preserves earlier settings and unrelated post-install edits",
    ({ harness, scope }) => {
      const paths = seedSettings(harness, scope);
      installHarness(harness, options(scope));
      if (harness === "codex")
        writeFileSync(
          paths.config,
          `${readFileSync(paths.config, "utf8")}\n# Added after installation.\n[projects."fixture"]\ntrust_level = "trusted"\n`,
        );
      else {
        editJson(paths.config, "unrelatedLaterSetting", { retain: true });
        const data = json(paths.config);
        if (harness === "opencode")
          editJson(paths.config, "plugin", [
            ...(data.plugin as string[]),
            "post-install-plugin",
          ]);
        else {
          editJson(paths.config, "extensions", [
            ...(data.extensions as string[]),
            "post-install-extension",
          ]);
          editJson(paths.config, "skills", [
            ...(data.skills as string[]),
            "post-install-skill",
          ]);
        }
      }
      write(
        root,
        `${relative(root, dirname(paths.manifest))}/keep.txt`,
        "keep\n",
      );
      const result = uninstallHarness(harness, options(scope));
      expect(result).not.toBeInstanceOf(Promise);
      expect(result.changed.length).toBeGreaterThan(0);
      expect(existsSync(paths.manifest)).toBe(false);
      expect(
        readFileSync(join(dirname(paths.manifest), "keep.txt"), "utf8"),
      ).toBe("keep\n");
      const text = readFileSync(paths.config, "utf8");
      expect(text).toContain("Keep this model comment.");
      expect(text).toContain("Keep this final comment.");
      if (harness === "codex") {
        expect(parseToml(text)).toMatchObject({
          model: "custom-model",
          mcp_servers: { other: { command: "other-server", args: ["serve"] } },
          projects: { fixture: { trust_level: "trusted" } },
        });
        expect(text).not.toContain("mcp_servers.rimewire");
        expect(existsSync(paths.skill as string)).toBe(false);
        expect(text).toContain("Added after installation.");
      } else if (harness === "opencode")
        expect(json(paths.config)).toMatchObject({
          model: "custom-model",
          plugin: ["existing-plugin", "post-install-plugin"],
          mcp: { other: { type: "local", command: ["other-server"] } },
          unrelatedLaterSetting: { retain: true },
        });
      else
        expect(json(paths.config)).toMatchObject({
          defaultModel: "custom-model",
          extensions: ["existing-extension", "post-install-extension"],
          skills: ["existing-skill", "post-install-skill"],
          theme: "custom-theme",
          unrelatedLaterSetting: { retain: true },
        });
      ageFiles(root);
      const before = snapshot(root);
      expect(uninstallHarness(harness, options(scope)).changed).toEqual([]);
      expect(snapshot(root)).toEqual(before);
    },
  );

  it.each(cases)(
    "$harness $scope uninstall without ownership leaves existing configuration alone",
    ({ harness, scope }) => {
      seedSettings(harness, scope);
      const before = snapshot(root);
      expect(uninstallHarness(harness, options(scope)).changed).toEqual([]);
      expect(snapshot(root)).toEqual(before);
    },
  );

  it.each(cases)(
    "$harness $scope uninstall on a fresh profile creates no directories or files",
    ({ harness, scope }) => {
      const before = snapshot(root);
      expect(uninstallHarness(harness, options(scope)).changed).toEqual([]);
      expect(snapshot(root)).toEqual(before);
    },
  );

  it.each(cases)(
    "$harness $scope refuses an identical installation when its manifest is absent",
    ({ harness, scope }) => {
      installHarness(harness, options(scope));
      rmSync(layout(harness, scope).manifest);
      rejectWithoutWrites(() => installHarness(harness, options(scope)));
      const before = snapshot(root);
      expect(uninstallHarness(harness, options(scope)).changed).toEqual([]);
      expect(snapshot(root)).toEqual(before);
    },
  );

  it.each(cases)(
    "$harness $scope rejects modified owned configuration before uninstalling anything",
    ({ harness, scope }) => {
      const paths = seedSettings(harness, scope);
      installHarness(harness, options(scope));
      if (harness === "codex")
        writeFileSync(
          paths.config,
          readFileSync(paths.config, "utf8").replace(
            JSON.stringify(nodePath),
            JSON.stringify("different-node"),
          ),
        );
      else if (harness === "opencode")
        editJson(paths.config, "plugin", [
          "existing-plugin",
          "different-plugin",
        ]);
      else
        editJson(paths.config, "extensions", [
          "existing-extension",
          "different-extension",
        ]);
      rejectWithoutWrites(() => uninstallHarness(harness, options(scope)));
    },
  );

  it.each(cases)(
    "$harness $scope rejects malformed settings before creating any installation files",
    ({ harness, scope }) => {
      write(
        root,
        relative(root, layout(harness, scope).config),
        harness === "codex"
          ? `model = "${PRIVATE}"\n[broken\n`
          : `{"private":"${PRIVATE}", "broken":`,
      );
      rejectWithoutWrites(() => installHarness(harness, options(scope)));
    },
  );

  it.each(cases)(
    "$harness $scope rejects a malformed ownership manifest without writes",
    ({ harness, scope }) => {
      seedSettings(harness, scope);
      write(
        root,
        relative(root, layout(harness, scope).manifest),
        `{"private":"${PRIVATE}", "broken":`,
      );
      rejectWithoutWrites(() => installHarness(harness, options(scope)));
      rejectWithoutWrites(() => uninstallHarness(harness, options(scope)));
    },
  );

  it.each(cases)(
    "$harness $scope rejects a symlinked configuration file without following it",
    ({ harness, scope }) => {
      const paths = layout(harness, scope);
      const target = join(root, "outside-settings");
      write(
        root,
        "outside-settings",
        harness === "codex" ? "# keep\n" : "{}\n",
      );
      mkdirSync(dirname(paths.config), { recursive: true });
      symlinkSync(target, paths.config);
      rejectWithoutWrites(() => installHarness(harness, options(scope)));
    },
  );

  it.each(cases)(
    "$harness $scope rejects a dangling manifest link without creating its target",
    ({ harness, scope }) => {
      const paths = seedSettings(harness, scope);
      mkdirSync(dirname(paths.manifest), { recursive: true });
      const missing = join(root, "missing-manifest");
      symlinkSync(missing, paths.manifest);
      rejectWithoutWrites(() => installHarness(harness, options(scope)));
      rejectWithoutWrites(() => uninstallHarness(harness, options(scope)));
      expect(existsSync(missing)).toBe(false);
    },
  );

  it("defaults to user scope and the current Node executable", () => {
    const { scope: _scope, nodePath: _nodePath, ...opts } = options();
    installHarness("codex", opts);
    const config = layout("codex", "user").config;
    expect(parseToml(readFileSync(config, "utf8"))).toMatchObject({
      mcp_servers: { rimewire: { command: process.execPath } },
    });
    expect(existsSync(layout("codex", "project").config)).toBe(false);
  });

  it("uses process.cwd when a project cwd was not supplied", () => {
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    const { cwd: _cwd, ...opts } = options("project");
    installHarness("codex", opts);
    assertInstalled("codex", layout("codex", "project").config);
  });

  it("uses os.homedir when a home directory was not supplied", () => {
    vi.stubEnv("HOME", home);
    const { home: _home, ...opts } = options();
    installHarness("codex", opts);
    assertInstalled("codex", layout("codex", "user").config);
  });

  it("uses process.env when an environment was not supplied", () => {
    const override = join(root, "default-env-codex");
    vi.stubEnv("CODEX_HOME", override);
    const { env: _env, ...opts } = options();
    installHarness("codex", opts);
    assertInstalled("codex", join(override, "config.toml"));
    expect(existsSync(layout("codex", "user").config)).toBe(false);
  });

  it.each(harnesses)(
    "%s installs user and project scopes independently",
    (harness) => {
      installHarness(harness, options("user"));
      installHarness(harness, options("project"));
      const user = layout(harness, "user");
      const userSettings = readFileSync(user.config);
      const userManifest = readFileSync(user.manifest);
      uninstallHarness(harness, options("project"));
      expect(readFileSync(user.config)).toEqual(userSettings);
      expect(readFileSync(user.manifest)).toEqual(userManifest);
      assertInstalled(harness, user.config);
      if (harness === "codex")
        expect(existsSync(user.skill as string)).toBe(true);
    },
  );

  it.each([
    ["codex", "CODEX_HOME", "config.toml"],
    ["opencode", "XDG_CONFIG_HOME", "opencode/opencode.json"],
    ["pi", "PI_CODING_AGENT_DIR", "settings.json"],
  ] as const)(
    "%s user install respects %s and leaves the default directory untouched",
    (harness, variable, file) => {
      const override = join(root, "override location");
      const opts = options("user", { env: { [variable]: override } });
      installHarness(harness, opts);
      assertInstalled(harness, join(override, file));
      const directory =
        harness === "opencode" ? join(override, "opencode") : override;
      expect(existsSync(join(directory, "rimewire-install.json"))).toBe(true);
      expect(existsSync(layout(harness, "user").config)).toBe(false);
      if (harness === "codex") {
        expect(
          existsSync(join(home, ".agents/skills/rimewire-setup/SKILL.md")),
        ).toBe(true);
        expect(existsSync(join(override, ".agents"))).toBe(false);
      }
      uninstallHarness(harness, opts);
      expect(existsSync(join(directory, "rimewire-install.json"))).toBe(false);
    },
  );

  it.each(harnesses)(
    "%s project install ignores user configuration overrides",
    (harness) => {
      const override = join(root, "unused user override");
      installHarness(
        harness,
        options("project", {
          env: {
            CODEX_HOME: override,
            XDG_CONFIG_HOME: override,
            PI_CODING_AGENT_DIR: override,
          },
        }),
      );
      assertInstalled(harness, layout(harness, "project").config);
      expect(existsSync(override)).toBe(false);
    },
  );

  it.each(scopes)(
    "OpenCode %s selects a lone JSONC config without creating JSON and preserves its comments",
    (scope) => {
      const paths = seedSettings("opencode", scope, true);
      const fallback = layout("opencode", scope).config;
      installHarness("opencode", options(scope));
      assertInstalled("opencode", paths.config);
      expect(existsSync(fallback)).toBe(false);
      ageFiles(root);
      const before = snapshot(root);
      expect(installHarness("opencode", options(scope)).changed).toEqual([]);
      expect(snapshot(root)).toEqual(before);
      uninstallHarness("opencode", options(scope));
      expect(json(paths.config).plugin).toEqual(["existing-plugin"]);
      expect(readFileSync(paths.config, "utf8")).toContain(
        "Keep this model comment.",
      );
      expect(readFileSync(paths.config, "utf8")).toContain(
        "Keep this final comment.",
      );
      expect(existsSync(fallback)).toBe(false);
    },
  );

  it.each(scopes)(
    "OpenCode %s selects an existing JSONC file over JSON and preserves comments",
    (scope) => {
      const preferred = seedSettings("opencode", scope, true);
      const fallback = layout("opencode", scope).config;
      write(
        root,
        relative(root, fallback),
        '{"plugin":["untouched-fallback"]}\n',
      );
      const fallbackBefore = snapshot(root)[relative(root, fallback)];
      installHarness("opencode", options(scope));
      assertInstalled("opencode", preferred.config);
      expect(snapshot(root)[relative(root, fallback)]).toEqual(fallbackBefore);
      expect(readFileSync(preferred.config, "utf8")).toContain(
        "Keep this model comment.",
      );
      uninstallHarness("opencode", options(scope));
      expect(json(preferred.config).plugin).toEqual(["existing-plugin"]);
      expect(readFileSync(preferred.config, "utf8")).toContain(
        "Keep this final comment.",
      );
      expect(snapshot(root)[relative(root, fallback)]).toEqual(fallbackBefore);
    },
  );

  it.each(scopes)(
    "Codex %s refuses an unowned preexisting MCP table",
    (scope) => {
      write(
        root,
        relative(root, layout("codex", scope).config),
        '[mcp_servers.rimewire]\ncommand = "another-server"\nargs = ["private"]\n',
      );
      rejectWithoutWrites(() => installHarness("codex", options(scope)));
    },
  );

  it.each([
    'model = "custom-model"',
    "# Original comment without a final newline.",
    'model = "custom-model"\r\n# Keep CRLF.\r\n',
    "",
  ])(
    "Codex uninstall restores the exact original TOML separator (%#)",
    (original) => {
      const config = layout("codex", "user").config;
      write(root, relative(root, config), original);
      installHarness("codex", options());
      ageFiles(root);
      const before = snapshot(root);
      expect(installHarness("codex", options()).changed).toEqual([]);
      expect(snapshot(root)).toEqual(before);
      uninstallHarness("codex", options());
      expect(readFileSync(config, "utf8")).toBe(original);
    },
  );

  it("Codex preserves comments inserted inside the owned TOML block by refusing removal or replacement", () => {
    installHarness("codex", options());
    const config = layout("codex", "user").config;
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace(
        "[mcp_servers.rimewire]",
        "[mcp_servers.rimewire]\n# User added this comment; preserve it.",
      ),
    );
    rejectWithoutWrites(() => uninstallHarness("codex", options()));
    rejectWithoutWrites(() => installHarness("codex", options()));
  });

  it.each(["opencode", "pi"] as const)(
    "%s reinstall retains the position of owned entries before later user registrations",
    (harness) => {
      const paths = seedSettings(harness, "user");
      installHarness(harness, options());
      const keys =
        harness === "opencode" ? ["plugin"] : ["extensions", "skills"];
      for (const key of keys) {
        const before = json(paths.config)[key] as string[];
        editJson(paths.config, key, [...before, `later-user-${key}`]);
      }
      ageFiles(root);
      const before = snapshot(root);
      expect(installHarness(harness, options()).changed).toEqual([]);
      expect(snapshot(root)).toEqual(before);
      const nextPackage = join(root, "replacement package");
      cpSync(packageRoot, nextPackage, { recursive: true });
      installHarness(harness, options("user", { packageRoot: nextPackage }));
      for (const key of keys) {
        const current = json(paths.config)[key] as string[];
        expect(current).toHaveLength(3);
        expect(current[0]).toBe(
          `existing-${key === "plugin" ? "plugin" : key === "extensions" ? "extension" : "skill"}`,
        );
        expect(current[2]).toBe(`later-user-${key}`);
        const asset =
          key === "skills"
            ? "skills/rimewire-setup"
            : `adapters/${harness}/index.mjs`;
        expect(current[1]).toBe(
          harness === "opencode"
            ? pathToFileURL(join(nextPackage, asset)).href
            : join(nextPackage, asset),
        );
      }
      uninstallHarness(harness, options("user", { packageRoot: nextPackage }));
      for (const key of keys) {
        const current = json(paths.config)[key] as string[];
        expect(current).toHaveLength(2);
        expect(current[1]).toBe(`later-user-${key}`);
      }
    },
  );

  it.each([
    {
      harness: "opencode" as const,
      key: "plugin",
      asset: "adapters/opencode/index.mjs",
      url: true,
    },
    {
      harness: "pi" as const,
      key: "extensions",
      asset: "adapters/pi/index.mjs",
      url: false,
    },
    {
      harness: "pi" as const,
      key: "skills",
      asset: "skills/rimewire-setup",
      url: false,
    },
  ])(
    "$harness rejects an unowned equal $key entry before modifying other settings",
    ({ harness, key, asset, url }) => {
      const entry = join(packageRoot, asset);
      write(
        root,
        relative(root, layout(harness, "user").config),
        JSON.stringify({
          [key]: [url ? pathToFileURL(entry).href : entry],
          private: PRIVATE,
        }),
      );
      rejectWithoutWrites(() => installHarness(harness, options()));
    },
  );

  it("OpenCode rejects an existing Rimewire MCP config before registering its plugin", () => {
    write(
      root,
      relative(root, layout("opencode", "user").config),
      JSON.stringify({
        mcp: { rimewire: { type: "local", command: ["private-server"] } },
      }),
    );
    rejectWithoutWrites(() => installHarness("opencode", options()));
  });

  it("Pi rejects an existing Rimewire MCP config before registering its extension or skill", () => {
    const config = layout("pi", "user").config;
    write(
      root,
      relative(root, join(dirname(config), "mcp.json")),
      JSON.stringify({
        mcpServers: { rimewire: { command: "private-server" } },
      }),
    );
    rejectWithoutWrites(() => installHarness("pi", options()));
  });

  it.each(scopes)(
    "Codex %s refuses an unowned equal skill even when MCP settings are absent",
    (scope) => {
      const skill = layout("codex", scope).skill as string;
      mkdirSync(dirname(skill), { recursive: true });
      cpSync(join(packageRoot, "skills/rimewire-setup"), skill, {
        recursive: true,
      });
      rejectWithoutWrites(() => installHarness("codex", options(scope)));
    },
  );

  it.each(scopes)(
    "Codex %s refuses an unrelated skill directory without writing MCP settings",
    (scope) => {
      write(
        root,
        `${relative(root, layout("codex", scope).skill as string)}/SKILL.md`,
        "User-owned skill.\n",
      );
      rejectWithoutWrites(() => installHarness("codex", options(scope)));
    },
  );

  it.each([
    "edited",
    "deleted",
    "added",
    "symlinked",
    "binary-edited",
  ] as const)(
    "Codex rejects %s copied skill content before removing any owned settings",
    (change) => {
      installHarness("codex", options());
      const skill = layout("codex", "user").skill as string;
      const reference = join(skill, "references/installation.md");
      if (change === "edited")
        writeFileSync(reference, "User revised this reference.\n");
      else if (change === "deleted") rmSync(reference);
      else if (change === "added")
        writeFileSync(join(skill, "new-user-file.md"), "Keep.\n");
      else if (change === "binary-edited")
        writeFileSync(
          join(skill, "assets/payload.bin"),
          Buffer.from([0, 254, 13, 10, 128]),
        );
      else {
        rmSync(reference);
        symlinkSync(
          join(packageRoot, "skills/rimewire-setup/references/installation.md"),
          reference,
        );
      }
      rejectWithoutWrites(() => uninstallHarness("codex", options()));
    },
  );

  it("Pi rejects a modified owned skill path before removing its extension", () => {
    installHarness("pi", options());
    editJson(layout("pi", "user").config, "skills", ["user-modified-skill"]);
    rejectWithoutWrites(() => uninstallHarness("pi", options()));
  });

  it.each(scopes)(
    "Codex %s optional hooks append once and uninstall preserves later unrelated hooks",
    (scope) => {
      const paths = seedSettings("codex", scope);
      const hooks = paths.hooks as string;
      const earlier = { hooks: [{ type: "command", command: "earlier-hook" }] };
      const later = { hooks: [{ type: "command", command: "later-hook" }] };
      write(
        root,
        relative(root, hooks),
        `{
  // Keep hook comments.
  "hooks": {
    "SessionStart": [${JSON.stringify(earlier)}],
    "UnrelatedEvent": [${JSON.stringify(earlier)}],
  },
  "userSetting": "keep",
}\n`,
      );
      const opts = options(scope, { hooks: true });
      const result = installHarness("codex", opts);
      expect(result.instructions.join(" ")).toMatch(/trust|\/hooks/i);
      const installed = json(hooks).hooks as Record<string, unknown[]>;
      expect(installed.SessionStart[0]).toEqual(earlier);
      expect(installed.SessionStart).toHaveLength(2);
      expect(installed.UnrelatedEvent).toEqual([earlier]);
      for (const event of codexEvents) {
        const entry = installed[event].at(-1);
        expect(entry).toMatchObject({
          hooks: [{ type: "command", command: expect.any(String) }],
        });
      }
      ageFiles(root);
      const before = snapshot(root);
      expect(installHarness("codex", opts).changed).toEqual([]);
      expect(snapshot(root)).toEqual(before);
      editJson(hooks, "hooks", {
        ...installed,
        SessionStart: [...installed.SessionStart, later],
        PostInstallEvent: [later],
      });
      uninstallHarness("codex", opts);
      const retained = json(hooks);
      expect(retained).toMatchObject({
        userSetting: "keep",
        hooks: {
          SessionStart: [earlier, later],
          UnrelatedEvent: [earlier],
          PostInstallEvent: [later],
        },
      });
      for (const event of codexEvents.slice(1))
        expect(
          (retained.hooks as Record<string, unknown[]>)[event] ?? [],
        ).toEqual([]);
      expect(readFileSync(hooks, "utf8")).toContain("Keep hook comments.");
    },
  );

  it("Codex hook commands preserve argv through spaces and apostrophes in the package path", () => {
    writeFileSync(
      join(packageRoot, "dist/cli.js"),
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
    );
    installHarness(
      "codex",
      options("user", { nodePath: process.execPath, hooks: true }),
    );
    const installed = json(layout("codex", "user").hooks as string)
      .hooks as Record<string, { hooks: { command: string }[] }[]>;
    for (const event of codexEvents) {
      const command = installed[event][0].hooks[0].command;
      const invoked = spawnSync("/bin/sh", ["-c", command], {
        cwd,
        encoding: "utf8",
        env: {},
        timeout: 10_000,
      });
      expect(invoked.status, invoked.stderr).toBe(0);
      expect(invoked.stderr).toBe("");
      expect(JSON.parse(invoked.stdout)).toEqual(["hook", `Codex${event}`]);
    }
  });

  it("Codex reinstall without the hooks option retains already-owned hooks and their mtimes", () => {
    installHarness("codex", options("user", { hooks: true }));
    ageFiles(root);
    const before = snapshot(root);
    expect(installHarness("codex", options()).changed).toEqual([]);
    expect(snapshot(root)).toEqual(before);
    uninstallHarness("codex", options());
    const hooks = json(layout("codex", "user").hooks as string).hooks as Record<
      string,
      unknown[]
    >;
    for (const event of codexEvents) expect(hooks[event] ?? []).toEqual([]);
  });

  it.each(["modified", "removed"] as const)(
    "Codex rejects a %s owned hook before uninstalling MCP settings or skills",
    (change) => {
      const opts = options("user", { hooks: true });
      installHarness("codex", opts);
      const hooks = layout("codex", "user").hooks as string;
      const installed = json(hooks).hooks as Record<string, unknown[]>;
      editJson(hooks, "hooks", {
        ...installed,
        SessionEnd:
          change === "removed"
            ? []
            : [{ hooks: [{ type: "command", command: "user-edit" }] }],
      });
      rejectWithoutWrites(() => uninstallHarness("codex", opts));
    },
  );

  it.each([
    `{"private":"${PRIVATE}",`,
    "[]",
    '{"hooks":"not an object"}',
    '{"hooks":{"SessionEnd":"not an array"}}',
  ])(
    "Codex preflights malformed optional hooks without writes (%#)",
    (text) => {
      const paths = seedSettings("codex", "user");
      write(root, relative(root, paths.hooks as string), text);
      rejectWithoutWrites(() =>
        installHarness("codex", options("user", { hooks: true })),
      );
    },
  );

  it("Codex leaves existing hooks untouched when hooks were not requested", () => {
    const paths = seedSettings("codex", "user");
    const hooks = paths.hooks as string;
    write(root, relative(root, hooks), `{"private":"${PRIVATE}",`);
    ageFiles(root);
    const before = snapshot(root)[relative(root, hooks)];
    installHarness("codex", options());
    expect(snapshot(root)[relative(root, hooks)]).toEqual(before);
    uninstallHarness("codex", options());
    expect(snapshot(root)[relative(root, hooks)]).toEqual(before);
  });

  it.each([
    { harness: "codex" as const, text: 'mcp_servers = "not a table"\n' },
    { harness: "opencode" as const, text: "[]" },
    { harness: "opencode" as const, text: '{"plugin":"not an array"}' },
    { harness: "pi" as const, text: '{"extensions":{}}' },
    { harness: "pi" as const, text: '{"skills":"not an array"}' },
  ])(
    "rejects invalid $harness setting shapes ($text) before writes",
    ({ harness, text }) => {
      write(root, relative(root, layout(harness, "user").config), text);
      rejectWithoutWrites(() => installHarness(harness, options()));
    },
  );

  it.each(harnesses)(
    "%s rejects a symlinked destination directory",
    (harness) => {
      const paths = layout(harness, "user");
      const directory = dirname(paths.config);
      const outside = join(root, "outside-directory");
      mkdirSync(outside);
      mkdirSync(dirname(directory), { recursive: true });
      symlinkSync(outside, directory);
      rejectWithoutWrites(() => installHarness(harness, options()));
    },
  );

  it.each(["skill", "skill-parent"] as const)(
    "Codex rejects a symlinked destination %s before adding MCP settings",
    (target) => {
      const skill = layout("codex", "user").skill as string;
      const destination = target === "skill" ? skill : dirname(skill);
      const outside = join(root, "outside-skill");
      mkdirSync(outside);
      mkdirSync(dirname(destination), { recursive: true });
      symlinkSync(outside, destination);
      rejectWithoutWrites(() => installHarness("codex", options()));
    },
  );

  it("Codex rejects symlinked source skill files before copying anything", () => {
    const reference = join(
      packageRoot,
      "skills/rimewire-setup/references/installation.md",
    );
    rmSync(reference);
    write(root, "outside-reference", "Do not copy this.\n");
    symlinkSync(join(root, "outside-reference"), reference);
    rejectWithoutWrites(() => installHarness("codex", options()));
  });

  it.each(harnesses)(
    "%s rejects a missing packaged runtime without writes",
    (harness) => {
      rmSync(join(packageRoot, "dist/cli.js"));
      rejectWithoutWrites(() => installHarness(harness, options()));
    },
  );

  it.each(["opencode", "pi"] as const)(
    "%s rejects a missing adapter without writes",
    (harness) => {
      rmSync(join(packageRoot, `adapters/${harness}/index.mjs`));
      rejectWithoutWrites(() => installHarness(harness, options()));
    },
  );

  it.each(cases)(
    "$harness $scope uninstall rejects a replaced configuration symlink without writes",
    ({ harness, scope }) => {
      installHarness(harness, options(scope));
      const config = layout(harness, scope).config;
      const target = join(root, "outside-installed-config");
      writeFileSync(target, readFileSync(config));
      rmSync(config);
      symlinkSync(target, config);
      rejectWithoutWrites(() => uninstallHarness(harness, options(scope)));
    },
  );

  it.each(harnesses)(
    "%s errors and results never expose private setting values or unrelated environment fields",
    (harness) => {
      let output = "";
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output += String(chunk);
        return true;
      });
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        output += String(chunk);
        return true;
      });
      const env: NodeJS.ProcessEnv = {};
      const readSecret = vi.fn(() => PRIVATE);
      Object.defineProperty(env, "PRIVATE_API_TOKEN", {
        enumerable: true,
        get: readSecret,
      });
      const config = layout(harness, "user").config;
      const valid =
        harness === "codex"
          ? `api_key = "${PRIVATE}"\n`
          : JSON.stringify({ api_key: PRIVATE });
      write(root, relative(root, config), valid);
      const opts = options("user", { env });
      const installed = installHarness(harness, opts);
      expect(JSON.stringify(installed)).not.toContain(PRIVATE);
      expect(
        readFileSync(layout(harness, "user").manifest, "utf8"),
      ).not.toContain(PRIVATE);
      expect(JSON.stringify(uninstallHarness(harness, opts))).not.toContain(
        PRIVATE,
      );
      writeFileSync(
        config,
        harness === "codex"
          ? `api_key = "${PRIVATE}"\n[broken`
          : `{"api_key":"${PRIVATE}",`,
      );
      let error: unknown;
      try {
        installHarness(harness, opts);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(PRIVATE);
      expect(output).not.toContain(PRIVATE);
      expect(readSecret).not.toHaveBeenCalled();
    },
  );
});
