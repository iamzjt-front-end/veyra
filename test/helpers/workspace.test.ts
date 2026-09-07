import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFixtureWorkspace,
  type FixtureWorkspace,
  withFixtureWorkspace,
} from "./workspace.js";

const workspaces: FixtureWorkspace[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.cleanup()));
});

describe("fixture workspaces", () => {
  it("copies a runnable project into separate mutable directories", async () => {
    const first = await createFixtureWorkspace();
    workspaces.push(first);
    const second = await createFixtureWorkspace();
    workspaces.push(second);

    try {
      expect(first.path).not.toBe(second.path);
      const run = spawnSync(process.execPath, ["--test"], {
        cwd: first.path,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(run.error).toBeUndefined();
      expect(run.status, run.stdout + run.stderr).toBe(0);

      const original = await readFile(join(second.path, "src/message.js"), "utf8");
      await writeFile(join(first.path, "src/message.js"), "export const changed = true;\n");
      expect(await readFile(join(second.path, "src/message.js"), "utf8")).toBe(original);
      expect(
        await readFile(
          new URL("../fixtures/minimal-project/src/message.js", import.meta.url),
          "utf8",
        ),
      ).toBe(original);
    } finally {
      await Promise.all([first.cleanup(), second.cleanup()]);
    }

    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(second.path)).toBe(false);
    await first.cleanup();
  });

  it("cleans up after a successful callback and preserves its result", async () => {
    let path = "";
    const result = await withFixtureWorkspace(async (workspace) => {
      path = workspace.path;
      return "fixture result";
    });

    expect(result).toBe("fixture result");
    expect(existsSync(path)).toBe(false);
  });

  it("cleans up after a failed callback without swallowing the error", async () => {
    let path = "";
    const failure = new Error("deliberate fixture failure");
    await expect(
      withFixtureWorkspace(async (workspace) => {
        path = workspace.path;
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(existsSync(path)).toBe(false);
  });
});
