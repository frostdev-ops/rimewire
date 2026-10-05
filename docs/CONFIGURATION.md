# Project configuration

Rimewire reads `.rimewire/config.toml` from the project checkout. Without a config it uses the
checkout directory name and the defaults below. Unknown keys and invalid regular expressions
are errors, so configuration mistakes do not silently change the board.

| Key | Default | Purpose |
|---|---|---|
| `name` | Checkout directory name | Board display name |
| `tracker` | `docs/board/README.md` | Markdown tracker; sibling Markdown files provide package specs |
| `idPattern` | `[A-Za-z][A-Za-z0-9._-]*` | Complete package ID pattern, without the `.md` extension |
| `branchPrefix` | `work` | Branch convention for matching packages to worktrees |
| `branchAliases` | `[]` | Additional branch prefixes for worktree inference |
| `journalDir` | `.rimewire/journal` | Checkout-local directory containing `notes.jsonl` |
| `logo` | Omitted | Optional project-relative image shown beside the name |

Paths must be relative and stay inside the project. Package IDs must also be safe file names of at most 48 characters (letters, digits, dots, underscores, and hyphens).
The tracker path determines the spec directory; no separate spec directory setting is needed.
Add the configured journal directory to the project's `.gitignore`.

The tracker uses second-level Markdown headings as lanes. Tables under a lane with a `Status`
column become package rows. Other tables, such as schedules, remain outside the board. IDs may
link to sibling specs; specs retain their original Markdown and expose summaries and reports.

```toml
name = "Example"
tracker = "planning/tracker.md"
idPattern = 'TASK-[0-9]+'
branchPrefix = "task"
journalDir = ".rimewire/journal"

[statuses]
done = ["shipped"]
active = ["building"]
blocked = ["waiting"]
```

Custom status prefixes extend the built-in categories (`done`, `active`, `spec`, `planned`,
`blocked`, `aside`). Explicit journal updates overlay tracker status: `ready` completes a
package, and later progress or a blocker reopens it. Notes do not change completion.

Roadmap workstreams follow tracker lanes. Milestones are configurable selections of lane rows;
no product-specific milestones ship in the default configuration.

```toml
[roadmap]
fewRows = 10

[[roadmap.milestones]]
id = "foundation"
kind = "phase"
title = "Foundation"
lane = '^Foundation$'

[[roadmap.milestones]]
id = "distribution"
kind = "track"
title = "Distribution"
lane = '^Delivery$'
include = '^TASK-(10|11)$'
state = "later"
note = "Starts after the foundation checks pass."
doc = "distribution.md"
```

A milestone's `lane` pattern selects a lane by its title. Optional `include` and `exclude`
patterns select package IDs within that lane. Omitting `state` derives it from package status;
setting `state` keeps an explicit planning decision. States are `done`, `active`, `next`, `later`.

Platform buckets default to Linux, macOS, Windows, and shared work. Override them with
`[[roadmap.platforms]]` entries containing `id`, `label`, `tokens`, and an optional `note`.

New journal entries use `source` for provenance (`cli`, `mcp`, `web`, `hook:<event>`). Entries
without provenance remain readable as `legacy`; `checkout` separately identifies their worktree.
Hook-origin `ready` entries are rejected. Concurrent local writers append each JSONL record in
one `O_APPEND` write. Network filesystems that emulate append, and other writers that split
records over multiple writes, are unsupported.

Optional harness activity hooks are configured with `[hooks]`, `enabled = true`,
and an optional `package = "<real-id>"` override. Otherwise the checkout branch
selects a unique matching package. The default is disabled. Hooks post lifecycle
notes and deduplicated Git revision/file-count snapshots, without copying private
input or completing work. See [Claude plugin setup](CLAUDE_PLUGIN.md) for installation and hook details.
