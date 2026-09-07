import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { ShellVerifier } from "../src/index.js";

it("verifies real commands in an isolated fixture", async () => {
  await withFixtureWorkspace(async ({ path }) => {
    const report = await new ShellVerifier().verify({
      commands: ["node --check src/message.js", "node --test"],
      cwd: path,
    });
    expect(report.success).toBe(true);
    expect(report.results).toHaveLength(2);
    expect(report.results[1]?.stdout).toContain("pass 1");
  });
});

it("retains bounded output and stops after a real failing command", async () => {
  await withFixtureWorkspace(async ({ path }) => {
    await writeFile(
      join(path, "failure.cjs"),
      "process.stdout.write('x'.repeat(10000)); process.exitCode = 5;",
    );
    const report = await new ShellVerifier().verify({
      commands: ["node failure.cjs", "node --test"],
      cwd: path,
      maxOutputBytes: 32,
    });
    expect(report.success).toBe(false);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      exitCode: 5,
      stdout: "x".repeat(32),
      stdoutTruncated: true,
    });
  });
});

it("times out a real shell command", async () => {
  await withFixtureWorkspace(async ({ path }) => {
    await writeFile(join(path, "wait.cjs"), "setInterval(() => {}, 1000);");
    const report = await new ShellVerifier().verify({
      commands: ["node wait.cjs"],
      cwd: path,
      timeoutMs: 100,
    });
    expect(report.success).toBe(false);
    expect(report.results[0]?.error?.code).toBe("process_timeout");
  });
});
