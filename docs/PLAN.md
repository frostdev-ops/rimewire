# Rimewire plan

Status: draft, 2026-10-04.

## Goal

Rimewire is a project board that agents keep up to date. A user installs it into their agent
harness once. From then on:

1. Whenever the harness is running, the Rimewire MCP server is running, and the local web board
   is reachable in a browser (127.0.0.1 only).
2. The first time Rimewire is used in a project, a bundled **setup skill** has the model customize
   the board for that project. The model then edits the project's agent instruction file, so every
   agent and subagent in the project knows to use the board and keep it updated.

Rimewire ships generic. Nothing in the package is specific to Crosspane or any other project; each
project's customization lives in that project.

## User flow

```
install (once per machine and harness)
  └─ harness starts → harness launches `rimewire mcp` (stdio)
                         └─ starts the board web server, or connects to one already running
first use in a project
  └─ the agent runs the setup skill (`rimewire-setup`)
       ├─ reads the project: docs, existing trackers, branches, worktrees, agent files
       ├─ writes .rimewire/config.toml (tracker path, ID pattern, branch convention, statuses, name)
       ├─ creates or adapts the tracker document
       ├─ gitignores the project's journal directory
       └─ adds a managed Rimewire block to AGENTS.md / CLAUDE.md (and any other agent files)
every session after that
  └─ agents read the board and post updates through MCP tools (or the CLI); the board updates live
```

## Architecture

### Core (harness-independent)

The core is a TypeScript package, `rimewire`, running on Node.js (current LTS). It uses official
packages where they exist, such as `@modelcontextprotocol/sdk` for MCP, and well-maintained external
libraries where they save real code, for example a TOML parser and schema validation. The pieces
are ported from the Python `wp-board/`, which stays in the repository as the behavioral reference
until the port reaches parity:

| Module | Origin | Role |
|---|---|---|
| `config` | new | Loads `.rimewire/config.toml`; defaults reproduce generic behavior |
| `tracker` | `board.py` | Parses the Markdown tracker and its spec files, and classifies statuses |
| `gitinfo` | `board.py` | Read-only discovery of branches and worktrees, with timeouts |
| `journal` | `journal.py` | Append-only JSONL updates, one journal per checkout, merged by time |
| `server` | `serve.py` | Web board and JSON API; serves `static/` |
| `mcp` | new | MCP server over stdio, built on `@modelcontextprotocol/sdk` |
| `cli` | `wp-note` | `rimewire note/progress/blocker/unblock/ready/list`, `serve`, `mcp`, `install` |

Each item in the Crosspane-specific list below becomes a config key with a generic default:

- tracker path: `docs/wp/README.md` → default `docs/board/README.md`, configurable
- package-file ID regex (`PACKAGE_FILE`) → default `[A-Za-z][A-Za-z0-9._-]*`, configurable
- branch convention: `wp/<id>-…` → default `<prefix>/<id>-…` with a configurable prefix
- the status vocabulary used by `classify()` → a default mapping, extendable per project
- journal directory: `target/wp-notes/` → default `.rimewire/journal/`, configurable (Crosspane
  keeps `target/wp-notes/`). Journals stay inside each checkout, never in the main repo or the
  user state directory: sandboxed shells can write only under their own worktree, and they cannot
  reach the board over 127.0.0.1 (Claude Code's Linux sandbox gives commands a private localhost;
  Codex blocks loopback by default). The CLI fallback therefore appends to the local journal file
  and never calls the HTTP API.
- branding: `BRAND_FILES` and the Crosspane name → project name and optional logo from config;
  Rimewire's own branding otherwise

### Update provenance

`ready` is the completion signal: an explicit `ready` update from an agent or a person marks the
package done. Every journal entry records where it came from: the `source` field is one of `mcp`, `cli`,
`hook:<event>`, or `web`, alongside the existing author and time fields. Hooks may post progress
notes. A hook must never mark a package `ready` or done because a session or process exited; only
an explicit agent or human action can do that.

### MCP surface (first version)

| Tool | Purpose |
|---|---|
| `board_overview` | Phases, packages, status counts, active work, open blockers |
| `get_package` | One package: spec summary, status, branch/worktree, recent updates |
| `post_update` | `note`, `progress` (with percent), `blocker`, `unblock`, `ready` |
| `list_updates` | Recent updates, optionally for one package |
| `board_url` | URL of the running web board for this project |

Contract tests cover tool schemas, validation errors, and journal effects.

### Process lifecycle: MCP server and web board

Harnesses start one MCP process per session, so several may run at once, in several projects and
worktrees. The web board is therefore a single shared process:

- `rimewire mcp` starts and registers its project root (resolving worktrees to the main repo).
  Then it checks the lock file in the per-user state directory
  (`$XDG_STATE_HOME/rimewire/`, or the platform equivalent).
