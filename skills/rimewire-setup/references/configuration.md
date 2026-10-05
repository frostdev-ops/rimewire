# Project configuration and tracker contract

The helper's `--config JSON_FILE` accepts a UTF-8 JSON object with the same strict
schema as `.rimewire/config.toml`. JSON is an input format; the project stores TOML.
Keys are case-sensitive and unknown keys are rejected at every object level.
Defaults fill omitted settings; supplied JSON does not inherit the existing file.
Preserve existing settings explicitly when changing an existing config.

## Root settings

| Key | Type and default | Meaning |
|---|---|---|
| `name` | Nonempty string; checkout basename when config is absent | Board display name. The schema's standalone default is `Rimewire`. |
| `tracker` | Local path; `docs/board/README.md` | Markdown tracker; its directory also contains specs and board documents. |
| `idPattern` | Valid JavaScript regex string; `[A-Za-z][A-Za-z0-9._-]*` | Pattern matched against the complete package ID. |
| `branchPrefix` | Nonempty string; `work` | Infer worktrees from `<prefix>/<id>-description` or `<prefix>/<id>`. |
| `branchAliases` | Array of nonempty strings; `[]` | Additional branch prefixes accepted for inference. |
| `journalDir` | Local path; `.rimewire/journal` | Checkout-local journal directory containing `notes.jsonl`; gitignore this directory. |
| `logo` | Optional local path | Existing project image; omit if none is needed. |
| `statuses` | Object; `{}` | Regex arrays keyed by status class, described below. |
| `roadmap` | Object with defaults below | Platform buckets and milestones selected from tracker rows. |
| `hooks` | Object; `{ "enabled": false }` | Opt-in hook settings; see below. |

Local paths are nonempty, project-relative paths without `..` components. Do not
use absolute paths. Choose paths that remain inside the checkout when resolved;
do not use symlinks to external files. Keep the journal separate from config,
tracker, and instruction files.

IDs must satisfy `idPattern` and be safe filenames: 1–48 ASCII characters,
starting with a letter or digit and followed by letters, digits, `.`, `_`, or `-`.
Use the actual existing scheme, including mixed schemes when already established.
For JSON, escape regex backslashes (`"TASK-[0-9]+\\.[0-9]+"`); TOML literal
strings can use `idPattern = 'TASK-[0-9]+\.[0-9]+'`.

An explicit tracker `Branch` wins over inference, followed by a worktree directory
whose name equals the ID, then the configured prefixes. IDs and inferred branch
matches are case-insensitive for worktree discovery; preserve the tracker ID's
original spelling for updates. Do not rename branches to fit a new default.

## Status classification

`statuses` accepts only `blocked`, `aside`, `done`, `active`, `spec`, and `planned`.
Each supplied value is an array of nonempty JavaScript regex strings. Use patterns
valid with the Unicode and case-insensitive flags. Patterns are tested against
plain, lowercased status text, in this precedence order:

| Class | Built-in matching when its setting is omitted |
|---|---|
| `blocked` | Starts with `blocked`. |
| `aside` | Starts with `split`, `superseded`, `cut`, or `(superseded`. |
| `done` | Starts with `merged`, `frozen`, `design landed`, `done`, or `landed`; or contains the standalone word `done`. |
| `active` | Starts with `delegated`, `in review`, `in progress`, `review`, or `implementing`. |
| `spec` | Starts with `spec`. |
| `planned` | Fallback when nothing else matches. |

A supplied array **replaces** that class's defaults. An empty array disables its
patterns. To add `shipped` while preserving ordinary `done` and `merged` rows,
include all needed patterns, for example `done = ['^(done|merged|shipped)']`.
Leave other classes omitted to keep their defaults. Do not map planned work to
done just to make setup appear complete.

Explicit journal `ready` completes a package; subsequent progress or a blocker
reopens it. A note does not change completion, and 100% progress does not complete
work. Local journal state overlays the tracker's persisted status.

## Roadmap settings

`roadmap` accepts only `platforms`, `fewRows`, and `milestones`.
`fewRows` is a nonnegative integer, default `10`; `0` disables the small-bucket
notice. Platform IDs and milestone IDs must each be unique within their array.

Each platform requires `id` and `label` (nonempty strings), and `tokens` (an array
of strings). Optional `note` is a string. Tokens are case-insensitive OS-cell
tokens, not regexes; prefer simple words or hyphenated names. The default buckets
are Linux (`linux`, `hyprland`, `both`), macOS (`macos`, `mac`, `both`), Windows
(`windows`), and Shared (no tokens). Override these for the actual project.

