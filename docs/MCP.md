# MCP server

Build with `npm ci && npm run build`, then run `node dist/cli.js mcp` inside a
project checkout. Node 24 or newer is required. The process speaks MCP over stdio;
stdout is reserved for protocol messages. Diagnostics go to stderr.

The server exposes `board_overview`, `get_package`, `post_update`, `list_updates`,
and `board_url`. Tool results include JSON text and structured content. Call
`tools/list` to discover the schemas. Package arguments use `wp`; updates take
`kind`, `text`, optional `percent`, and optional `author`. Only progress and ready
updates accept a percentage. Updates require a known package and are always recorded
with source `mcp` in the launching checkout's journal. Caller-supplied provenance
or filesystem paths are rejected. Explicit ready marks completion; later progress
or a blocker reopens it.

Configuration is reread on each tool call. Worktree sessions resolve their main
repository for the board while retaining their local checkout for journal writes.

After initialization, the MCP process starts or joins the detached shared board
and registers its project. `board_url` waits for registration and returns the
project's `/p/<id>/` URL. Session heartbeats keep the daemon alive; closing a session
releases its lease, and the daemon exits after the last session plus the idle period.
See [the lifecycle details](LIFECYCLE.md) for ports, state locations, and timing.

## Claude Code manual configuration

Add this to the project's local `.mcp.json`, replacing the absolute paths:

```json
{
  "mcpServers": {
    "rimewire": {
      "command": "node",
      "args": ["/absolute/path/rimewire/dist/cli.js", "mcp", "--repo", "/absolute/path/project"]
    }
  }
}
```

Restart Claude Code and accept its project MCP trust prompt. Check `/mcp`, then ask
for `board_overview` and `board_url`. Ask it to post a note to a real package and
verify that `list_updates` and the live board show the note with source `mcp`.
The setup skill and installer arrive in later phases.

The implementation uses the official
[MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/server).
