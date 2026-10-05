<p align="center">
  <img src="assets/brand/rimewire-banner.png" alt="Rimewire — crystalline Frostdev logo" width="960">
</p>

<p align="center">
  <strong>Your agents. One shared picture of the work.</strong><br>
  A local MCP server and live project board for plans, progress, blockers, and review handoffs.
</p>

<p align="center">
  <a href="#install">Get started</a> ·
  <a href="docs/CONFIGURATION.md">Customize your board</a> ·
  <a href="docs/INSTALLATION.md">Harness setup</a> ·
  <a href="https://github.com/frostdev-ops/rimewire/issues">Report an issue</a>
</p>

<p align="center">
  <a href="https://github.com/frostdev-ops/rimewire/actions/workflows/check.yml"><img src="https://github.com/frostdev-ops/rimewire/actions/workflows/check.yml/badge.svg" alt="Checks"></a>
  <img src="https://img.shields.io/badge/runtime-Node.js%2024%2B-89cbd5" alt="Node.js 24+">
  <img src="https://img.shields.io/badge/data-local-89cbd5" alt="Local project data">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--or--later-89cbd5" alt="GPL-3.0-or-later"></a>
</p>

## Keep the work in view

When several agents work across sessions and Git worktrees, progress gets scattered. Rimewire puts the project's tracker, active branches, updates, blockers, and handoffs on one live board. Agents read and update it through MCP; you follow along in your browser.

Install it into your harness, then run the bundled setup skill. The agent adapts the board to your project's tracker, package IDs, phases, status vocabulary, and branch conventions. It adds managed instructions to your project's agent files so future agents and subagents keep the board current.

Rimewire is part of [Frostdev](https://frostdev.io), alongside [Rimeward](https://github.com/frostdev-ops/rimeward), [Frostsim](https://github.com/frostdev-ops/frostsim), and [Crosspane](https://github.com/frostdev-ops/crosspane).

## What you can do

| | In Rimewire |
| --- | --- |
| **Follow the project** | See phases, work packages, progress, dependencies, and open blockers on a live web board. |
| **Coordinate agents** | Read specs and recent updates, post progress, and leave review handoffs through five MCP tools. |
| **Work across checkouts** | Merge checkout-local journals into a shared view of branches and Git worktrees. |
| **Make it yours** | Configure tracker paths, IDs, statuses, milestones, project name, and branding. |
| **Keep data local** | Run on your machine, with the web server bound to `127.0.0.1`. Rimewire needs no cloud service or model API. |
| **Use your harness** | Integrate with Claude Code, Codex, OpenCode, and Pi. Sandboxed workers can use the local CLI. |

Completion is explicit: an agent or person posts `ready` after the work and checks pass. Session exit and optional activity hooks never establish completion. Later progress or a blocker reopens the package.

## Install

Requires **Node.js 24+** and npm. Install from source:

```sh
git clone https://github.com/frostdev-ops/rimewire.git
cd rimewire
npm ci
npm run build
npm install --global .
```

Keep the built checkout available: harness registrations use absolute paths to the installed runtime. Rebuild and rerun registration after updating or moving it. A packaged alternative is `npm pack`, followed by `npm install --global ./rimewire-0.1.0.tgz`. This repository's publication does not imply an npm registry release.

### Codex, OpenCode, or Pi

Run the command for your harness:

```sh
rimewire install codex --user
rimewire install opencode --user
rimewire install pi --user
```

Restart the harness in your project and ask it to run **`rimewire-setup`**. The skill surveys the project, creates or adapts the tracker, writes `.rimewire/config.toml`, and updates managed agent instructions. Ask for **`board_url`** to open your board.

Use `--project` instead of `--user` for a checkout-specific installation. See the [installation guide](docs/INSTALLATION.md) for configuration paths, optional hooks, preservation, and uninstall commands.

### Claude Code

From the built Rimewire checkout:

```sh
claude plugin marketplace add "$PWD/plugins"
claude plugin install rimewire@rimewire-local
```

Restart Claude Code in your project, run **`/rimewire:rimewire-setup`**, then ask for `board_url`. Use a current Claude Code release with exec-form hooks (2.1.207+). See the [plugin guide](docs/CLAUDE_PLUGIN.md).

## A few useful commands

Run these from your project checkout after setup; use real IDs from your tracker:

```sh
rimewire list
rimewire progress TASK-1 --percent 50 --text "Parser implemented"
rimewire blocker TASK-1 --text "Waiting for the input format decision"
rimewire ready TASK-1 --text "Acceptance checks passed"
rimewire serve --repo .
```

The CLI appends updates to a journal inside the current checkout, which lets sandboxed workers report without networking. Keep journals gitignored. Project configuration and Markdown trackers can be versioned normally.

MCP sessions automatically share a local web daemon. It stays available while sessions hold heartbeat leases, then exits after an idle grace period. The actual address comes from `board_url`.

## Documentation

- [Harness installation and removal](docs/INSTALLATION.md)
- [Project configuration](docs/CONFIGURATION.md) and [example tracker](examples/tracker.md)
- [MCP tools and manual registration](docs/MCP.md)
- [Shared board lifecycle](docs/LIFECYCLE.md)
- [Claude Code](docs/CLAUDE_PLUGIN.md), [Codex](docs/CODEX.md), [OpenCode](docs/OPENCODE.md), and [Pi](docs/PI.md)

## Development

```sh
npm ci
npm run check
npm run format
```

Checks cover types, tests, lint, and the packaged plugin build. Python 3 is needed for test-only reference parity checks; the shipped runtime is entirely Node.js. Tests use fixtures and temporary Git repositories. Optional harness and real-project checks are described in their adapter guides.

Licensed under [GPL-3.0-or-later](LICENSE).
