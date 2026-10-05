#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { type Config, loadConfig } from "./config.js";
import { worktrees } from "./gitinfo.js";
import { append, make, readAll } from "./journal.js";
import { createBoardServer } from "./server.js";

export interface CliContext {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: () => Promise<string>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export function findCheckout(start: string): string {
  let dir = realpathSync(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error(
        "run this inside the repository or one of its worktrees (or pass --checkout)",
      );
    dir = parent;
  }
}

export function mainRepo(checkout: string): string {
  const dotGit = join(checkout, ".git");
  if (!existsSync(dotGit) || !statSync(dotGit).isFile()) return checkout;
  const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
  if (!match?.[1]) return checkout;
  const gitdir = resolve(checkout, match[1].trim());
  const common = join(gitdir, "commondir");
  if (existsSync(common)) {
    const path = resolve(gitdir, readFileSync(common, "utf8").trim());
    if (basename(path) === ".git") return dirname(path);
  }
  if (basename(dirname(gitdir)) === "worktrees")
    return dirname(dirname(dirname(gitdir)));
  return checkout;
}

function known(wp: string, roots: string[], config: Config): boolean {
  const escaped = wp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![A-Za-z0-9._-])${escaped}(?![A-Za-z0-9._-])`);
  for (const root of new Set(roots)) {
    const tracker = resolve(root, config.tracker);
    if (existsSync(join(dirname(tracker), `${wp}.md`))) return true;
    try {
      if (pattern.test(readFileSync(tracker, "utf8"))) return true;
    } catch {
      /* A worker can post before its tracker is committed. */
    }
  }
  return false;
}

function integer(value: string): number {
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new InvalidArgumentError("must be a whole number");
  return Number(value);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer.exe"
        : "xdg-open";
  const child = spawn(command, [url], { detached: true, stdio: "ignore" });
  child.on("error", () => {
    /* The printed URL remains usable without a browser opener. */
  });
  child.unref();
}

/** CLI updates append to the current checkout; no HTTP request or external write is needed. */
export async function main(
  argv = process.argv.slice(2),
  context: CliContext = {},
): Promise<number> {
  const cwd = context.cwd ?? process.cwd();
  const env = context.env ?? process.env;
  const stdout =
    context.stdout ??
    ((text: string) => {
      process.stdout.write(text);
    });
  const stderr =
    context.stderr ??
    ((text: string) => {
      process.stderr.write(text);
    });
  const input = context.stdin ?? readStdin;
  let exitCode = 0;
  const program = new Command("rimewire")
    .description("Local project board and checkout journal")
    .exitOverride()
    .configureOutput({ writeOut: stdout, writeErr: stderr });

  function checkoutInfo(options: { checkout?: string }) {
    const checkout = options.checkout
      ? realpathSync(resolve(cwd, options.checkout))
      : findCheckout(cwd);
    const repo = mainRepo(checkout);
    const config = loadConfig(
      existsSync(join(checkout, ".rimewire", "config.toml")) ? checkout : repo,
    );
    return { checkout, repo, config };
  }

  for (const [kind, about] of [
    ["note", "a free-form note"],
    ["progress", "how far along the package is"],
    ["blocker", "work is stopped; say what is needed"],
    ["unblock", "the blocker is resolved"],
    ["ready", "done and ready for review"],
  ] as const) {
    const command = program
      .command(kind)
      .description(about)
      .argument("<wp>", "work-package id")
      .argument("[words...]", "update text; '-' reads stdin")
      .option("--text <text>", "update text; '-' reads stdin")
      .option(
        "--author <name>",
        "posting author (default $RIMEWIRE_AGENT or checkout name)",
      )
      .option(
        "--checkout <path>",
        "checkout to write to (default: the one containing cwd)",
      )
      .option("--json", "machine-readable output");
    if (kind === "progress" || kind === "ready")
      command.option("-p, --percent <percent>", "0-100", integer);
    command.action(
      async (
        wp: string,
        words: string[],
        options: {
          text?: string;
          author?: string;
          checkout?: string;
          json?: boolean;
          percent?: number;
        },
      ) => {
        const { checkout, repo, config } = checkoutInfo(options);
        if (options.text !== undefined && words.length)
          throw new Error("use either --text or positional update text");
        let text = options.text ?? words.join(" ");
        if (text === "-") text = await input();
        if (
          kind === "progress" &&
          options.percent === undefined &&
          !text.trim()
        )
          throw new Error("a progress update needs --percent, text, or both");
        const author =
          options.author ||
          env.RIMEWIRE_AGENT ||
          (checkout !== repo ? basename(checkout) : env.USER || "lead");
        const note = make(
          wp,
          kind,
          text,
          options.percent ?? null,
          author,
          "cli",
          config,
        );
        if (!known(note.wp, [checkout, repo], config))
          stderr(
            `rimewire: warning: ${note.wp} is not in ${config.tracker} or its spec directory (posted anyway)\n`,
          );
        let path: string;
        try {
          path = append(checkout, note, config);
        } catch (error) {
          stderr(
            `rimewire: could not write the journal: ${error instanceof Error ? error.message : "unavailable"}\n`,
          );
          exitCode = 1;
          return;
        }
        if (options.json) stdout(`${JSON.stringify(note)}\n`);
        else {
          const pct = note.percent === null ? "" : ` (${note.percent}%)`;
          const rel = relative(repo, path);
          const where = isAbsolute(rel) || rel.startsWith("..") ? path : rel;
          stdout(
            `rimewire: ${note.kind} on ${note.wp}${pct} as ${note.author} -> ${where}\n`,
          );
        }
      },
    );
  }

  for (const action of ["install", "uninstall"] as const) {
    program
      .command(action)
      .description(`${action} Rimewire in Codex, OpenCode, or Pi`)
      .argument("<harness>", "codex, opencode, or pi")
      .option("--project", "register in the current project")
      .option("--user", "register for the current user (default)")
      .option("--hooks", "install optional Codex hooks (requires /hooks trust)")
      .option("--json", "machine-readable result")
      .action(
        async (
          harness: string,
          options: {
            project?: boolean;
            user?: boolean;
            hooks?: boolean;
            json?: boolean;
          },
        ) => {
          if (options.project && options.user)
            throw new Error("choose either --project or --user");
          const { installHarness, uninstallHarness } = await import(
            "./install.js"
          );
          const result = (
            action === "install" ? installHarness : uninstallHarness
          )(harness as import("./install.js").Harness, {
            cwd,
            env,
            scope: options.project ? "project" : "user",
            hooks: options.hooks,
          });
          if (options.json) stdout(`${JSON.stringify(result)}\n`);
          else {
            for (const path of result.changed) stdout(`${action}: ${path}\n`);
            for (const instruction of result.instructions)
              stdout(`${instruction}\n`);
          }
        },
      );
  }

  program
    .command("list")
    .description("show recent updates from every checkout")
    .argument("[wp]", "only this work package")
    .option("-n, --limit <count>", "how many (0 for all)", integer, 20)
    .option(
      "--checkout <path>",
      "checkout to read (default: the one containing cwd)",
    )
    .option("--json", "machine-readable output")
    .action(
      (
        wp: string | undefined,
        options: { checkout?: string; json?: boolean; limit: number },
      ) => {
        const { checkout, repo, config } = checkoutInfo(options);
        const checkouts = [
          checkout,
          ...worktrees(repo).map((tree) => tree.path),
        ];
        let notes = readAll(repo, checkouts, config).filter(
          (note) => !wp || note.wp === wp,
        );
        if (options.limit > 0) notes = notes.slice(-options.limit);
        if (options.json) {
          stdout(`${JSON.stringify(notes, null, 1)}\n`);
          return;
        }
        if (!notes.length) stdout("No updates yet.\n");
        for (const note of notes) {
          const when = new Date(note.time * 1000).toLocaleString();
          const kind =
            note.kind + (note.percent === null ? "" : ` ${note.percent}%`);
          const [first = "", ...rest] = note.text.split(/\r?\n/);
          stdout(
            `${when}  ${note.wp.padEnd(12)} ${kind.padEnd(13)} ${note.author} (${note.source})  ${first}\n`,
          );
          for (const line of rest) stdout(`${" ".repeat(50)}${line}\n`);
        }
      },
    );

  program
    .command("setup")
    .description(
      "initialize project config, tracker, and managed agent instructions",
    )
    .option("--repo <path>", "project directory (default: current directory)")
    .option("--config <file>", "customization JSON file, or - for stdin")
    .option(
      "--agent-file <path>",
      "additional project agent file",
      (value: string, all: string[]) => [...all, value],
      [],
    )
    .option("--json", "show changed files as JSON")
    .action(
      async (options: {
        repo?: string;
        config?: string;
        agentFile: string[];
        json?: boolean;
      }) => {
        const { setupProject } = await import("./setup.js");
        const config =
          options.config === undefined
            ? undefined
            : JSON.parse(
                options.config === "-"
                  ? await input()
                  : readFileSync(resolve(cwd, options.config), "utf8"),
              );
        const result = setupProject(resolve(cwd, options.repo ?? "."), {
          config,
          agentFiles: options.agentFile,
        });
        stdout(
          options.json
            ? `${JSON.stringify(result)}\n`
            : `Rimewire setup: ${result.changed.length ? result.changed.join(", ") : "already configured"}\n`,
        );
      },
    );

  program
    .command("hook")
    .description("handle an optional harness event from JSON stdin")
    .argument("<event>", "hook event")
    .action(async (event: string) => {
      try {
        const { runHook } = await import("./hooks.js");
        const context = await runHook(event, JSON.parse(await input()));
        if (context)
          stdout(
            `${JSON.stringify({ hookSpecificOutput: { hookEventName: event.startsWith("Codex") ? event.slice(5) : event, additionalContext: context } })}\n`,
          );
      } catch {
        // Parser diagnostics can contain private fragments of a malformed payload.
        stderr(
          "rimewire: hook skipped (invalid input or unavailable project)\n",
        );
      }
    });

  program
    .command("mcp")
    .description("run the stdio MCP server and local web board")
    .option("--repo <path>", "checkout to use (default: current repository)")
    .option(
      "--port <port>",
      "preferred board port (0 chooses a free port)",
      integer,
      8737,
    )
    .action(async (options: { repo?: string; port: number }) => {
      if (options.port < 0 || options.port > 65535)
        throw new Error("port must be 0 to 65535");
      const checkout = findCheckout(
        options.repo ? resolve(cwd, options.repo) : cwd,
      );
      const { runMcp } = await import("./mcp-runtime.js");
      await runMcp(checkout, options.port);
    });

  program
    .command("serve")
    .option("--daemon", "run the shared multi-project board daemon")
    .description("serve the local board on 127.0.0.1")
    .option("--repo <path>", "repository to read (default: current repository)")
    .option("--port <port>", "port (0 chooses a free port)", integer, 8737)
    .option(
      "--interval <seconds>",
      "seconds between change polls",
      (value) => {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds <= 0)
          throw new InvalidArgumentError("must be a positive number");
        return seconds;
      },
      1,
    )
    .option("--open", "open the board in a browser")
    .action(
      async (options: {
        repo?: string;
        daemon?: boolean;
        port: number;
        interval: number;
        open?: boolean;
      }) => {
        if (options.port < 0 || options.port > 65535)
          throw new Error("port must be 0 to 65535");
        if (options.daemon) {
          const { runDaemon } = await import("./daemon.js");
          await runDaemon(options.port);
          return;
        }
        const repo = mainRepo(
          options.repo
            ? realpathSync(resolve(cwd, options.repo))
            : findCheckout(cwd),
        );
        const server = createBoardServer(repo, {
          pollInterval: options.interval * 1000,
        });
        try {
          await new Promise<void>((resolveStarted, reject) => {
            server.once("error", reject);
            server.listen(options.port, "127.0.0.1", () => {
              server.off("error", reject);
              resolveStarted();
            });
          });
        } catch (error) {
          server.close();
          const message =
            (error as NodeJS.ErrnoException).code === "EADDRINUSE"
              ? `port ${options.port} is already in use; open http://127.0.0.1:${options.port}/ or use --port N`
              : error instanceof Error
                ? error.message
                : "could not start the board";
          stderr(`rimewire: ${message}\n`);
          exitCode = 1;
          return;
        }
        const address = server.address();
        const port =
          address && typeof address !== "string" ? address.port : options.port;
        const url = `http://127.0.0.1:${port}/`;
        stdout(
          `${server.state.config.name} work-package board: ${url} (watching ${server.state.config.tracker})\n`,
        );
        if (options.open) openBrowser(url);
        await new Promise<void>((done) => {
          const stop = () => {
            server.close();
          };
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
          server.once("close", () => {
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
            done();
          });
        });
      },
    );

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError)
      return error.code === "commander.helpDisplayed" ? 0 : 2;
    stderr(
      `rimewire: ${error instanceof Error ? error.message : "command failed"}\n`,
    );
    return 2;
  }
  return exitCode;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main();
}
