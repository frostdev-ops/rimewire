import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (path: unknown, ...args: unknown[]) => {
      if (path === "/proc/sys/kernel/random/boot_id")
        throw new Error("process identity metadata unavailable");
      return Reflect.apply(fs.readFileSync, fs, [path, ...args]);
    },
  };
});

import { runDaemon } from "../src/daemon.js";

it.skipIf(process.platform !== "linux")(
  "refuses to publish an owner claim when process identity cannot be established",
  async () => {
    const state = mkdtempSync(join(tmpdir(), "rimewire-identity-"));
    try {
      await expect(runDaemon(0, state)).rejects.toThrow(
        "cannot read process start identity",
      );
      expect(existsSync(join(state, "daemon.json"))).toBe(false);
      expect(existsSync(join(state, "startup"))).toBe(false);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  },
);
