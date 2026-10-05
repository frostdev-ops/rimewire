# OpenCode adapter

Verified on 2026-10-04 with OpenCode **1.18.34**, including its installed
`--version` and `--help`. Rimewire requires Node.js 24+. The adapter is an ESM
`.mjs` plugin shipped in the npm package; no adapter TypeScript compilation or
OpenCode SDK dependency is required.

## Install and use

After installing Rimewire, run from the project:

```sh
rimewire install opencode --project
# Or register for all projects:
rimewire install opencode --user
```

The installer adds the installed adapter's absolute file URL to OpenCode's
`plugin` array. Its equivalent registration is:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/npm/package/adapters/opencode/index.mjs"]
}
```

When both `opencode.json` and `opencode.jsonc` exist in the selected directory,
the installer edits JSONC and preserves JSON. OpenCode loads both, merging JSONC
last for conflicting keys in both global and project config. The source order
is explicit in the [config loader](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/config/config.ts)
and [project config discovery](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/config/paths.ts);
the isolated acceptance also checks both cases against the installed binary.

Generate the URL with `pathToFileURL`, so spaces and `#` are encoded correctly.
`installedPaths(packageRoot)` in `adapters/opencode/runtime.mjs` also returns
the installer URL. That helper is separate from the plugin entry because
OpenCode's legacy loader treats every function export as a plugin.
See the [official plugin documentation](https://opencode.ai/docs/plugins/) and
the verified [1.18.34 loader](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/plugin/index.ts).

When OpenCode initializes the plugin, its `config` hook adds:

- `mcp.rimewire`: a local server with command
  `[absoluteNodePath, absoluteInstalledPackageRoot + "/dist/cli.js", "mcp"]`,
  `enabled: true`, and `timeout: 10000` milliseconds.
- `skills.paths`: the installed package's entire absolute `skills` directory,
  preserving other paths and avoiding duplicate entries.

These changes affect OpenCode's resolved runtime configuration. They do not
write another harness config file. The MCP entry leaves `cwd` unset, allowing
OpenCode to launch it in the actual project or worktree. OpenCode plugins run
under Bun, so the adapter probes `node` on PATH once with a three-second limit
to obtain Node's own `process.execPath` and verify Node 24+. It then uses that
absolute path for MCP and hook children. No startup package download occurs.
Local server command arrays and timeout units are documented in
[OpenCode's MCP reference](https://opencode.ai/docs/mcp-servers/).

The installer rejects an existing `mcp.rimewire` in its target file. If the
plugin is loaded manually or the entry comes from another config layer,
an existing `mcp.rimewire` entry is deliberately preserved, including
`enabled: false`, custom commands, and remote servers. The shared skill path
is still added. Inspect `opencode debug config` when an existing entry prevents
the bundled server from starting. Missing installed assets or an unavailable
Node runtime produce a fixed error; the adapter never replaces a conflicting
server. OpenCode itself reports plugin load/config errors while continuing.

Start OpenCode and ask the agent to load **rimewire-setup** through its native
`skill` tool. The full shared skill configures the project's tracker and
`.rimewire/config.toml` and adds managed board instructions to its agent files.
The agent can then use the board tools and `board_url`.
See [official skill discovery and invocation](https://opencode.ai/docs/skills/)
and [configured skill path discovery in 1.18.34](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/skill/index.ts).

```sh
opencode debug config
opencode debug skill
opencode mcp list
rimewire uninstall opencode --project
```

## Optional activity notes

Hooks are disabled by default. Opt in for a real package in the project's
`.rimewire/config.toml`:

```toml
[hooks]
enabled = true
package = "MYPROJECT-1"
```

| OpenCode event | Shared hook event / source | Fixed note |
| --- | --- | --- |
| `session.created` | `OpenCodeSessionCreated` / `hook:OpenCodeSessionCreated` | OpenCode session created. |
| `session.idle` | `OpenCodeSessionIdle` / `hook:OpenCodeSessionIdle` | OpenCode session idle. |

The event callback reads only the event type. It invokes the installed Node
CLI as `hook <fixed-event>`, with stdin containing only `{ "cwd": directory }`
from the plugin context. It never reads session properties, prompts, tool
arguments/results, titles, or session IDs. The shared hook handler checks the
project opt-in and known package, and writes a fixed note to the checkout's
journal. Child stdout and stderr are discarded. Failed child processes produce
only a fixed diagnostic through OpenCode logging.

Each child has a three-second kill timeout; plugin disposal kills pending
children and waits for their exit. Hooks cannot mark completion, clear a blocker,
or reopen explicit readiness. `session.idle` can describe a child session too;
the adapter does not claim a subagent finished or distinguish parent/child
sessions. It registers no tool-result or session-exit hooks. The lifecycle
event names are listed in [OpenCode's event reference](https://opencode.ai/docs/plugins/#events).

## Acceptance and limits

Run the reproducible isolated acceptance from a checkout with dependencies:

```sh
npx vitest run tests/opencode-adapter.test.ts
node adapters/opencode/smoke.mjs
```

The smoke builds and packs Rimewire, installs the tarball outside the source tree
in a path containing spaces and `#`, and registers its file URL in a fresh Git
project. Separate XDG config/data/cache/state paths, `OPENCODE_CONFIG_DIR`, and
OpenCode's test home keep the profile disposable. It provides no provider
credentials, disables built-in provider plugins and external skill scanning,
and makes no model request. User global settings are not modified.

On OpenCode 1.18.34 this passed with Node 24.21.0; the adapter loading and event
acceptance also passed with Node 26.8.2:

- Real plugin loading, config injection, exact absolute Node/CLI command and
  timeout, native discovery of the full shared setup skill, and JSONC-over-JSON
  precedence in both global and project config.
- Actual project install/uninstall from the packed CLI, selecting JSONC while
  preserving JSON and comments, and repeat-install idempotence.
- MCP connection through `opencode mcp list` and the headless server's `/mcp`
  endpoint, with a reachable local Rimewire board.
- Real session creation and a local shell command producing `session.idle`;
  disabled hooks write no journal, enabled hooks write the two fixed notes,
  and the shell content marker never reaches the journal.
- OpenCode instance disposal stops its MCP child; the private board daemon
  exits after its idle period, and the headless server shuts down. Linux
  process checks confirm no remaining installed-runtime MCP children.

The focused tests also verify unrelated config preservation, deliberate server
conflict preservation, idempotent skill paths, package relocation, ignored
private payload fields, hung-child timeout, pending-child disposal, and
preservation of explicit readiness. This acceptance does not exercise a model
executing the setup skill or delegating a subagent; it verifies native loading,
MCP startup, shared skill discovery, real events, and process lifecycle.
