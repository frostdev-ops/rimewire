import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { build as bundle } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, parseConfig } from "../src/config.js";
import { managedBlock, setupProject } from "../src/setup.js";
import { parseReadme } from "../src/tracker.js";
import {
  fixtureGit,
  projectDirectory,
  removeRepo,
  tempRepo,
  write,
} from "./fixtures/helpers.js";

const BEGIN = "<!-- rimewire:begin -->";
const END = "<!-- rimewire:end -->";
const custom = {
  name: 'Northstar "Studio"',
  tracker: "planning/packages.md",
  idPattern: "NOVA_[0-9]+",
  branchPrefix: "feature",
  branchAliases: ["task"],
  journalDir: "var/local-updates",
  statuses: {
    done: ["released"],
    active: ["building"],
    planned: ["queued"],
    blocked: ["waiting"],
  },
  hooks: { enabled: false },
  roadmap: {
    platforms: [{ id: "shared", label: "Every platform", tokens: ["all"] }],
    fewRows: 0,
    milestones: [
      { id: "delivery", title: "Delivery", lane: "^Delivery", state: "next" },
    ],
  },
};
const agentFiles = [
  "AGENTS.md",
  "CLAUDE.md",
  "AGENTS.override.md",
  "CLAUDE.local.md",
  "GEMINI.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
  ".cursor/rules/project.md",
  ".cursor/rules/agent.mdc",
  "instructions/AI.md",
];

/** Capture directories and links too, so failed preflight cannot leave partial setup. */
function snapshot(root: string): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  function visit(directory: string) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const key = relative(root, path);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        entries[key] = { link: readlinkSync(path) };
      } else if (stat.isDirectory()) {
        entries[key] = { directory: true };
        visit(path);
      } else {
        entries[key] = {
          content: readFileSync(path),
          mode: stat.mode & 0o777,
          mtime: stat.mtimeMs,
        };
      }
    }
  }
  visit(root);
  return entries;
}

