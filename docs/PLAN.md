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
  keeps `target/wp-notes/`)
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
- If no board server is alive, it spawns `rimewire serve --daemon` detached, bound to 127.0.0.1 on
  the configured port (default 8737, with fallback to the next free port), and records the PID and
  port in the lock file.
- The board server serves every registered project (a project switcher in the UI;
  `/p/<project>/` URLs). MCP processes send heartbeats; when none have arrived for a set idle
  period, the server exits.
- `board_url` and the setup skill tell the user where the board is.

This keeps "MCP running ⇒ board reachable" true without a system service, and survives sessions
closing in any order.

### Harness adapters

Adapters are thin. Each one registers the MCP server, installs the setup skill, and optionally
installs hooks. All adapters share the same core and the same skill text.

| Harness | MCP registration | Skill | Optional hooks |
|---|---|---|---|
| Claude Code | Plugin (`.claude-plugin/plugin.json` + `.mcp.json`), installable from a marketplace repo | Plugin `skills/` | Plugin `hooks/` (SessionStart, Stop, SubagentStop) |
| Codex | `[mcp_servers.rimewire]` in `~/.codex/config.toml` | Codex skills directory | Verify what Codex offers |
| OpenCode | `mcp` entry in `opencode.json` | OpenCode skills/agents | OpenCode plugin events |
| Pi | Verify MCP support; fall back to the `rimewire` CLI | Pi skill/extension | Pi extension |

`rimewire install <harness> [--project|--user]` writes these entries idempotently, and
`rimewire uninstall <harness>` removes exactly what it wrote. Each harness's file locations and
formats must be checked against its current documentation when its adapter is built.

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
6. Insert or update a managed block between `<!-- rimewire:begin -->` and `<!-- rimewire:end -->`
   in each agent file. The block tells every agent and subagent to:
   - read the board before starting work
   - post `progress`, `blocker`, and `ready` updates with real content
   - use the CLI when MCP is unavailable (for example, sandboxed workers)
   - never put secrets or private prompt contents in updates

   Re-running the skill replaces only the managed block.
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

## Open questions

- Pi: confirm whether it supports MCP, or rely on the CLI (harness research in progress).