Use a bucket with `id = "shared"` and `tokens = []` for blank or unrecognized OS
cells. Without that ID, the first bucket with no tokens acts as the fallback.
One token can belong to several buckets, such as `both`. For a service or library
with no platform split, a single shared bucket avoids irrelevant OS categories.

Each milestone accepts:

| Key | Constraint and behavior |
|---|---|
| `id`, `title` | Required nonempty strings. |
| `kind` | String, default `phase`; other values render in the tracks group. |
| `lane` | Optional regex matching the title of the **first** matching tracker lane, case-insensitively. Use anchored, escaped heading text to avoid accidental matches. |
| `include`, `exclude` | Optional case-sensitive regexes filtering IDs within that selected lane. |
| `state` | Optional `done`, `active`, `next`, or `later`; omit to derive state from selected package statuses. |
| `note` | Optional string. |
| `doc` | Optional local path; use the basename of an existing sibling Markdown document for a working board document link. |

Milestones default to `[]`. A milestone without a matching lane has no rows and
defaults to `later` unless its state is explicit. `include` does not select across
all lanes. There is no root `phases` key: phases come from `##` tracker headings
and `roadmap.milestones` rules. Do not set an explicit state unless it represents
an existing planning decision.

## Customization example

This JSON pairs with `assets/tracker.md` after substituting real project values.
`TASK` is an example scheme, not a package ID to post to in another project.

```json
{
  "name": "Example project",
  "tracker": "docs/board/README.md",
  "idPattern": "TASK-[0-9]+",
  "branchPrefix": "task",
  "branchAliases": [],
  "journalDir": ".rimewire/journal",
  "statuses": {},
  "roadmap": {
    "platforms": [{ "id": "shared", "label": "Project", "tokens": [] }],
    "fewRows": 0,
    "milestones": [
      { "id": "foundation", "kind": "phase", "title": "Foundation", "lane": "^Foundation$" },
      { "id": "verification", "kind": "phase", "title": "Verification", "lane": "^Verification$" }
    ]
  }
}
```

When converting existing TOML to JSON, preserve nested arrays, regex strings,
optional fields, and hook settings. Do not pass TOML text or a JSON string
containing TOML to `--config`.

## Optional hooks

Opt in per project with:

```toml
[hooks]
enabled = true
package = "TASK-1"
```

`hooks` accepts only `enabled` (boolean, default `false`) and optional `package`
(nonempty string). Use an actual package from this project's tracker, not a phase,
branch, or filesystem path. JSON input uses
`"hooks": { "enabled": true, "package": "TASK-1" }`. Leave hooks absent or
disabled when not requested. Omit `package` to infer it from the checkout branch using the configured branch conventions. Set it explicitly only to override inference. Unknown or ambiguous matches produce no update.
Configuration accepts the package string; choosing a real ID is still the model's
responsibility.

Hooks append fixed lifecycle notes with `hook:<event>` provenance and deduplicated revision/file-count snapshots with `hook:GitSnapshot` provenance. They do not
post progress, because progress would reopen a completed package. A session,
process, or subagent stopping cannot mark a package `ready`. Keep transcripts,
prompts, tool input, and credentials out of hook payloads and journal notes.

## Tracker and spec format

- Use `## Phase title` headings for lanes. Optional `### Group title` headings
  group rows within the lane. Lanes without valid package rows are omitted.
- Use Markdown pipe tables with a `Status` column beneath those headings.
  The first column contains the package ID; columns are matched case-insensitively.
  Supported columns include `Title` (or `Scope`), `OS`, `Depends on`, and `Branch`.
  Other nonempty columns are retained as package fields.
- Keep IDs unique for reliable updates. Rows not matching the configured pattern
  are skipped; verify counts and IDs rather than treating an empty board as success.
- IDs may be plain or linked to a sibling spec, such as `[TASK-1](TASK-1.md)`.
  A sibling `<ID>.md` is discovered without a link too. Preserve existing specs;
  do not create broken links or move documents merely for setup.
- Use the project's existing platform words in `OS` and real package IDs in
  `Depends on`. Keep status evidence and existing branch values intact.
- Preserve prose and nonpackage tables. Tables without `Status` are not packages.

Do not automatically replace an existing tracker with the template. Adapt only
the structure the parser needs, or keep the original document and link it from
the configured tracker when its format must remain intact.
