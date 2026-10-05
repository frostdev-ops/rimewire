# Claude Code plugin

The plugin includes the Node runtime, web assets, MCP registration, `rimewire-setup`
skill, and optional command hooks. Node 24+ is required. Use a current Claude Code
release with exec-form command hooks (2.1.207+); acceptance was run on 2.1.289.
There is no runtime npm download or LLM API requirement in Rimewire itself.

## Install from a built checkout

```sh
npm ci
npm run build
claude plugin marketplace add /absolute/path/rimewire/plugins
claude plugin install rimewire@rimewire-local
```

Restart Claude Code in the target project. Run `/rimewire:rimewire-setup`, then ask
for `board_url`. The model surveys your project and customizes its own config,
tracker, and managed agent instructions. Repeating setup preserves the prose
outside the managed markers and existing tracker content.

If the project already registers Rimewire manually in `.mcp.json`, remove only
that Rimewire entry once the plugin works to avoid duplicate tool registration.
Other MCP entries can remain.

## Install from an npm package

Once a release is published, install `rimewire` globally and add the `plugins/`
directory inside its installed package as the marketplace. `npm root -g` prints
the global package directory; append `/rimewire/plugins` to that path. The npm
package includes the prebuilt plugin, so users do not need TypeScript or esbuild.
For local release testing, install the tarball produced by `npm pack` instead.
The GitHub source checkout supports local marketplace installation. An npm registry
release is separate.

The catalog is `plugins/.claude-plugin/marketplace.json`, with the relative source
`./rimewire`. The plugin's manifest and MCP config use the standard
[Claude plugin layout](https://code.claude.com/docs/en/plugins-reference).
The runtime stays entirely inside the plugin root, so copying it into a cache
works independently of the original checkout and its node_modules.

## Project setup helper

`rimewire setup --repo PATH --config INPUT.json --json` applies model-chosen
customization. `INPUT.json` uses the configuration keys in
[CONFIGURATION.md](CONFIGURATION.md); supplied input is a complete configuration,
not a patch. Omit `--config` to preserve an existing config. The helper creates
an empty compatible tracker only when absent; the skill then populates or adapts
it using the project's real work packages.

Root `AGENTS.md` and `CLAUDE.md` receive managed blocks. Existing recognized agent
files are updated too. Pass repeated `--agent-file relative/path` for additional
files, including nested agent instructions the skill discovers. The helper
rejects malformed/duplicate markers and escaping paths before writing files.
It adds the journal ignore rule without ignoring the project's config or tracker.
Inside the plugin, use `node "<plugin-root>/dist/cli.js" setup ...` when the global
CLI is unavailable. The helper embeds that installed runtime as a CLI fallback.

## Optional activity hooks

Hooks do nothing until a project explicitly opts in and selects a real work package:

```toml
[hooks]
enabled = true
package = "TASK-1"
```

`SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, and `Stop` append
fixed activity notes with source `hook:<event>` to the current checkout's journal.
They do not copy prompts, transcripts, assistant messages, or tool payloads. They
never mark work ready or reopen completed packages. Start events can add board-use
context; completion still requires an explicit agent or human update. Hook errors
are non-blocking and use a fixed diagnostic that excludes payload contents.
The plugin uses the documented
[exec-form hook commands](https://code.claude.com/docs/en/hooks#exec-form-and-shell-form).

## Verify and remove

```sh
claude plugin validate plugins
claude plugin validate plugins/rimewire
npm run check
node scripts/smoke-claude-plugin.mjs
```

The manual smoke uses existing Claude authentication in a temporary private config,
installs the packed release, runs setup on a fresh fixture project, and delegates
an MCP update to a subagent. It verifies preserved instructions and provenance,
then removes the temporary config/project and stops its isolated daemon.
It makes model calls; ordinary `npm run check` does not.

Use `claude plugin uninstall rimewire@rimewire-local` to remove the plugin, or
`claude plugin marketplace remove rimewire-local` to remove the catalog and its
plugins. Project config, tracker, and managed instructions are project-owned and
are preserved. Remove only their Rimewire managed blocks if you stop using the board.

The bundled CLI also includes `install/uninstall` for Codex, OpenCode, and Pi;
build copies their adapter assets into the plugin so those commands remain
available outside the npm source tree. See [harness installation](INSTALLATION.md).
