// Capture the real board with a disposable Frostdev demo project.
// Requires a built runtime, Playwright, Chromium, and ffmpeg (see assets/readme/README.md).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBoardServer } from "../dist/server.js";
import { append, make } from "../dist/journal.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(
  require.resolve("playwright", {
    paths: [process.env.RIMEWIRE_CAPTURE_MODULES || root],
  }),
);
const scratch = mkdtempSync(join(tmpdir(), "rimewire-readme-"));
const project = join(scratch, "frostdev");
const output = join(root, "assets/readme");
const goldens = join(output, "goldens");
const epoch = Date.parse("2026-10-01T16:00:00Z");
const actualNow = Date.now;
Date.now = () => epoch;
let browser;
let server;
let sequence = 0;

function write(path, text) {
  const target = join(project, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
  utimesSync(target, epoch / 1000 - 300, epoch / 1000 - 300);
}

function git(...args) {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Frostdev Demo",
      "-c",
      "user.email=demo@frostdev.invalid",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    {
      cwd: project,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-10-01T15:45:00Z",
        GIT_COMMITTER_DATE: "2026-10-01T15:45:00Z",
      },
      stdio: "pipe",
    },
  );
}

function note(wp, kind, text, percent = null, author = "agent-build") {
  const update = make(wp, kind, text, percent, author, "cli");
  update.time = epoch / 1000 - 180 + sequence++;
  append(project, update);
  server?.poll();
}

