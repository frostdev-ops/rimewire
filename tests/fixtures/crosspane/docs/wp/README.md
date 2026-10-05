# Work-package tracker

- [ ] Attend the device gate
  with a second person.
- [x] Agree on package names.

## Phase 0 — foundations (finished 2026-09-30)

First foundation note.

Second foundation note.

Third foundation note.

Fourth note is deliberately omitted from the board.

| WP | Title | OS | Status | Reviewer |
|---|---|---|---|---|
| [WP-0.1](WP-0.1.md) | Foundation | OS-free | merged | lead |
| WP-0.2 | Replaced plan | any | superseded | — |

## Phase 1 (started 2026-10-01)

| WP | Title | OS | Depends on | Status | Branch |
|---|---|---|---|---|---|
| WP-1.1 | Codec | OS-free | — | merged | — |
| WP-1.2 | Hyprland capture | Hyprland | — | merged | — |

## Drag across the boundary (DRAG-v0), started 2026-10-03

| WP | Title | OS | Depends on | Status | Branch |
|---|---|---|---|---|---|
| WP-2.55 | Hyprland seat | Linux | — | merged | — |
| WP-2.56 | macOS seat | macOS | — | delegated | `wp/2.56` |
| WP-2.58 | Agent wiring | Linux + agent | — | planned | — |
| WP-2.59 | Both seats | both | — | spec'd | — |
| WP-W0.2a | WinEvent table | Windows (model, Linux-tested) | — | merged | — |
| WP-2.60 | Old plan | Linux, macOS | — | superseded | — |

## Installer (WP-4.x)

| WP | Scope | OS | Depends on | Status | Branch |
|---|---|---|---|---|---|
| WP-4.1 | Core | OS-free | — | merged | — |
| WP-4.19 | Linux repair | Linux | — | in progress: 4.19a merged | — |
| WP-4.17 | Arch package | Linux | — | planned | — |
| WP-4.18 | DMG and notarization | macOS | — | planned | — |

## Phase 3 — Windows and MVP+ features ([PHASE3](PHASE3.md)), started 2026-10-03

| WP | Title | OS | Depends on | Status | Branch |
|---|---|---|---|---|---|
| [WP-W0.1](WP-W0.1.md) | `crosspane-platform-windows` skeleton | Windows (cross) | — | merged | — |
| [WP-W0.2a](WP-W0.2a.md) | WinEvent → `WindowEvent` table | Windows (model, Linux-tested) | W0.1 | delegated | `wp/W0.2a-winevent` |
| WP-P2 | Protocol: strict varint ranges | any | — | planned (low priority) | — |
| [WP-4.8](WP-4.8.md) | Linux support and dependency detection | Linux | 4.7 | split (4.8a/b/c) | — |
| WP-2.16 (lead) | Cursor shapes | OS-free + agent | 2.14 | merged | — |

**MVP gate (2026-10-03):** the owner's checklist is in
[MVP-gate](MVP-gate.md).

### Schedule

| Wk | Lead | Owner |
|---|---|---|
| 1 | Repo | Mac setup |

## Shared audio v0

### Speakers

| WP | Status |
|:---|---:|
| WP-C3 owner-attended speaker tests | spec'd (lead) |
| WP-1.1 duplicated codec entry | frozen |

## No package rows

[Linked reference package](WP-Q2.md).