- After the MCP handshake (never before, so harness startup timeouts are not spent on it), if no
  board server is alive, it spawns `rimewire serve --daemon` fully detached (new session via
  `setsid`, inherited file descriptors closed), bound to 127.0.0.1 on
  the configured port (default 8737, with fallback to the next free port), and records the PID and
  port in the lock file.
- The board server serves every registered project (a project switcher in the UI;
  `/p/<project>/` URLs). MCP processes send heartbeats; when none have arrived for a set idle
  period, the server exits.
- `board_url` and the setup skill tell the user where the board is.

This keeps "MCP running ⇒ board reachable" true without a system service, and survives sessions
closing in any order. Harnesses tear MCP servers down differently: Codex and Pi signal the whole
process group, and Claude Code can leave grandchildren orphaned. So the daemon must not share the
MCP process group, and the MCP process must not rely on stdin EOF to notice shutdown; heartbeats
and idle exit cover both cases.

Harness MCP startup timeouts are short (Codex 10 s, OpenCode 5 s, Pi waits up to 10 s on the first
prompt). A cold `npx` download can exceed them, so `rimewire install` installs the package globally
and registers a bare `rimewire mcp` command, raising the timeout where the harness allows it.

### Harness adapters

Adapters are thin. Each one registers the MCP server, installs the setup skill, and optionally
installs hooks. All adapters share the same core and the same skill text.

Researched 2026-10-04 (Codex 0.160.0, OpenCode 1.18.34, Pi 1.0.2); re-check when each adapter is
built.

| Harness | MCP registration | Skill | Hooks | Packaging |
|---|---|---|---|---|
| Claude Code | Plugin `.mcp.json`; tools appear as `mcp__plugin_rimewire_rimewire__<tool>` | Plugin `skills/`, invoked as `/rimewire:rimewire-setup` | Plugin `hooks/hooks.json`: `SessionStart`, `SessionEnd`, `Stop`, `SubagentStop`, `PostToolUse`; `http` hooks can post to the board directly | Plugin + marketplace (`.claude-plugin/plugin.json`, `marketplace.json`) |
| Codex | `[mcp_servers.rimewire]` in `~/.codex/config.toml` (project `.codex/config.toml` only in trusted projects); raise `startup_timeout_sec` | `~/.agents/skills/` or `.agents/skills/` | Same JSON format and events as Claude Code, but each hook must be trusted through `/hooks` before it runs; `SessionEnd` has a 1 s timeout | Plugins; the loader appears to accept the Claude plugin layout (unverified end to end) |
| OpenCode | `mcp` in `opencode.json` (`"type": "local"`, `command` as an array, `timeout` default 5000 ms); tools appear as `rimewire_<tool>` | Reads `.opencode/skills`, `.claude/skills`, `.agents/skills` and their global equivalents | npm plugin: `session.created`, `session.idle`, `tool.execute.after`; no session-end or subagent-stop event (a subagent ending is `session.idle` on a child session) | npm plugin listed in the `plugin` config array; no manifest or marketplace |
| Pi | Built-in MCP: `~/.pi/agent/mcp.json` or `.pi/mcp.json` (trusted projects), `mcpServers` format; must set `"exposure": "direct"` or the tools are hidden from the model | `~/.agents/skills/`, `.agents/skills/`, `~/.pi/agent/skills/` | TypeScript extension: `session_start`, `session_shutdown`, `agent_end`, `tool_result`; Pi has no subagents | `pi install npm:rimewire` with a `pi` key in `package.json` (skill + extension) |

Consequences for the adapters:

- `~/.agents/skills/rimewire-setup/` serves Codex, OpenCode and Pi; Claude Code gets the skill from
  its plugin. Skill frontmatter stays portable: a lowercase-hyphen `name` equal to the directory
  name, and a `description` of at most 1024 characters.
- Tool names differ per harness, so the skill and the managed block refer to tools by bare name
  (`post_update`), never by a harness prefix.
- Try one plugin directory that serves both Claude Code and Codex before building a separate Codex
  plugin.
- Codex subagents may not receive the parent's stdio MCP tools (openai/codex#16475), which makes
  the CLI fallback necessary there, not just a convenience.
- Hook coverage is uneven, so hooks stay optional and post only notes and progress; completion
  always comes from an explicit `ready`.

`rimewire install <harness> [--project|--user]` writes these entries idempotently, and
`rimewire uninstall <harness>` removes exactly what it wrote.

The shipped plugin and skill files live under `plugins/` and `skills/`. This repository's root
`.gitignore` ignores only root-level agent files, so it does not catch them.

### Setup skill (`rimewire-setup`)

The skill is one source file, rendered for each harness. It instructs the model to:

