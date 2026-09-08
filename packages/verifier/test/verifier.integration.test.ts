import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { ShellVerifier } from "../src/index.js";

it.skipIf(process.platform === "win32")(
  "uses POSIX quoting, environment expansion, redirection and pipelines in a Unicode cwd",
  async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const cwd = join(path, "project 你好 & spaces");
      await mkdir(cwd);
      const value = "literal $(touch forbidden) & spaces 你好";
      const report = await new ShellVerifier().verify({
        commands: [
          'printf \'%s\\n\' "$VEYRA_PLATFORM_VALUE" > "output 你好.txt"',
          'cat "output 你好.txt" | cat',
          "exit 7",
          "touch successor",
        ],
        cwd,
        env: { VEYRA_PLATFORM_VALUE: value },
      });
      expect(report.success).toBe(false);
      expect(report.results.map((result) => result.exitCode)).toEqual([0, 0, 7]);
      expect(report.results[1]?.stdout).toBe(`${value}\n`);
      expect(await readFile(join(cwd, "output 你好.txt"), "utf8")).toBe(`${value}\n`);
      for (const file of ["forbidden", "successor"])
        await expect(readFile(join(cwd, file))).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);

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
