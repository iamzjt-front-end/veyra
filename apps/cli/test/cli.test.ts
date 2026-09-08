import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function runCli(args: string[]) {
  return spawnSync("pnpm", ["ve", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("repository CLI entry point", () => {
  it.each([["doctor"], ["--", "doctor"]])("runs doctor with args %j", async (...args) => {
    await withFixtureWorkspace(async ({ path }) => {
      const executable = resolve(path, "fixture-codex.cjs");
      await writeFile(
        executable,
        '#!/usr/bin/env node\nconsole.log(process.argv[2] === "--version" ? "codex-cli 1.2.3" : "Logged in using ChatGPT");\n',
        { mode: 0o700 },
      );
      const result = runCli([...args, "--codex-executable", executable]);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Veyra Doctor");
      expect(result.stdout).toContain(`Node:     ${process.version}`);
      expect(result.stdout).toContain(`CWD:      ${resolve(repositoryRoot)}`);
    });
  });

  it("returns a failure for an unknown command after the separator", () => {
    const result = runCli(["--", "unknown-baseline-command"]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown command: unknown-baseline-command");
  });
});
