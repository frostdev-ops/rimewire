# Pi adapter

Verified against the installed Pi 1.0.2 CLI (`pi --version`, `pi --help`, and
`pi mcp --help`) and the current primary
[extension docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md),
[MCP docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md), and
[package docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
on 2026-10-04.

## Runtime and installation

Both the native Pi executable and the official npm package,
`@earendil-works/pi-coding-agent`, are supported. Rimewire requires Node.js 24
or newer. Node-hosted Pi uses `process.execPath` directly. Native Pi embeds Bun,
so its `process.execPath` names Pi itself; the extension probes `node` on PATH
once with `node -e`, reading its executable path, version, and Bun flag.
The probe has a three-second deadline, and the result must identify an absolute
Node executable with version 24 or newer and no Bun flag. MCP and lifecycle
hooks then use that same resolved executable. Missing, old, or invalid runtimes
produce only `Rimewire requires an available Node.js 24+ runtime.` before
registering MCP or hooks. No probe output or subprocess error is echoed.

Build or install Rimewire, then install its adapter:

```sh
rimewire install pi --user
# Or, for one project:
rimewire install pi --project
```

The installer adds absolute paths to the selected Pi `settings.json`:

```json
{
  "extensions": ["/absolute/package/root/adapters/pi/index.mjs"],
  "skills": ["/absolute/package/root/skills/rimewire-setup"]
}
```

The extension stays inside the installed package. No copied loader, separate
skill copy, or additional runtime dependency is needed. Remove the adapter with
`rimewire uninstall pi` using the same scope. Reload or restart Pi after changes.
User settings normally live in `~/.pi/agent/settings.json`; project settings
live in `.pi/settings.json` and require project trust.

Rimewire also exposes the same resources as a Pi package:

```json
{
  "pi": {
    "extensions": ["adapters/pi/index.mjs"],
    "skills": ["skills/rimewire-setup"]
  }
}
```

For a local checkout, `pi install /absolute/path/to/rimewire` records the package
in Pi settings without copying it; `--local` selects project settings. Once
published, the equivalent source is `npm:rimewire`. Choose either Pi package
installation or Rimewire's installer. Exact `.mjs` entries work in both manifest
and settings arrays on Pi 1.0.2; conventional directory discovery only looks for
`.ts` and `.js`, so retain the explicit entry.

Pi supplies the shared skill as `/skill:rimewire-setup`. Its text remains
harness-independent. These package and settings behaviors follow Pi's
[package contract](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).

## MCP registration

The factory registers `rimewire` through Pi's built-in `registerMcpServer`:

```js
{
  command: resolvedNodeExecutable,
  args: [absoluteCliPath, "mcp"],
  exposure: "direct"
}
```

No shell or cold `npx` download is involved. The CLI path resolves relative to
the extension's own module, while the server inherits Pi's session working
directory. Pi owns connection startup, tool registration, and shutdown.
The five tools are directly visible as `mcp__rimewire__board_overview`,
`mcp__rimewire__get_package`, `mcp__rimewire__post_update`,
`mcp__rimewire__list_updates`, and `mcp__rimewire__board_url`. Pi's default MCP
exposure is `codemode`; `direct` declares these tools to the model.
See the [official MCP contract](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md).

Inspect this extension's server through `/mcp` inside a Pi session.
`pi mcp list` is a shell command that reads only file-configured servers and
does not load extensions. A same-name `rimewire` server in `mcp.json` takes
precedence over the extension. An extension that replaces built-in `/mcp`
also changes how registrations connect.

## Optional lifecycle notes

Automatic notes require explicit project opt-in in `.rimewire/config.toml`:

```toml
[hooks]
enabled = true
package = "YOUR-EXISTING-PACKAGE-ID"
```

| Pi event | Shared CLI event | Fixed note |
| --- | --- | --- |
| `session_start` | `PiSessionStart` | Pi session started. |
| `agent_end` | `PiAgentEnd` | Pi agent ended. |
| `session_shutdown` | `PiSessionShutdown` | Pi session shut down. |

The extension calls `node /absolute/dist/cli.js hook <event>` with only
`{"cwd": ctx.cwd}` on stdin. It never reads or serializes the event payload,
prompts, messages, session history, tool arguments, or tool results. The shared
hook CLI resolves the checkout, loads its project configuration, validates the
configured package against the tracker, and writes a fixed `note` to the
checkout-local journal with `hook:<event>` provenance. Disabled, unconfigured,
and unknown packages produce no update.

Hook output is discarded, errors cannot interrupt Pi, and subprocesses have a
1.5-second deadline. No per-tool event is observed, avoiding noisy notes and
activity caused by the board's own tool calls. An agent run may be followed by
automatic recovery or queued work; none of these lifecycle events marks a
package ready. Explicit readiness also survives later activity notes.

## Verification

Default adapter tests cover runtime selection and probe failures/deadlines,
registration, relocation, cwd-only payloads, subprocess failure and timeout,
project gates, and readiness preservation. Optional integration tests load
the native Pi executable over RPC and the official npm Pi under Node in fresh
temporary profiles. Each loads package and settings declarations, discovers
the shared skill, checks direct model tool exposure, calls all five MCP tools
with a local fixture provider, and verifies lifecycle notes. Native RPC checks
prompt acceptance and final settlement before closing stdin. No API credentials
or global Pi configuration writes are needed:

```sh
RIMEWIRE_PI_CLI=/absolute/path/to/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
RIMEWIRE_PI_NATIVE=/absolute/path/to/pi \
  npx vitest run tests/pi-adapter.test.ts
```

`PI_CODING_AGENT_DIR` and the board state directory are temporary for each
integration case. Either runtime path may be supplied independently. Native
Pi 1.0.2 was checked with the available Node 26 runtime on PATH; npm Pi 1.0.2
was also checked under Node 24.
