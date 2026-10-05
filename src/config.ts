import { readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";

export const CLASSES = [
  "done",
  "active",
  "spec",
  "planned",
  "blocked",
  "aside",
] as const;
export type StatusClass = (typeof CLASSES)[number];
const pattern = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    try {
      new RegExp(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid regular expression" });
    }
  });
const localPath = z
  .string()
  .min(1)
  .refine(
    (value) => !isAbsolute(value) && !value.split(/[\\/]/).includes(".."),
    "Must be a relative path inside the project",
  );
const platform = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    tokens: z.array(z.string()),
    note: z.string().optional(),
  })
  .strict();
const milestone = z
  .object({
    id: z.string().min(1),
    kind: z.string().default("phase"),
    title: z.string().min(1),
    lane: pattern.optional(),
    state: z.enum(["done", "active", "next", "later"]).optional(),
    note: z.string().optional(),
    doc: localPath.optional(),
    include: pattern.optional(),
    exclude: pattern.optional(),
  })
  .strict();
const color = z
  .string()
  .regex(
    /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/,
    "Use a hexadecimal CSS color",
  );
const colors = z
  .object({
    background: color.optional(),
    surface: color.optional(),
    surfaceAlt: color.optional(),
    border: color.optional(),
    borderSoft: color.optional(),
    text: color.optional(),
    textSecondary: color.optional(),
    muted: color.optional(),
    accent: color.optional(),
    accentSoft: color.optional(),
    focus: color.optional(),
    highlight: color.optional(),
    done: color.optional(),
    active: color.optional(),
    spec: color.optional(),
    planned: color.optional(),
    blocked: color.optional(),
    aside: color.optional(),
    ready: color.optional(),
    onSolid: color.optional(),
  })
  .strict()
  .default({});
const fontStack = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(
    /^[A-Za-z0-9 _,'"-]+$/,
    "Use a comma-separated local font family stack",
  );
const schema = z
  .object({
    name: z.string().min(1).default("Rimewire"),
    tracker: localPath.default("docs/board/README.md"),
    idPattern: pattern.default("[A-Za-z][A-Za-z0-9._-]*"),
    branchPrefix: z.string().min(1).default("work"),
    branchAliases: z.array(z.string().min(1)).default([]),
    journalDir: localPath.default(".rimewire/journal"),
    logo: localPath.optional(),
    palette: z
      .object({
        mode: z.enum(["auto", "light", "dark"]).default("auto"),
        colors,
        light: colors,
        dark: colors,
      })
      .strict()
      .default({ mode: "auto", colors: {}, light: {}, dark: {} }),
    stylesheet: localPath
      .refine(
        (value) => value.endsWith(".css"),
        "Use a project-relative .css file",
      )
      .optional(),
    fonts: z
      .object({
        sans: fontStack.optional(),
        mono: fontStack.optional(),
      })
      .strict()
      .default({}),
    hooks: z
      .object({
        enabled: z.boolean().default(false),
        package: z.string().min(1).optional(),
      })
      .strict()
      .default({ enabled: false }),
    statuses: z
      .object({
        done: z.array(z.string().min(1)).optional(),
        active: z.array(z.string().min(1)).optional(),
        spec: z.array(z.string().min(1)).optional(),
        planned: z.array(z.string().min(1)).optional(),
        blocked: z.array(z.string().min(1)).optional(),
        aside: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .default({}),
    roadmap: z
      .object({
        platforms: z.array(platform).default([
          {
            id: "linux",
            label: "Linux",
            tokens: ["linux", "hyprland", "both"],
          },
          { id: "macos", label: "macOS", tokens: ["macos", "mac", "both"] },
          { id: "windows", label: "Windows", tokens: ["windows"] },
          { id: "shared", label: "Shared", tokens: [] },
        ]),
        fewRows: z.number().int().nonnegative().default(10),
        milestones: z.array(milestone).default([]),
      })
      .strict()
      .default({
        platforms: [
          {
            id: "linux",
            label: "Linux",
            tokens: ["linux", "hyprland", "both"],
          },
          { id: "macos", label: "macOS", tokens: ["macos", "mac", "both"] },
          { id: "windows", label: "Windows", tokens: ["windows"] },
          { id: "shared", label: "Shared", tokens: [] },
        ],
        fewRows: 10,
        milestones: [],
      }),
  })
  .strict()
  .superRefine((config, ctx) => {
    for (const key of ["platforms", "milestones"] as const) {
      const seen = new Set<string>();
      for (const [index, item] of config.roadmap[key].entries()) {
        if (seen.has(item.id))
          ctx.addIssue({
            code: "custom",
            path: ["roadmap", key, index, "id"],
            message: "IDs must be unique",
          });
        seen.add(item.id);
      }
    }
  });
export type Config = z.infer<typeof schema>;
export type PlatformConfig = Config["roadmap"]["platforms"][number];
export type MilestoneConfig = Config["roadmap"]["milestones"][number];
export function parseConfig(input: unknown): Config {
  return schema.parse(input);
}
export function defaultConfig(name = "Rimewire"): Config {
  return parseConfig({ name });
}
export function loadConfig(repo: string): Config {
  const path = join(repo, ".rimewire", "config.toml");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return defaultConfig(basename(resolve(repo)));
    throw error;
  }
  try {
    return parseConfig(parse(text));
  } catch (error) {
    throw new Error(
      `Invalid Rimewire config at ${path}: ${(error as Error).message}`,
      { cause: error },
    );
  }
}
/** Resolve an already-validated project-relative path. */
export function projectPath(repo: string, path: string): string {
  const result = resolve(repo, path);
  const rel = relative(resolve(repo), result);
  if (
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  )
    throw new Error("Path escapes project");
  return result;
}