describe("project setup behavior", () => {
  let repo: string;
  let outside: string;
  beforeEach(() => {
    repo = tempRepo();
    outside = tempRepo();
  });
  afterEach(() => {
    removeRepo(repo);
    removeRepo(outside);
  });

  function read(path: string): string {
    return readFileSync(join(repo, path), "utf8");
  }

  async function cli(args: string[], input = "", cwd = repo) {
    const { main } = await import("../src/cli.js");
    let stdout = "";
    let stderr = "";
    let stdinReads = 0;
    const code = await main(args, {
      cwd,
      env: {},
      stdin: async () => {
        stdinReads++;
        return input;
      },
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });
    return { code, stdout, stderr, stdinReads };
  }

  function gitIgnored(paths: string[]): string[] {
    const result = spawnSync(
      "git",
      [
        "-c",
        "core.excludesFile=/dev/null",
        "check-ignore",
        "--no-index",
        "--stdin",
        "-z",
      ],
      { cwd: repo, encoding: "utf8", input: `${paths.join("\0")}\0` },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    return result.stdout.split("\0").filter(Boolean);
  }

  it("creates a custom project config and instructions without project-specific defaults", () => {
    const result = setupProject(repo, { config: custom });
    expect(result.config).toEqual(parseConfig(custom));
    expect(loadConfig(repo)).toEqual(result.config);
    expect(result.changed.sort()).toEqual(
      [
        ".rimewire/config.toml",
        custom.tracker,
        "AGENTS.md",
        "CLAUDE.md",
        ".gitignore",
      ].sort(),
    );
    expect(read(custom.tracker)).toContain(`# ${custom.name} board`);
    expect(existsSync(join(repo, "docs/board/README.md"))).toBe(false);
    expect(existsSync(join(repo, custom.journalDir))).toBe(false);
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const instructions = read(name);
      expect(instructions).toContain(custom.tracker);
      expect(instructions).toContain(custom.journalDir);
      for (const tool of [
        "board_overview",
        "get_package",
        "post_update",
        "list_updates",
        "board_url",
      ])
        expect(instructions).toContain(`\`${tool}\``);
      expect(instructions).toContain("Use real package IDs from the tracker");
      expect(instructions).toContain(
        "Session exit alone never establishes completion",
      );
      expect(instructions).toContain(
        "Never put secrets, credentials, or private prompt contents",
      );
    }
    expect(snapshot(repo)).not.toHaveProperty("GEMINI.md");
  });

  it("creates an empty tracker table without inventing package IDs", () => {
    const { config } = setupProject(repo);
    expect(config.name).toBe(basename(repo));
    const tracker = read(config.tracker);
    const rows = tracker.split("\n").filter((line) => line.startsWith("|"));
    expect(rows).toEqual([
      "| ID | Title | OS | Depends on | Status | Branch |",
      "|---|---|---|---|---|---|",
    ]);
    expect(
      parseReadme(tracker, config).lanes.flatMap((lane) => lane.items),
    ).toEqual([]);
    expect(read("AGENTS.md")).toContain("progress <id>");
    const before = snapshot(repo);
    expect(setupProject(repo).changed).toEqual([]);
    expect(snapshot(repo)).toEqual(before);
  });

  it.each([false, true])(
    "preserves existing tracker and commented TOML byte for byte (explicit config: %s)",
    (explicit) => {
      const toml = [
        "# Team-owned configuration; keep comments and formatting.",
        'name = "Existing project"',
        'tracker = "planning/packages.md"',
        "idPattern = 'NOVA_[0-9]+'",
        'branchPrefix = "delivery"',
        'journalDir = "var/local-updates"',
        "",
        "[statuses] # vocabulary chosen by this project",
        'done = ["released"]',
        "",
        "[roadmap]",
        "fewRows = 0",
        "platforms = []",
        "",
      ].join("\r\n");
      const tracker =
        "# Existing roadmap\r\n\r\n## Delivery\r\n\r\n| ID | Title | Status |\r\n|---|---|---|\r\n| NOVA_17 | Keep this scope | released |\r\n\r\nTeam notes stay here.\r\n";
      write(repo, ".rimewire/config.toml", toml);
      write(repo, custom.tracker, tracker);
      write(
        repo,
        "AGENTS.md",
        "# Existing agent policy\nFollow the team rules.\n",
      );
      write(repo, ".gitignore", "build/\n# Keep this comment\n");
      const current = loadConfig(repo);
      const before = snapshot(repo);
      const result = setupProject(repo, {
        config: explicit ? current : undefined,
      });
      expect(result.config).toEqual(current);
      expect(read(".rimewire/config.toml")).toBe(toml);
      expect(read(custom.tracker)).toBe(tracker);
      const after = snapshot(repo);
      for (const name of [".rimewire/config.toml", custom.tracker]) {
        expect(after[name]).toEqual(before[name]);
        expect(result.changed).not.toContain(name);
      }
      expect(
        read("AGENTS.md").startsWith(
          "# Existing agent policy\nFollow the team rules.\n",
        ),
      ).toBe(true);
      expect(
        read(".gitignore").startsWith("build/\n# Keep this comment\n"),
      ).toBe(true);
    },
  );

  it("updates an explicit customization while preserving tracker content and agent file permissions", () => {
    setupProject(repo, { config: custom });
    const tracker =
      "# Team plan\n\n## Delivery\n\n| ID | Title | Status |\n|---|---|---|\n| NOVA_17 | Existing work | queued |\n";
    write(repo, custom.tracker, tracker);
    const prefix = "# Team policy\n\n";
    const suffix = "\n\n# Local review rules\nKeep these instructions.\n";
    write(repo, "AGENTS.md", prefix + read("AGENTS.md").trimEnd() + suffix);
    chmodSync(join(repo, "AGENTS.md"), 0o600);
    const next = {
      ...custom,
      name: "Renamed project",
      journalDir: "cache/updates",
    };
    const result = setupProject(repo, { config: next });
    expect(loadConfig(repo)).toEqual(parseConfig(next));
    expect(read(custom.tracker)).toBe(tracker);
    expect(result.changed).not.toContain(custom.tracker);
    expect(read("AGENTS.md")).toBe(
      prefix + managedBlock(result.config) + suffix,
    );
    expect(lstatSync(join(repo, "AGENTS.md")).mode & 0o777).toBe(0o600);
    expect(read(".gitignore")).toContain(`/${custom.journalDir}/\n`);
    expect(read(".gitignore")).toContain(`/${next.journalDir}/\n`);
  });

  it.each(agentFiles)(
    "replaces only the managed block and reruns without changes in %s",
    (name) => {
      const prefix =
        "---\r\ndescription: Team rules\r\nalwaysApply: true\r\n---\r\n\r\n# Existing instructions\r\nUse the established style.\r\n\r\n";
      const suffix = "\r\n\r\n# Review policy\r\nDo not remove this.\r\n";
      write(
        repo,
        name,
        `${prefix}${BEGIN}\nObsolete board instructions\n${END}${suffix}`,
      );
      const options = { config: custom, agentFiles: ["instructions/AI.md"] };
      const result = setupProject(repo, options);
      expect(result.changed).toContain(name);
      const updated = read(name);
      expect(updated).toBe(prefix + managedBlock(result.config) + suffix);
      expect(updated.split(BEGIN)).toHaveLength(2);
      expect(updated.split(END)).toHaveLength(2);
      const before = snapshot(repo);
      expect(setupProject(repo, options).changed).toEqual([]);
      expect(snapshot(repo)).toEqual(before);
    },
  );

  it.each(["", "# Team policy", "# Team policy\n", "# Team policy\r\n"])(
    "appends a managed block without changing unrelated text %j",
    (text) => {
      write(repo, "AGENTS.md", text);
      setupProject(repo);
      const instructions = read("AGENTS.md");
      expect(instructions.slice(0, text.length)).toBe(text);
      expect(instructions.split(BEGIN)).toHaveLength(2);
      expect(instructions.split(END)).toHaveLength(2);
      const before = snapshot(repo);
      expect(setupProject(repo).changed).toEqual([]);
      expect(snapshot(repo)).toEqual(before);
    },
  );

  it("updates every existing agent file but leaves unrelated Cursor files alone", () => {
    for (const name of agentFiles) write(repo, name, `# Policy for ${name}\n`);
    write(repo, ".cursor/rules/notes.txt", "Not an agent rule.\n");
    write(
      repo,
      ".cursor/rules/archive/rule.md",
      "Nested rules are unrelated.\n",
    );
    const result = setupProject(repo, {
      config: custom,
      agentFiles: ["instructions/AI.md", "AGENTS.md", "instructions/AI.md"],
    });
    for (const name of agentFiles) {
      expect(result.changed.filter((path) => path === name)).toHaveLength(1);
      expect(read(name).startsWith(`# Policy for ${name}\n`)).toBe(true);
      expect(read(name).split(BEGIN)).toHaveLength(2);
    }
    expect(read(".cursor/rules/notes.txt")).toBe("Not an agent rule.\n");
    expect(read(".cursor/rules/archive/rule.md")).toBe(
      "Nested rules are unrelated.\n",
    );
    expect(
      setupProject(repo, { agentFiles: ["instructions/AI.md"] }).changed,
    ).toEqual([]);
  });

  it.each([
    ["missing end", `${BEGIN}\nunfinished`],
    ["missing begin", `unfinished\n${END}`],
    ["reversed", `${END}\nbackwards\n${BEGIN}`],
    ["duplicate blocks", `${BEGIN}\none\n${END}\n${BEGIN}\ntwo\n${END}`],
    ["duplicate begin", `${BEGIN}\n${BEGIN}\n${END}`],
    ["duplicate end", `${BEGIN}\n${END}\n${END}`],
  ])(
    "rejects %s markers in preflight without writing any target",
    (_label, markers) => {
      write(repo, "AGENTS.md", "# Preserve agent policy\n");
      write(repo, custom.tracker, "# Preserve tracker content\n");
      write(repo, ".gitignore", "# Preserve ignore rules\nbuild/\n");
      // Discovered after the defaults, so other planned writes must remain unapplied.
      write(repo, ".cursor/rules/last.mdc", markers);
      const before = snapshot(repo);
      expect(() => setupProject(repo, { config: custom })).toThrow(
        /managed markers/,
      );
      expect(snapshot(repo)).toEqual(before);
      expect(existsSync(join(repo, ".rimewire"))).toBe(false);
      expect(existsSync(join(repo, "CLAUDE.md"))).toBe(false);
    },
  );

  it("keeps an existing config untouched when a later agent block fails preflight", () => {
    setupProject(repo, { config: custom });
    write(repo, "GEMINI.md", `${BEGIN}\nUnclosed block\n`);
    const before = snapshot(repo);
    expect(() =>
      setupProject(repo, { config: { ...custom, name: "Changed" } }),
    ).toThrow(/managed markers/);
    expect(snapshot(repo)).toEqual(before);
  });

  it.each([
    { tracker: "../escaped.md" },
    { tracker: "planning/../../escaped.md" },
    { tracker: "planning\\..\\escaped.md" },
    { tracker: ".git/config" },
    { journalDir: "../updates" },
    { journalDir: "/tmp/updates" },
    { idPattern: "[" },
  ])("rejects invalid customization before writing files: %j", (config) => {
    write(repo, "AGENTS.md", "Keep this.\n");
    const before = snapshot(repo);
    expect(() => setupProject(repo, { config })).toThrow();
    expect(snapshot(repo)).toEqual(before);
  });

  it("rejects absolute tracker paths without touching the outside file", () => {
    write(outside, "tracker.md", "Outside tracker.\n");
    const before = snapshot(repo);
    const external = snapshot(outside);
    expect(() =>
      setupProject(repo, { config: { tracker: join(outside, "tracker.md") } }),
    ).toThrow();
    expect(snapshot(repo)).toEqual(before);
    expect(snapshot(outside)).toEqual(external);
  });

  it.each([
    ".rimewire/config.toml",
    "./.rimewire/config.toml",
    ".gitignore",
    "./.gitignore",
    "AGENTS.md",
    "CLAUDE.md",
  ])(
    "rejects tracker collision with %s without changing maintained files",
    (tracker) => {
      write(
        repo,
        ".rimewire/config.toml",
        '# Existing customization\nname = "Keep"\n',
      );
      write(repo, "AGENTS.md", "Existing policy.\n");
      write(repo, ".gitignore", "# Existing rules\nbuild/\n");
      const before = snapshot(repo);
      expect(() =>
        setupProject(repo, { config: { ...custom, tracker } }),
      ).toThrow(/separate/);
      expect(snapshot(repo)).toEqual(before);
    },
  );

  it.each([
    ".",
    "planning",
    "./planning",
    custom.tracker,
    ".rimewire",
    ".rimewire/config.toml",
    "AGENTS.md",
    "CLAUDE.md",
    "instructions",
    ".github",
    ".cursor",
    ".cursor/rules",
  ])(
    "rejects journal directory %s containing maintained project files before any writes",
    (journalDir) => {
      write(repo, ".rimewire/config.toml", 'name = "Keep"\n');
      write(repo, custom.tracker, "Existing tracker.\n");
      write(repo, "AGENTS.md", "Existing policy.\n");
      write(repo, "instructions/AI.md", "Additional policy.\n");
      write(repo, ".github/copilot-instructions.md", "Copilot policy.\n");
      write(repo, ".cursor/rules/project.mdc", "Cursor policy.\n");
      const before = snapshot(repo);
      expect(() =>
        setupProject(repo, {
          config: { ...custom, journalDir },
          agentFiles: ["instructions/AI.md"],
        }),
      ).toThrow(/journal directory/);
      expect(snapshot(repo)).toEqual(before);
    },
  );

  it.each(["planning/updates", ".rimewire/journal", "instructions-journal"])(
    "allows journal directory %s alongside maintained project files",
    (journalDir) => {
      fixtureGit(repo, "init", "--initial-branch=main");
      const result = setupProject(repo, {
        config: { ...custom, journalDir },
        agentFiles: ["instructions/AI.md"],
      });
      expect(result.config.journalDir).toBe(journalDir);
      const journal = `${journalDir}/notes.jsonl`;
      write(repo, journal, "{}\n");
      const ignored = gitIgnored([
        journal,
        custom.tracker,
        ".rimewire/config.toml",
        "AGENTS.md",
        "CLAUDE.md",
        "instructions/AI.md",
      ]);
      expect(ignored).toEqual([journal]);
    },
  );

  it.each([
    "../AGENTS.md",
    "instructions/../../AGENTS.md",
    "instructions\\..\\AGENTS.md",
    ".git/config",
    ".git\\config",
    "./.rimewire/config.toml",
    ".rimewire/config.toml",
    "planning/packages.md",
    "./planning/packages.md",
    ".gitignore",
    "./.gitignore",
  ])(
    "rejects escaping or overlapping agent target %s before any writes",
    (name) => {
      write(repo, "AGENTS.md", "Existing policy.\n");
      const before = snapshot(repo);
      expect(() =>
        setupProject(repo, { config: custom, agentFiles: [name] }),
      ).toThrow();
      expect(snapshot(repo)).toEqual(before);
    },
  );

  it("rejects an absolute additional agent path without modifying it", () => {
    write(outside, "AGENTS.md", "Outside policy.\n");
    const before = snapshot(repo);
    const external = snapshot(outside);
    expect(() =>
      setupProject(repo, { agentFiles: [join(outside, "AGENTS.md")] }),
    ).toThrow();
    expect(snapshot(repo)).toEqual(before);
    expect(snapshot(outside)).toEqual(external);
  });

  it.each([
    ".rimewire/config.toml",
    "planning/packages.md",
    "AGENTS.md",
    "instructions/AI.md",
    ".gitignore",
  ])(
    "rejects an existing or dangling symlink target %s without replacing it",
    (name) => {
      const destination = join(outside, "original.txt");
      write(outside, "original.txt", "Outside content.\n");
      mkdirSync(dirname(join(repo, name)), { recursive: true });
      for (const target of [destination, join(outside, "missing.txt")]) {
        if (existsSync(join(repo, name))) {
          // Move the first link aside to also exercise a dangling target in this fixture.
          renameSync(join(repo, name), join(repo, `${name}.previous`));
        }
        symlinkSync(target, join(repo, name));
        const before = snapshot(repo);
        const external = snapshot(outside);
        expect(() =>
          setupProject(repo, {
            config: custom,
            agentFiles: ["instructions/AI.md"],
          }),
        ).toThrow();
        expect(snapshot(repo)).toEqual(before);
        expect(snapshot(outside)).toEqual(external);
        expect(lstatSync(join(repo, name)).isSymbolicLink()).toBe(true);
      }
    },
  );

  it("rejects a direct symlink even when it points inside the project", () => {
    write(repo, "original-policy.md", "Keep this policy.\n");
    symlinkSync(join(repo, "original-policy.md"), join(repo, "AGENTS.md"));
    const before = snapshot(repo);
    expect(() => setupProject(repo)).toThrow();
    expect(snapshot(repo)).toEqual(before);
  });

  it.each([".rimewire", "planning", "instructions", ".cursor/rules"])(
    "rejects a directory symlink escape through %s before writing project files",
    (directory) => {
      write(outside, "rule.mdc", "Outside policy.\n");
      mkdirSync(dirname(join(repo, directory)), { recursive: true });
      symlinkSync(outside, join(repo, directory));
      const before = snapshot(repo);
      const external = snapshot(outside);
      expect(() =>
        setupProject(repo, {
          config: custom,
          agentFiles: ["instructions/AI.md"],
        }),
      ).toThrow();
      expect(snapshot(repo)).toEqual(before);
      expect(snapshot(outside)).toEqual(external);
    },
  );

  it("rejects a dangling directory symlink before applying any planned writes", () => {
    symlinkSync(join(outside, "missing-directory"), join(repo, "planning"));
    const before = snapshot(repo);
    const external = snapshot(outside);
    expect(() => setupProject(repo, { config: custom })).toThrow();
    expect(snapshot(repo)).toEqual(before);
    expect(snapshot(outside)).toEqual(external);
  });

  it.each([".rimewire", "planning", "instructions", "cache", ".cursor"])(
    "rejects a regular file ancestor %s in preflight without partial setup",
    (directory) => {
      write(repo, directory, "A file, not a directory.\n");
      const before = snapshot(repo);
      expect(() =>
        setupProject(repo, {
          config: { ...custom, journalDir: "cache/updates" },
          agentFiles: ["instructions/AI.md", ".cursor/rules/explicit.mdc"],
        }),
      ).toThrow();
      expect(snapshot(repo)).toEqual(before);
    },
  );

  it("rejects an existing regular file at the journal directory without modifying it", () => {
    write(repo, custom.journalDir, "Keep this file.\n");
    const before = snapshot(repo);
    expect(() => setupProject(repo, { config: custom })).toThrow();
    expect(snapshot(repo)).toEqual(before);
  });

  it.each(["\n", "\r", "\r\n"])(
    "rejects journal path line breaks %j before updating any files",
    (lineBreak) => {
      write(
        repo,
        ".rimewire/config.toml",
        '# Keep existing customization\nname = "Existing"\n',
      );
      write(repo, custom.tracker, "Existing tracker.\n");
      write(repo, "AGENTS.md", "Existing agent policy.\n");
      write(repo, ".gitignore", "# Keep existing ignore rules\nbuild/\n");
      const before = snapshot(repo);
      expect(() =>
        setupProject(repo, {
          config: {
            ...custom,
            journalDir: `cache/updates${lineBreak}another-rule`,
          },
        }),
      ).toThrow(/line break/);
      expect(snapshot(repo)).toEqual(before);
    },
  );

  it.each(["empty external", "empty internal", "dangling"])(
    "preflights a %s Cursor rules directory symlink even with no discoverable rule files",
    (kind) => {
      const target =
        kind === "empty external"
          ? outside
          : kind === "empty internal"
            ? join(repo, "actual-rules")
            : join(outside, "missing-directory");
      if (kind === "empty internal") mkdirSync(target);
      mkdirSync(join(repo, ".cursor"));
      symlinkSync(target, join(repo, ".cursor/rules"));
      const before = snapshot(repo);
      const external = snapshot(outside);
      expect(() => setupProject(repo, { config: custom })).toThrow();
      expect(snapshot(repo)).toEqual(before);
      expect(snapshot(outside)).toEqual(external);
    },
  );

  it("allows an ancestor symlink whose resolved target remains inside the project", () => {
    mkdirSync(join(repo, "docs"));
    symlinkSync(join(repo, "docs"), join(repo, "planning"));
    const result = setupProject(repo, { config: custom });
    expect(result.changed).toContain(custom.tracker);
    expect(read("docs/packages.md")).toBe(read(custom.tracker));
    expect(lstatSync(join(repo, "planning")).isSymbolicLink()).toBe(true);
    expect(setupProject(repo).changed).toEqual([]);
  });

  it.each([
    [".rimewire/journal", ".rimewire/journal-other"],
    ["cache/journal*", "cache/journal-extra"],
    ["cache/journal?", "cache/journala"],
    ["cache/journal[ab]", "cache/journala"],
    ["#updates", "updates"],
    ["!updates", "updates"],
    ["cache/local notes ", "cache/local notes"],
    ["cache/[!x]*?# notes ", "cache/yz# notes "],
  ])(
    "gitignores the literal journal directory %j without matching %j",
    (journalDir, sibling) => {
      fixtureGit(repo, "init", "--initial-branch=main");
      const originalIgnore =
        "# Existing project rules\r\nbuild/\r\n!important.txt";
      write(repo, ".gitignore", originalIgnore);
      setupProject(repo, { config: { journalDir } });
      const journal = `${journalDir}/notes.jsonl`;
      const unrelated = [
        `${sibling}/notes.jsonl`,
        `nested/${journalDir}/notes.jsonl`,
        "src/main.ts",
        ".rimewire/config.toml",
        "docs/board/README.md",
        "AGENTS.md",
        "CLAUDE.md",
        "important.txt",
      ];
      write(repo, journal, "{}\n");
      for (const path of unrelated) {
        if (
          ![
            ".rimewire/config.toml",
            "docs/board/README.md",
            "AGENTS.md",
            "CLAUDE.md",
          ].includes(path)
        )
          write(repo, path, "Keep tracked.\n");
      }
      expect(gitIgnored([journal, ...unrelated])).toEqual([journal]);
      expect(read(".gitignore").startsWith(originalIgnore)).toBe(true);
      const before = snapshot(repo);
      expect(setupProject(repo).changed).toEqual([]);
      expect(snapshot(repo)).toEqual(before);
    },
  );

  it.skipIf(process.platform === "win32")(
    "gitignores a literal backslash in a POSIX journal path",
    () => {
      fixtureGit(repo, "init", "--initial-branch=main");
      const journalDir = "cache\\updates";
      setupProject(repo, { config: { journalDir } });
      const journal = `${journalDir}/notes.jsonl`;
      write(repo, journal, "{}\n");
      expect(gitIgnored([journal, "cache/updates/notes.jsonl"])).toEqual([
        journal,
      ]);
    },
  );

  it("accepts CLI customization JSON from stdin and returns only changed-file JSON", async () => {
    const args = [
      "setup",
      "--repo",
      repo,
      "--config",
      "-",
      "--agent-file",
      "instructions/AI.md",
      "--agent-file",
      "instructions/review.md",
      "--json",
    ];
    const result = await cli(args, `${JSON.stringify(custom)}\n`, outside);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdinReads).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.config).toEqual(parseConfig(custom));
    expect(output.changed.sort()).toEqual(
      [
        ".gitignore",
        ".rimewire/config.toml",
        "AGENTS.md",
        "CLAUDE.md",
        "instructions/AI.md",
        "instructions/review.md",
        custom.tracker,
      ].sort(),
    );
    expect(loadConfig(repo)).toEqual(output.config);
    expect(read("instructions/AI.md")).toContain(BEGIN);
    expect(read("instructions/review.md")).toContain(BEGIN);
    expect(readdirSync(outside)).toEqual([]);
    const before = snapshot(repo);
    const repeated = await cli(args, JSON.stringify(custom), outside);
    expect(repeated.code).toBe(0);
    expect(JSON.parse(repeated.stdout).changed).toEqual([]);
    expect(snapshot(repo)).toEqual(before);
  });

  it.each(["{", "null", '{"tracker":"../escaped.md"}', '{"name":""}'])(
    "reports invalid CLI stdin JSON %j without writing setup files",
    async (input) => {
      write(repo, "AGENTS.md", "Existing policy.\n");
      const before = snapshot(repo);
      const result = await cli(["setup", "--config", "-", "--json"], input);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("rimewire:");
      expect(result.stdinReads).toBe(1);
      expect(snapshot(repo)).toEqual(before);
    },
  );

  it("resolves CLI config files and project paths relative to the supplied working directory", async () => {
    write(outside, "customizations/setup.json", JSON.stringify(custom));
    const result = await cli(
      [
        "setup",
        "--repo",
        relative(outside, repo),
        "--config",
        "customizations/setup.json",
        "--json",
      ],
      "",
      outside,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdinReads).toBe(0);
    expect(JSON.parse(result.stdout).config).toEqual(loadConfig(repo));
    expect(loadConfig(repo)).toEqual(parseConfig(custom));
  });

  it("quotes the plugin CLI fallback correctly and refreshes its path after a move", async () => {
    const plugin = join(outside, "plugin cache's [local]");
    const entry = join(plugin, "dist/setup.js");
    // Bundle only the helper: hook/skill production and the package build are independent.
    await bundle({
      entryPoints: [join(projectDirectory, "src/setup.ts")],
      outfile: entry,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      logLevel: "silent",
    });
    write(plugin, "package.json", '{"type":"module"}\n');
    // A sibling CLI probe records exactly which executable and arguments the shell received.
    write(
      plugin,
      "dist/cli.js",
      "process.stdout.write(JSON.stringify({entry:process.argv[1],args:process.argv.slice(2)}));\n",
    );
    const nodeBin = join(outside, "bin");
    mkdirSync(nodeBin);
    symlinkSync(process.execPath, join(nodeBin, "node"));
    const env = { ...process.env, PATH: nodeBin };

    function setup(entrypoint: string) {
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "const {setupProject}=await import(process.argv[1]); process.stdout.write(JSON.stringify(setupProject(process.argv[2],{config:JSON.parse(process.argv[3])})));",
          entrypoint,
          repo,
          JSON.stringify(custom),
        ],
        {
          cwd: outside,
          encoding: "utf8",
          env,
          timeout: 10_000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      return JSON.parse(result.stdout);
    }

    function runFallback(expectedEntry: string) {
      const instructions = read("AGENTS.md");
      const command = /substitute `(node [^`]+)` for it/.exec(
        instructions,
      )?.[1];
      expect(command).toBeDefined();
      const result = spawnSync("/bin/sh", ["-c", `${command} list --json`], {
        cwd: repo,
        encoding: "utf8",
        env,
        timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        entry: expectedEntry,
        args: ["list", "--json"],
      });
      return instructions;
    }

    setup(entry);
    const originalInstructions = runFallback(join(plugin, "dist/cli.js"));
    expect(originalInstructions).toContain("plugin cache");
    expect(originalInstructions).not.toContain(projectDirectory);
    const beforeTracker = read(custom.tracker);
    const moved = join(outside, "moved plugin's [local]");
    renameSync(plugin, moved);
    const result = setup(join(moved, "dist/setup.js"));
    expect(result.changed.sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(read(custom.tracker)).toBe(beforeTracker);
    const updatedInstructions = runFallback(join(moved, "dist/cli.js"));
    expect(updatedInstructions).toContain("moved plugin");
    expect(updatedInstructions).not.toBe(originalInstructions);
    expect(setup(join(moved, "dist/setup.js")).changed).toEqual([]);
  });
});