try {
  mkdirSync(goldens, { recursive: true });
  write(".gitignore", ".rimewire/journal/\n");
  write(
    ".rimewire/config.toml",
    `name = "Frostdev / Release board"
tracker = "docs/board/README.md"
idPattern = 'TASK-[0-9]+'
branchPrefix = "work"
logo = "assets/mark.png"
[palette]
mode = "dark"
[palette.colors]
accent = "#89cbd5"
focus = "#89cbd5"
[palette.dark]
background = "#0d141b"
surface = "#131c25"
text = "#e4eaf0"
`,
  );
  mkdirSync(join(project, "assets"), { recursive: true });
  copyFileSync(
    join(root, "assets/brand/rimewire-mark.png"),
    join(project, "assets/mark.png"),
  );
  const lanes = [
    [
      "Foundation",
      [
        ["TASK-1", "Local project setup", "done", "—", "—"],
        ["TASK-2", "Shared tracker & specs", "done", "TASK-1", "—"],
        [
          "TASK-3",
          "Live agent updates",
          "in progress",
          "TASK-2",
          "work/TASK-3-live-updates",
        ],
      ],
    ],
    [
      "Delivery",
      [
        [
          "TASK-4",
          "Review handoffs",
          "in progress",
          "TASK-3",
          "work/TASK-4-review",
        ],
        ["TASK-5", "Harness integrations", "spec'd", "TASK-2", "—"],
        ["TASK-6", "Release verification", "planned", "TASK-4, TASK-5", "—"],
      ],
    ],
  ];
  write(
    "docs/board/README.md",
    "# Frostdev release\n\n" +
      lanes
        .map(
          ([title, rows]) =>
            `## ${title}\n\n| ID | Title | OS | Depends on | Status | Branch |\n|---|---|---|---|---|---|\n` +
            rows
              .map(
                ([id, name, status, depends, branch]) =>
                  `| [${id}](${id}.md) | ${name} | shared | ${depends} | ${status} | ${branch} |`,
              )
              .join("\n"),
        )
        .join("\n\n") +
      "\n\n## Owner actions\n\n- [x] Agree the release scope\n- [ ] Review TASK-4 when acceptance checks pass\n",
  );
  for (const [, rows] of lanes) {
    for (const [id, title] of rows) {
      write(
        `docs/board/${id}.md`,
        `# ${id} — ${title}\n\n**Why:** Keep every agent working from the same project context.\n\n## Acceptance\n\n- Read the shared specification before starting.\n- Post progress and blockers from the working checkout.\n- Hand off for review after the acceptance checks pass.\n`,
      );
    }
  }
  git("init", "-b", "main");
  git("add", ".");
  git("commit", "-m", "Define the Frostdev release tracker");
  git("branch", "work/TASK-3-live-updates");
  git("branch", "work/TASK-4-review");
  note(
    "TASK-1",
    "ready",
    "Project config and managed instructions verified.",
    null,
    "agent-setup",
  );
  note(
    "TASK-2",
    "ready",
    "Shared tracker and package specs are in place.",
    null,
    "agent-setup",
  );
  note("TASK-3", "progress", "Journal updates appear on the live board.", 65);
  note(
    "TASK-4",
    "progress",
    "Review drawer and acceptance checklist connected.",
    35,
    "agent-review",
  );
  server = createBoardServer(project, {
    pollInterval: 100,
    heartbeatInterval: 1000,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  browser = await chromium.launch({
    executablePath: process.env.RIMEWIRE_CHROMIUM || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1020 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.setFixedTime(new Date(epoch));
  await page.goto(`http://127.0.0.1:${server.address().port}/`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector('#live[data-state="live"]');
  await page.waitForSelector('.card[data-key="TASK-4"]');
  await page.locator("#rm-toggle").click();
  await page.mouse.move(1430, 1010);

  const frames = [];
  async function capture(name, duration = 2.5) {
    // A fresh view keeps captures free of transient notifications and stale drawer metadata.
    const path = join(scratch, `${frames.length}.png`);
    const still = await context.newPage();
    still.on("pageerror", (error) => errors.push(error.message));
    await still.clock.setFixedTime(new Date(epoch));
    await still.addInitScript(() =>
      localStorage.setItem("rimewire.roadmap", "false"),
    );
    await still.goto(page.url(), { waitUntil: "domcontentloaded" });
    await still.waitForSelector('#live[data-state="live"]');
    await still.waitForSelector('.card[data-key="TASK-4"]');
    if (new URL(page.url()).hash)
      await still.waitForSelector("#drawer .d-updates");
    if (name === "board-blocker")
      await still.waitForSelector("#drawer .callout.warn");
    if (name === "board-ready") {
      await still.waitForSelector("#drawer .callout.ready");
      assert.match(
        await still.locator("#drawer .d-top").textContent(),
        /ready/,
      );
    }
    await still.screenshot({ path, animations: "disabled" });
    frames.push({ path, duration });
    if (name) copyFileSync(path, join(goldens, `${name}.png`));
    await still.close();
  }
  await capture("board-overview", 3);
  note(
    "TASK-4",
    "progress",
    "Handoff flow implemented; acceptance checks running.",
    70,
    "agent-review",
  );
  await page.waitForFunction(() =>
    document
      .querySelector('.card[data-key="TASK-4"]')
      .textContent.includes("70%"),
  );
  await capture(null);
  note(
    "TASK-4",
    "blocker",
    "Waiting for the review checklist decision.",
    null,
    "agent-review",
  );
  await page.waitForSelector('.card[data-key="TASK-4"].st-blocked');
  await page.locator('.card[data-key="TASK-4"]').click();
  await page.waitForSelector("#drawer .callout.warn");
  await capture("board-blocker", 3);
  note("TASK-4", "unblock", "Review checklist agreed.", null, "lead");
  note(
    "TASK-4",
    "progress",
    "Checklist verified; final acceptance checks running.",
    90,
    "agent-review",
  );
  await page.waitForFunction(() =>
    document.querySelector("#drawer .d-meter")?.textContent.includes("90%"),
  );
  await capture(null);
  note(
    "TASK-4",
    "ready",
    "Acceptance checks passed. Ready for owner review.",
    null,
    "agent-review",
  );
  await page.waitForSelector("#drawer .callout.ready");
  assert.equal(server.state.board.totals.done, 3);
  // Reopen the details as a person would to refresh the complete package metadata.
  await page.locator("#drawer-close").click();
  await page.locator('.card[data-key="TASK-4"]').first().click();
  await page.waitForSelector("#drawer .callout.ready");
  await capture("board-ready", 4);
  await page.locator("#drawer-close").click();
  await capture(null, 2);
  assert.deepEqual(
    errors,
    [],
    "The board should render without browser errors",
  );
  frames.push({ ...frames[0], duration: 2 });
  // These are editorial dissolves between real UI captures, not simulated product animation.
  // A 30 fps timeline gives each transition 18 frames instead of an abrupt still-image cut.
  const fade = 0.6;
  const filters = frames.map(
    (_, i) =>
      `[${i}:v]fps=30,scale=960:-1:flags=lanczos,format=yuv444p,settb=AVTB,setpts=PTS-STARTPTS[v${i}]`,
  );
  let previous = "v0";
  let elapsed = frames[0].duration;
  for (let i = 1; i < frames.length; i++) {
    const next = `blend${i}`;
    filters.push(
      `[${previous}][v${i}]xfade=transition=fade:duration=${fade}:offset=${(elapsed - fade).toFixed(3)}[${next}]`,
    );
    elapsed += frames[i].duration - fade;
    previous = next;
  }
  // Finish on the original overview so the infinite loop has no jump.
  filters.push(
    `[${previous}]split[a][b]`,
    "[a]palettegen=max_colors=128[p]",
    "[b][p]paletteuse=dither=none",
  );
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-filter_complex_threads",
    "1",
    ...frames.flatMap(({ path, duration }) => [
      "-loop",
      "1",
      "-framerate",
      "30",
      "-t",
      String(duration),
      "-i",
      path,
    ]),
    "-filter_complex",
    filters.join(";"),
    "-loop",
    "0",
    join(output, "board-demo.gif"),
  ]);
  console.log(`Saved ${goldens} and ${join(output, "board-demo.gif")}`);
} finally {
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  Date.now = actualNow;
  rmSync(scratch, { recursive: true, force: true });
}
