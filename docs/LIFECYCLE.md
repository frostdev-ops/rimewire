# Shared board lifecycle

Every `rimewire mcp` process holds a session lease on one shared loopback web daemon.
The daemon starts after the MCP initialization handshake, independently of the harness
process group, with inherited stdin/stdout/stderr closed. Closing the first harness
leaves the daemon available to the other sessions.

The daemon prefers port 8737 and tries the next 20 ports if occupied. `mcp --port 0`
chooses a free port. Once a daemon is running, new sessions use its port regardless
of their preference. Existing services on occupied ports are left alone.

Each project has a stable `/p/<id>/` URL based on its canonical main repository
path. Linked Git worktrees register the same project. The project selector lists
registered projects, and the board APIs, static files, documents, updates, and SSE
stream are scoped to the selected project's URL. MCP writes remain local to the
launching checkout's journal.

State lives in `$XDG_STATE_HOME/rimewire/`, or `~/.local/state/rimewire/` on Linux,
`~/Library/Application Support/rimewire/` on macOS, and `%LOCALAPPDATA%/rimewire/`
on Windows. `RIMEWIRE_STATE_DIR` overrides that directory.

- `daemon.json` is the exclusive startup lock and discovery record: process ID,
  bound port, protocol version, process start identity, and a random local control
  token. It is mode 0600. Process identity distinguishes a daemon from a reused PID.
  Startup stops before publishing a lock or claim if process identity is unavailable.
- `projects.json` records canonical project paths across daemon restarts. It is
  atomically replaced and mode 0600. Project data stays in the projects themselves.
- Unique claims under `startup/` serialize startup and stale-lock recovery using
  a ticket election. Dead owners' claims are discarded; claim filenames are never
  reused, so a contender cannot delete a replacement owner's claim. Invalid
  discovery records have a 30-second publication grace period; retry after that
  interval if a record was corrupted or partially written.

MCP sessions send heartbeats every 5 seconds. A session expires after 15 seconds
without a heartbeat. Explicit session shutdown releases its lease immediately.
When no sessions remain, the daemon exits after a 30-second idle grace period,
closes SSE connections, and removes its own lock. Browsers do not keep it alive.
Session exit never marks work complete.

An active MCP process reconnects and registers again if the daemon disappears.
The project registry survives idle shutdown; old projects remain available in the
selector while any session runs. Removed or invalid projects are skipped at startup.

For isolated tests, `RIMEWIRE_HEARTBEAT_MS`, `RIMEWIRE_LEASE_MS`, and
`RIMEWIRE_IDLE_MS` override timing in milliseconds (integers of at least 20).
Choose a lease comfortably longer than the heartbeat interval. `serve --daemon`
runs the shared daemon directly; ordinary `serve --repo ...` remains a standalone
single-project server.

The daemon accepts browser traffic only with a loopback Host header. Its lifecycle
control endpoints require the discovery token and reject browser Origin headers.
The token is never included in board responses or journal entries.
