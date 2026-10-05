import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

it("applies mode-specific appearance and restores defaults after overrides are removed", () => {
  const apply = runInNewContext(
    `${readFileSync(new URL("../static/appearance.js", import.meta.url), "utf8").replace("export function", "function")}\napplyAppearance;`,
  );
  const values = new Map<string, string>();
  const root = {
    dataset: { theme: "" },
    style: {
      setProperty: (key: string, value: string) => values.set(key, value),
      removeProperty: (key: string) => values.delete(key),
    },
  };
  const project = {
    palette: {
      mode: "auto",
      colors: { surface: "#eee", accent: "#000" },
      light: { accent: "#123456" },
      dark: { accent: "#abcdef", done: "#123" },
    },
    fonts: { sans: "Georgia, serif", mono: "Menlo, monospace" },
  };
  apply(root, project, false);
  expect(values.get("--surface")).toBe("#eee");
  expect(values.get("--accent")).toBe("#123456");
  expect(values.get("--sans")).toBe("Georgia, serif");
  apply(root, project, true);
  expect(values.get("--accent")).toBe("#abcdef");
  expect(values.get("--focus")).toBe("#abcdef");
  expect(values.get("--c-ready")).toBe("#123");
  project.palette.mode = "light";
  apply(root, project, true);
  expect(values.get("--accent")).toBe("#123456");
  expect(values.has("--c-ready")).toBe(false);
  expect(root.dataset.theme).toBe("light");
  apply(root, {}, false);
  expect(values.size).toBe(0);
  expect(root.dataset.theme).toBe("auto");
});
