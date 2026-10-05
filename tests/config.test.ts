import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { defaultConfig, loadConfig, parseConfig } from "../src/config.js";

describe("project configuration", () => {
  it("validates appearance without accepting arbitrary CSS", () => {
    expect(defaultConfig().palette).toEqual({
      mode: "auto",
      colors: {},
      light: {},
      dark: {},
    });
    expect(
      parseConfig({
        palette: { dark: { accent: "#89cbd5" } },
        fonts: { sans: "Inter, system-ui" },
      }).fonts.sans,
    ).toBe("Inter, system-ui");
    for (const input of [
      { palette: { mode: "night" } },
      { palette: { light: { accent: "url(https://example.com)" } } },
      { palette: { dark: { typo: "#fff" } } },
      { fonts: { sans: "Inter; color: red" } },
      { fonts: { mono: "" } },
    ])
      expect(() => parseConfig(input)).toThrow();
  });
  it("keeps the shipped example valid", () => {
    const config = parseConfig(
      parse(
        readFileSync(
          new URL("../examples/config.toml", import.meta.url),
          "utf8",
        ),
      ),
    );
    expect(config.roadmap.milestones[0].id).toBe("foundation");
    expect(config.roadmap.platforms).toHaveLength(4);
  });
  it("ships generic and rejects invalid paths and patterns", () => {
    expect(defaultConfig().tracker).toBe("docs/board/README.md");
    expect(defaultConfig().roadmap.milestones).toEqual([]);
    expect(() =>
      parseConfig({
        roadmap: {
          milestones: [
            { id: "x", title: "first" },
            { id: "x", title: "second" },
          ],
        },
      }),
    ).toThrow("IDs must be unique");
    for (const input of [
      { tracker: "../private.md" },
      { journalDir: "/tmp/journal" },
      { idPattern: "[" },
      { roadmap: { milestones: [{ id: "x", title: "x", lane: "[" }] } },
      { typo: true },
    ])
      expect(() => parseConfig(input)).toThrow();
  });
  it("loads TOML overrides without losing defaults", () => {
    const repo = mkdtempSync(join(tmpdir(), "rimewire-config-"));
    try {
      mkdirSync(join(repo, ".rimewire"));
      writeFileSync(
        join(repo, ".rimewire/config.toml"),
        'name = "Example"\ntracker = "planning/tasks.md"\n[statuses]\ndone = ["shipped"]\n',
      );
      const config = loadConfig(repo);
      expect(config.name).toBe("Example");
      expect(config.statuses.done).toEqual(["shipped"]);
      expect(config.journalDir).toBe(".rimewire/journal");
      writeFileSync(join(repo, ".rimewire/config.toml"), "tracker = 42");
      expect(() => loadConfig(repo)).toThrow("Invalid Rimewire config");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
