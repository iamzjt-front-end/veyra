import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function runCli(args: string[]) {
  return spawnSync("pnpm", ["ve", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("repository CLI entry point", () => {
  it.each([["doctor"], ["--", "doctor"]])("runs doctor with args %j", (...args) => {
    const result = runCli(args);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Veyra Doctor");
    expect(result.stdout).toContain(`Node:     ${process.version}`);
  });

  it("returns a failure for an unknown command after the separator", () => {
    const result = runCli(["--", "unknown-baseline-command"]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown command: unknown-baseline-command");
  });
});
