import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Paths belong to the installed package, never to the current project. */
export function installedPaths(root = packageRoot) {
  if (!isAbsolute(root))
    throw new Error("Rimewire package root must be absolute.");
  return {
    plugin: pathToFileURL(join(root, "adapters/opencode/index.mjs")).href,
    cli: join(root, "dist/cli.js"),
    skills: join(root, "skills"),
  };
}

/** OpenCode embeds Bun: its process.execPath is not a Node executable. */
export function nodeExecutable() {
  try {
    const runtime = process.versions.bun
      ? JSON.parse(
          execFileSync(
            "node",
            [
              "-e",
              "process.stdout.write(JSON.stringify({path:process.execPath,version:process.versions.node,bun:!!process.versions.bun}))",
            ],
            {
              encoding: "utf8",
              timeout: 3000,
              stdio: ["ignore", "pipe", "ignore"],
            },
          ),
        )
      : { path: process.execPath, version: process.versions.node, bun: false };
    if (
      runtime.bun ||
      typeof runtime.path !== "string" ||
      !isAbsolute(runtime.path) ||
      !/^\d+\./.test(runtime.version) ||
      Number(runtime.version.split(".")[0]) < 24
    )
      throw new Error();
    return runtime.path;
  } catch {
    throw new Error("Rimewire requires an available Node.js 24+ runtime.");
  }
}

/** Preflight before mutating OpenCode's resolved config. */
export function checkedPaths(root = packageRoot) {
  const paths = installedPaths(root);
  try {
    if (
      !statSync(paths.cli).isFile() ||
      !statSync(join(paths.skills, "rimewire-setup/SKILL.md")).isFile()
    )
      throw new Error();
  } catch {
    throw new Error(
      "Rimewire installed runtime or shared setup skill is missing.",
    );
  }
  return paths;
}
