# Harness installation

Use Node.js 24 or newer and an installed Rimewire package. From a source checkout,
run `npm ci` and `npm run build`, then use `node /absolute/path/rimewire/dist/cli.js`
in place of `rimewire` below. An npm tarball made by `npm pack` includes the runtime,
Claude plugin, shared skill, and adapters. Nothing has been published to npm yet.

```sh
rimewire install codex --user
rimewire install opencode --user
rimewire install pi --user
```

User scope is the default. `--project` installs into the current project instead.
The installer registers the current Node executable and installed runtime by absolute
path, so harness startup needs no package download. Keep that installed directory
available. Rerun installation after moving or updating it. Installation does not
install Node, npm packages, a system service, or change project board customization.
Run the discovered `rimewire-setup` skill after restarting the harness to customize
its project and add managed agent instructions. Verify the actual URL with `board_url`.

| Harness | User registration | Project registration | Skill |
|---|---|---|---|
| Codex | `$CODEX_HOME/config.toml`, default `~/.codex/config.toml` | `.codex/config.toml` | Entire directory copied to `~/.agents/skills/rimewire-setup` or `.agents/skills/rimewire-setup` |
| OpenCode | `$XDG_CONFIG_HOME/opencode/opencode.json[c]`, default `~/.config/opencode/` | `opencode.json[c]` | Plugin adds the installed shared skill path |
| Pi | `$PI_CODING_AGENT_DIR/settings.json`, default `~/.pi/agent/settings.json` | `.pi/settings.json` | Installed shared skill path in `skills` |

Codex receives stdio MCP registration with a 60-second startup timeout. OpenCode
loads a local plugin which supplies MCP and the skill path; Pi loads an extension
which registers its built-in MCP with direct tool exposure. Harness trust and
permissions remain under the harness's control. Project config must be trusted
where the harness requires it. Codex subagents can use the managed checkout-local
CLI fallback if their session lacks MCP tools.

For Claude Code, use the [plugin marketplace instructions](CLAUDE_PLUGIN.md).
Codex also accepts that marketplace format in the tested version; the dedicated
installer uses direct configuration to avoid registering two copies of the server.
Choose one installation method per harness/project.

## Preservation and removal

```sh
rimewire uninstall codex --user
rimewire uninstall opencode --project
rimewire uninstall pi --user
```

Pass the same scope and environment overrides used at installation. The receipt
`rimewire-install.json` in the harness configuration directory records owned
registrations and copied skill hashes, without storing a backup of private settings.
Install and uninstall preflight changes, preserve unrelated settings and JSONC/TOML
comments, and reject an existing unowned Rimewire entry instead of replacing it.
Repeated installation is idempotent. When both OpenCode JSON and JSONC files exist
in the selected directory, JSONC takes precedence, matching the tested harness;
the installer edits JSONC and preserves JSON.

Uninstall removes only unchanged registrations and owned skill files. If you edited
one, it stops and preserves the files and receipt so you can review the difference.
Project `.rimewire/config.toml`, trackers, journals, and managed agent instructions
remain. Empty harness settings containers may remain as valid config. An exclusive
receipt lock prevents overlapping operations; a lock left after an interrupted
process must be removed after confirming that process has stopped.

## Optional activity hooks

OpenCode and Pi adapters supply optional activity events. The Codex installer adds
hooks only when requested:

```sh
rimewire install codex --user --hooks
```

Codex requires review and trust through `/hooks`; installing never grants trust.
All adapters require project `[hooks] enabled = true` and a real `package` selected
in `.rimewire/config.toml` before writing activity. Events append fixed notes with
harness-specific `hook:<event>` provenance. They consume only the checkout path,
never prompt, transcript, or tool output. Idle, agent-end, and session shutdown
never mark work complete or reopen a ready package. Explicit MCP/CLI updates work
without optional hooks.

For adapter details and acceptance evidence, see [Codex](CODEX.md),
[OpenCode](OPENCODE.md), and [Pi](PI.md).
