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
| `palette` | Automatic light/dark defaults | Fully custom shared and mode-specific colors |
| `fonts` | Built-in local font stacks | UI `sans` and code `mono` family stacks |
| `stylesheet` | Omitted | Project-relative CSS for further agent customization |

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

## Custom palettes, fonts, and agent styling

Every project may define its own colors; there are no required palette presets.
`palette.mode` is `auto` (system preference), `light`, or `dark`. Shared values in
`palette.colors` apply to both modes; `palette.light` and `palette.dark` override
shared values for their mode. Omitted colors keep the built-in defaults.

```toml
# Root-level option, before any [table]:
stylesheet = "assets/board.css" # optional, for unrestricted project CSS customization

[palette]
mode = "auto"
[palette.colors]
accent = "#bb86fc"
done = "#54c693"
[palette.light]
background = "#faf7ff"
surface = "#ffffff"
text = "#241c35"
[palette.dark]
background = "#171221"
surface = "#241c35"
text = "#f3edf9"

[fonts]
sans = '"IBM Plex Sans", system-ui, sans-serif'
mono = '"IBM Plex Mono", ui-monospace, monospace'
```

Each color table accepts `background`, `surface`, `surfaceAlt`, `border`,
`borderSoft`, `text`, `textSecondary`, `muted`, `accent`, `accentSoft`, `focus`,
`highlight`, `done`, `active`, `spec`, `planned`, `blocked`, `aside`, `ready`,
and `onSolid`. Values are hex colors (`#RGB`, `#RGBA`, `#RRGGBB`, or `#RRGGBBAA`).
Focus follows a custom accent unless explicitly set; ready follows a custom done
color unless explicitly set. Status colors also appear in the progress favicon.

Font stacks use installed local families and CSS generic fallbacks. Rimewire does
not download fonts. An agent may add embedded `@font-face` definitions to the
project stylesheet for a self-contained font. The stylesheet loads after board CSS;
it can customize layout, spacing, typography, additional color variables, and
components. Config overrides use inline CSS variables, so overriding the same
variable from custom CSS requires `!important`, or leave that config value unset.
All styling stays in the user's project. Only the configured project-relative CSS
file is exposed; symlinks escaping the project are rejected.

Agents should survey project branding, choose readable colors and font fallbacks,
and update these settings through the setup helper's complete config JSON or the
project TOML. Configuration and stylesheet edits refresh the live board. Removing
settings restores defaults; switching projects loads that project's own appearance.
