# README visuals

All artwork uses the Frostdev crystalline identity. The existing banner and mark
remain in `../brand/`.

- `connected-work.png`: editorial artwork generated with the built-in imagegen tool.
- `board-demo.gif`: an animated walkthrough of the actual running board, using a
  disposable Frostdev release tracker and real journal updates. Real UI views are
  joined with 30 fps editorial dissolves and a smooth return to the opening frame.
- `goldens/board-overview.png`: project lanes, progress, branches, and agent updates.
- `goldens/board-blocker.png`: a work package with an open blocker.
- `goldens/board-ready.png`: explicit completion and the review handoff.

The goldens are visual reference captures for the README, not automated pixel
comparison tests. Demo data is illustrative; none comes from a user's project.

## Regenerate board captures

Requires Node.js 24+, Playwright, a Chromium executable, and ffmpeg. Playwright is
only needed for capture; it is not a runtime dependency. If unavailable locally:

```sh
npm install --no-save --package-lock=false playwright
```

Then run from the repository:

```sh
npm run build
node scripts/generate-readme-assets.mjs
```

The script defaults to `/usr/bin/chromium`. Set `RIMEWIRE_CHROMIUM` to another
Chromium executable if needed. Set `RIMEWIRE_CAPTURE_MODULES` to a directory
containing Playwright (such as a bundled `node_modules`) to reuse an existing install.

Captures use a 1440 × 1020 dark viewport, a fixed clock, a temporary Git repository,
and the shipped board UI. The script verifies visible progress, blocker, and ready
states and checks for browser errors before encoding the GIF with ffmpeg. It cleans
up its temporary repository, browser, and local server when finished. Regeneration
replaces only the GIF and three golden PNGs; inspect them before committing.

## Imagegen prompt

Built-in tool mode; opaque background. Final prompt:

```text
Use case: ads-marketing
Asset type: wide GitHub README editorial illustration for Rimewire, a Frostdev local project board coordinating coding agents.
Primary request: Create a polished wide 3:1 arctic crystalline brand illustration, in the established Frostdev style of faceted beveled ice, icy white faces, vivid glacier cyan highlights and deep navy extruded sides.
Scene/backdrop: near-black arctic navy background with restrained frost grain, studio darkness, no scenery.
Subject: three separate angular crystalline wire paths on the left interlink into one luminous central triangular network, then fan out on the right into an ordered set of small beveled crystalline work tiles. Convey scattered agent work becoming one connected shared view. Original abstract sculptural geometry, grounded in Rimewire's interlinked icy strands.
Style/medium: refined 3D product art, precise chamfered crystal facets, delicate rim lighting, a few subtle frost particles, crisp silhouettes, premium Frostdev developer tooling identity.
Composition/framing: panoramic horizontal composition, all important geometry inside generous margins, connected pathways across the center, balanced and readable when displayed at 960px wide.
Color palette: icy white, glacier cyan, arctic blue, near-black navy; no warm colors.
Constraints: no text or letters, no UI mockups, no logos from other brands, no mascots, no emojis, no mountains, no generic robots, no lens flare, no watermark. Keep it calm, geometric and distinctly Frostdev.
```
