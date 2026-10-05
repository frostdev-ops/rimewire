import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { type Config, parseConfig } from "../../src/config.js";

export const fixtureDirectory = fileURLToPath(new URL("./", import.meta.url));
export const projectDirectory = fileURLToPath(
  new URL("../../", import.meta.url),
);
export function crosspaneConfig(): Config {
  return parseConfig(
    parse(
      readFileSync(join(projectDirectory, "examples/crosspane.toml"), "utf8"),
    ),
  );
}
export function textFixture(name: string): string {
  return readFileSync(join(fixtureDirectory, name), "utf8");
}
export function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "rimewire-board-"));
}
export function crosspaneRepo(): string {
  const repo = tempRepo();
  cpSync(join(fixtureDirectory, "crosspane"), repo, { recursive: true });
  // Deterministic recent-file order and exact cross-language timestamps.
  for (const [index, name] of readdirSync(join(repo, "docs/wp"))
    .sort()
    .entries())
    utimesSync(
      join(repo, "docs/wp", name),
      1700000000 + index,
      1700000000 + index,
    );
  return repo;
}
export function removeRepo(repo: string): void {
  rmSync(repo, { recursive: true, force: true });
}
export function write(repo: string, path: string, text: string): void {
  const destination = join(repo, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, text);
}
export function fixtureGit(repo: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-10-01T12:00:00Z",
        GIT_COMMITTER_DATE: "2026-10-01T12:00:00Z",
      },
    },
  );
}