1. Confirm that the MCP server is reachable (`board_url`) and give the user the board URL.
2. Survey the project: existing roadmaps and trackers, docs layout, branch naming, worktrees,
   agent files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursor/rules`, and others).
3. Propose a customization: tracker location, ID scheme, phases, status words, branch convention,
   and display name. It asks only about choices it cannot infer, then writes
   `.rimewire/config.toml`.
4. Create the tracker from a template, or adapt an existing one, without losing content.
5. Add the journal directory to the project's `.gitignore`.

   Sandboxed models usually cannot write harness config (`.mcp.json`, `.claude/`, `.codex/`,
   `.agents/`, `.git`). When a step needs one of those, the skill asks the user to run
   `rimewire install` or to approve the write outside the sandbox.
6. Insert or update a managed block between `<!-- rimewire:begin -->` and `<!-- rimewire:end -->`
   in each agent file. The block tells every agent and subagent to:
   - read the board before starting work
   - post `progress`, `blocker`, and `ready` updates with real content
   - use the CLI when MCP is unavailable (for example, sandboxed workers or Codex subagents)
   - never put secrets or private prompt contents in updates

   Re-running the skill replaces only the managed block. The block goes in every agent file that
   exists, because harnesses disagree on which one they read: Claude Code reads `AGENTS.md` only
   when there is no `CLAUDE.md`, Codex reads only `AGENTS.md` (32 KiB cap), OpenCode uses the first
   match, and Pi reads both. Where `CLAUDE.md` can import `AGENTS.md` (`@AGENTS.md`), one block in
   `AGENTS.md` is enough.
7. Show a summary of every file changed.

### Distribution

The core is published to npm, runnable with `npx rimewire` or a global install. The Claude Code
plugin's `.mcp.json` launches it through `npx`. Adapters for the other harnesses are installed with
`rimewire install`. Everything stays local: there is no cloud service and no LLM API.

## Phases

### Phase 0: repository setup (done 2026-10-04)

- `wp-board/` copied unchanged from Crosspane; 32 of 38 tests pass here (the other 6 read
  Crosspane's `docs/wp/`)
- Git repository initialized; root agent files are gitignored
- This plan

### Phase 1: port and generalize the core

- Set up the TypeScript project: `package.json`, `tsconfig.json`, a test runner, a linter and
  formatter, and `src/` layout
- Port `board.py`, `journal.py`, `serve.py` and `wp-note` to TypeScript, with `config.toml` loading
  replacing every Crosspane-specific value
- Port the Python test cases as fixtures-based tests. Keep one opt-in test that runs against a real
  Crosspane checkout through a Crosspane config
- Parity check: for the same inputs, the TypeScript board's JSON output matches the Python board's
- Journal format stays compatible with existing `notes.jsonl` files; add the `source` field,
  readable alongside entries that lack it
- Reuse `static/` with generic branding
- Remove `wp-board/` once parity holds

Exit: all tests pass from fixtures, and the board renders Crosspane identically when given a
Crosspane config.

### Phase 2: MCP server

- Stdio MCP server on `@modelcontextprotocol/sdk` with the tools listed above
- Contract tests through the SDK's in-memory client/server transport

Exit: tools work from Claude Code via a manual `.mcp.json` entry.

### Phase 3: board lifecycle

- Lock file, detached daemon, project registry, heartbeats, idle shutdown, multi-project UI

Exit: start two sessions in two projects, close them in either order, and the board stays up
until the last one ends plus the idle period.

### Phase 4: Claude Code plugin and setup skill

- Plugin manifest, `.mcp.json`, `rimewire-setup` skill, optional hooks
- Marketplace entry for installation

Exit: on a clean machine, install the plugin, open a fresh project, run the skill, and get a
customized board plus updated agent files; a subagent posts an update that appears live.

### Phase 5: other harnesses

- Codex, OpenCode, then Pi adapters, plus `rimewire install/uninstall`

### Phase 6: Crosspane migration

- A Crosspane config that reproduces its current board; switch Crosspane's agents to Rimewire's
  MCP tools and CLI; retire `scripts/wp-board/` only once it is no longer used

## Decisions

- 2026-10-04: an explicit `ready` update marks a package done; no separate human confirmation.
- 2026-10-04: the tracker is a Markdown document in the project's repository, at a configurable
  path.
- 2026-10-04: one shared board server for all projects, with a project switcher.
- 2026-10-04: TypeScript on Node.js, using official packages and external libraries, replacing the
  Python stdlib approach.
- 2026-10-04: Pi is supported through its built-in MCP (with `"exposure": "direct"`), not a
  CLI-only fallback.

## Open questions

- Does a Codex plugin load the Claude plugin layout unchanged, and which MCP file name does it use
  (`.mcp.json` or `mcp.json`)?
- Is openai/codex#16475 (subagents missing stdio MCP tools) fixed by the time Phase 5 starts?
- Can an OpenCode plugin register its own MCP server and skill path through the `config` hook, so
  one npm package covers OpenCode the way the plugin covers Claude Code?
