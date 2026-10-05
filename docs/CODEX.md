# Codex adapter

Supported acceptance baseline: Codex CLI 0.160.0 and Node.js 24+.

`rimewire install codex --user` appends an owned TOML block to
`$CODEX_HOME/config.toml` (default `~/.codex/config.toml`), registering the current
Node executable and installed `dist/cli.js mcp`, with `startup_timeout_sec = 60`.
The complete portable setup skill, including resources, is copied to
`~/.agents/skills/rimewire-setup/`. Project scope uses `.codex/config.toml` and
`.agents/skills/rimewire-setup/` in the current directory. Restart Codex, invoke
`rimewire-setup`, and call `board_url` in the project.

The CLI fallback in managed agent instructions writes the checkout-local journal
without depending on loopback access. Pass these instructions and the resolved
CLI command to delegated workers; tool inheritance can differ by Codex version.

Optional `--hooks` adds shell-form command hooks to `hooks.json` in the same Codex
configuration directory. Node and CLI paths are quoted separately. Events are
SessionStart, SessionEnd, SubagentStart, SubagentStop, and Stop, with fixed
`Codex<Event>` provenance in Rimewire. Review and trust through `/hooks` before
Codex will execute them. Project activity must also be enabled and assigned to a
real work package. Hook registration never implies completion or approval.

## Plugin compatibility

The existing `.claude-plugin/marketplace.json` and plugin layout can be added with
`codex plugin marketplace add /path/to/rimewire/plugins`, then
`codex plugin add rimewire@rimewire-local`. Version 0.160.0 installed and listed the
shared Claude-format plugin successfully in an isolated profile, then verified
its MCP updates in a real model session. The plugin-session worker used the
managed CLI fallback; the direct project-registration worker received MCP tools.
These acceptance results establish both update paths, rather than promising
identical tool inheritance for every session. The installer
uses direct registration and the portable shared skill for a predictable local
CLI path; avoid installing both methods in the same harness.

## Verification

The default suite covers installation ownership, config preservation, idempotence,
removal, and MCP/daemon contracts without invoking a model.
`scripts/smoke-codex-adapter.mjs` is an optional authenticated model acceptance in a
fresh Git fixture and isolated Codex profile. It copies existing authentication
opaquely, installs the project adapter, verifies Codex's registration, calls the
MCP tools, and asks a delegated worker to post through MCP or its local CLI
fallback. It checks journal provenance and cleans up the temporary fixture.
Run with `--plugin` to verify the shared Claude-format plugin through Codex;
without that flag, acceptance also verifies owned direct-registration removal.
Both variants passed on 2026-10-04.

Primary references checked 2026-10-04:
[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[skill discovery](https://learn.chatgpt.com/docs/build-skills),
[hooks and trust](https://learn.chatgpt.com/docs/hooks),
[plugin packaging](https://developers.openai.com/plugins/build/plugins),
[subagent configuration](https://learn.chatgpt.com/docs/agent-configuration/subagents).
