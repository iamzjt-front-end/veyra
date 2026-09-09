import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { initializeProject, saveProjectBindings } from "@veyraoss/project";
import type { ProcessRunner } from "@veyraoss/runtime";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { nativeProjectReadiness } from "../src/native-project-readiness.js";
import { argumentsFor } from "../src/arguments.js";

describe("loopback native CLI composition", () => {
  it("requires an explicit native binding and reports existing check IDs without an API key", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const project = await initializeProject(path);
      const runner = vi.fn<ProcessRunner>(async (request) => ({
        exitCode: 0,
        signal: null,
        stdout: request.args?.[0] === "--version" ? "codex-cli 0.153.4" : "Logged in using ChatGPT",
        stderr: "",
        durationMs: 1,
        stdoutTruncated: false,
        stderrTruncated: false,
      }));
      expect((await nativeProjectReadiness(project, {}, runner)).ready).toBe(false);
      expect(runner).not.toHaveBeenCalled();
      await saveProjectBindings(project, { executor: { provider: "codex", mode: "native" } }, 0);
      await writeFile(
        join(path, "veyra.yaml"),
        JSON.stringify({ version: 1, agents: {}, workflow: { use: "./checks.yaml" } }),
      );
      await writeFile(
        join(path, "checks.yaml"),
        JSON.stringify({
          version: 1,
          name: "checks",
          start: "test",
          steps: { test: { type: "command", run: ["node --test"] } },
        }),
      );
      expect(await nativeProjectReadiness(project, {}, runner)).toMatchObject({
        ready: true,
        checks: [{ id: "test" }],
      });
      expect(runner.mock.calls.map(([request]) => request.args)).toEqual([
        ["--version"],
        ["login", "status"],
      ]);
      runner.mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: 1,
        stdoutTruncated: false,
        stderrTruncated: false,
      });
      expect((await nativeProjectReadiness(project, {}, runner)).ready).toBe(false);
    });
  });
  it("requires the full opt-in HTTP setting set on daemon start only", () => {
    expect(() => argumentsFor(["daemon", "start", "--http-port", "3181"])).toThrow();
    expect(() =>
      argumentsFor([
        "daemon",
        "status",
        "--http-port",
        "3181",
        "--http-origin",
        "fixture",
        "--http-project",
        "fixture",
      ]),
    ).toThrow();
    expect(
      argumentsFor([
        "daemon",
        "start",
        "--http-port",
        "3181",
        "--http-origin",
        `chrome-extension://${"a".repeat(32)}`,
        "--http-project",
        "fixture",
      ]).values["http-port"],
    ).toBe("3181");
  });
});
