# Installed runtime and harness connection

Read this reference when the user asks to install Rimewire, the CLI is unavailable,
or setup cannot reach MCP. Project setup and harness installation are separate
operations; use an already installed runtime whenever possible.

## Claude Code plugin

The installed plugin contains `.mcp.json`, the shared setup skill, and a bundled
`dist/cli.js`. Its MCP command and CLI fallback use that bundled file. Node.js 24
or newer must be installed, but plugin runtime startup needs no `npx` download
or dependency installation in the user's project.

For an installation request, install the Rimewire npm package or supplied package
tarball first, then add the marketplace in that installed package's `plugins/`
directory. Its catalog is `plugins/.claude-plugin/marketplace.json`, marketplace
name `rimewire-local`, and plugin name `rimewire`. For a supplied package:

```sh
npm install --global "/absolute/path/to/rimewire-package.tgz"
npm root --global
claude plugin marketplace add "/global/node_modules/rimewire/plugins"
claude plugin install "rimewire@rimewire-local"
```

Use the actual directory returned by `npm root --global` in place of
`/global/node_modules`. For a published package, use the release the user selected
or a verified available release; do not invent a version or remote marketplace URL.
The packaged plugin already includes its runtime, skill, and static assets.

For a source checkout, `npm ci` followed by `npm run build` in the Rimewire source
directory bundles the plugin runtime and copies this shared skill and static
assets into `plugins/rimewire/`; `npm pack` produces an installable package tarball.
Build before adding a source checkout's `plugins/` marketplace. Check for
`plugins/rimewire/dist/cli.js` and bundled skill/assets before installation. Run
these build commands in the Rimewire source checkout, not the target project.

Restart the affected Claude Code session after installation, inspect `/mcp`, and
complete any actual harness trust prompt. Invoke the installed setup skill, normally
`/rimewire:rimewire-setup`. Verify `board_url` and `board_overview` in the target
project. The entrypoint's resolved plugin CLI command is the fallback. In these
reference examples, replace the plugin placeholder with that literal path:

```sh
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" setup --repo "/absolute/path/project" --json
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" list --checkout "/absolute/path/project" --json
```

Claude expands the plugin placeholder in `SKILL.md` content; it does not provide
it as an environment variable to ordinary Bash tools or subagents. Pass the
resolved CLI path to workers and use the helper's concrete installed-path fallback
in managed blocks. This behavior is documented in the official
[plugin path substitution reference](https://code.claude.com/docs/en/plugins-reference#where-each-variable-resolves).
Use global `rimewire` in other harnesses. If neither runtime is available, report
that concrete limitation and provide the applicable install command when requested.

Use Claude Code 2.1.207 or newer as the supported plugin baseline. The plugin's
`hooks/hooks.json` uses command hooks with `command = "node"` and an `args` array
containing the bundled CLI path, `hook`, and the event name, following the current
[exec-form command hook schema](https://code.claude.com/docs/en/hooks#exec-form-and-shell-form).
The harness substitutes the plugin path in that array and passes each element
directly to Node without shell tokenization. Keep this shipped registration;
enabling project hooks only changes the project's `[hooks]` settings.

## Other harnesses and global CLI

The same skill source works with Codex, OpenCode, Pi, and other MCP-capable
harnesses. Use bare tool names in project instructions; harness prefixes are
discovered at call time. A user's existing global `rimewire` provides:

```sh
rimewire setup --repo "/absolute/path/project" --json
rimewire mcp --repo "/absolute/path/project"
```

When the user requests global installation from an available local package:

```sh
npm install --global "/absolute/path/to/rimewire-package.tgz"
```

Use a verified Rimewire release or built local tarball. Installing a package once
does not justify fetching an external runtime on each session. Register the
installed `rimewire mcp` executable using the harness's documented MCP settings.
Use `rimewire install codex|opencode|pi --user` (default) or `--project` to register
an installed runtime and the shared skill. `rimewire uninstall <harness>` with the
same scope removes owned registrations, preserving project board data and edited
settings. `--hooks` installs optional Codex hooks, which need `/hooks` trust review.
OpenCode and Pi adapters provide optional activity events; all hooks need project
opt-in and a real selected work package. Use the installed CLI's help if using an
older package without these adapters.
Keep shared user settings and other MCP registrations intact.

To install just the shared skill when requested, copy the **entire**
`rimewire-setup` directory, including references and assets, into the harness's
supported skills directory. `~/.agents/skills/rimewire-setup/` is the shared
location used by Codex, OpenCode, and Pi; project-local `.agents/skills/` is another
option where supported. Claude Code receives this skill through its plugin.
Copying the skill alone does not install the CLI or register MCP.

## Local operation and actual write failures

CLI update commands append to the selected checkout's journal and do not call
the HTTP board API. Sandboxed workers and subagents can use them when MCP or
loopback access is unavailable:

```sh
rimewire progress ACTUAL_ID --percent 50 --text "Concrete completed work" \
  --checkout "/absolute/path/project"
rimewire blocker ACTUAL_ID --text "What is needed to continue" \
  --checkout "/absolute/path/project"
rimewire ready ACTUAL_ID --text "Acceptance checks and results" \
  --checkout "/absolute/path/project"
```

Replace `ACTUAL_ID` with a package read from the tracker; for Claude's bundled CLI,
replace the command's `rimewire` with the resolved plugin CLI command from the
entrypoint.
Pass the worker's checkout, not a different worktree. `list --json` checks journal
entries; it is not a tracker/roadmap snapshot. Use `board_overview` or the running
web board to verify tracker parsing.

Without MCP, `rimewire serve --repo "/absolute/path/project"` prints the actual
local board URL. Keep the process running while the board is needed. If a port
is occupied, use an available `--port` and report its printed URL; do not stop
unrelated servers. The board stays on `127.0.0.1`.

Try authorized writes using the normal available tools. If a sandbox actually
denies a harness-config or agent-file write, report the denied path and give the
exact local command with this project's resolved values. If that command needs
`--config`, retain the prepared JSON input at an accessible project path for the
user's retry. Report which steps succeeded and which remain. Do not require
speculative permission confirmations or present an unattempted write as blocked.
