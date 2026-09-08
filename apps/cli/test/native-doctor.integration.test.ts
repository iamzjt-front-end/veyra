import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProcessExecutionError, type ProcessRunner } from "@veyraoss/runtime";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { runCli } from "../src/application.js";

describe("native-first doctor", () => {
  it("makes native login sufficient despite a legacy API workflow and scopes explicit workflow checks", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const runner = vi.fn<ProcessRunner>(async (request) => ({
        exitCode: 0,
        signal: null,
        stdout:
          request.executable === "pnpm"
            ? "10.15.1"
            : request.args?.[0] === "--version"
              ? "codex-cli 0.153.4"
              : "Logged in using ChatGPT",
        stderr: request.args?.[0] === "login" ? "fixture-private-credential" : "",
        durationMs: 1,
        stdoutTruncated: false,
        stderrTruncated: false,
      }));
      const invoke = async (...args: string[]) => {
        let output = "";
        const code = await runCli(args, {
          cwd: path,
          env: {},
          runProcess: runner,
          stdout: (text) => {
            output += text;
          },
        });
        return { code, output };
      };
      const init = await invoke("init");
      expect(init.output).not.toContain("Set OPENAI_API_KEY");
      const before = await readFile(join(path, "veyra.yaml"));
      const native = await invoke("doctor", "--codex-executable", "/fixture/Codex CLI", "--json");
      expect(native.code).toBe(0);
      expect(JSON.parse(native.output)).toMatchObject({
        mode: "native",
        ready: true,
        executor: {
          provider: "codex",
          executable: "/fixture/Codex CLI",
          version: "0.153.4",
          ready: true,
          authentication: "ready",
          authenticationOwner: "native-client",
        },
      });
      expect(JSON.parse(native.output).providers).toContainEqual(
        expect.objectContaining({ provider: "openai", required: false, ready: false }),
      );
      expect(native.output).not.toContain("fixture-private-credential");
      expect(
        runner.mock.calls
          .filter(([request]) => request.executable !== "pnpm")
          .map(([request]) => [request.executable, request.args]),
      ).toEqual([
        ["/fixture/Codex CLI", ["--version"]],
        ["/fixture/Codex CLI", ["login", "status"]],
      ]);
      const selected = await invoke("doctor", "--config", "veyra.yaml", "--json");
      expect(selected.code).toBe(1);
      expect(JSON.parse(selected.output)).toMatchObject({ mode: "workflow", ready: false });
      expect(JSON.parse(selected.output).providers).toContainEqual(
        expect.objectContaining({ provider: "openai", required: true, ready: false }),
      );
      expect(await readFile(join(path, "veyra.yaml"))).toEqual(before);
      expect((await invoke("doctor")).output).toContain("API providers optional");
    });
  });

  it("does not let an API key hide a missing native executable", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      let output = "";
      const code = await runCli(["doctor", "--json"], {
        cwd: path,
        env: { OPENAI_API_KEY: "fixture-private-credential" },
        runProcess: async (request) => {
          if (request.executable !== "pnpm")
            throw new ProcessExecutionError("executable_not_found", "fixture-private-credential");
          return {
            exitCode: 0,
            signal: null,
            stdout: "10.15.1",
            stderr: "",
            durationMs: 1,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        },
        stdout: (text) => {
          output += text;
        },
      });
      expect(code).toBe(1);
      expect(JSON.parse(output).executor).toMatchObject({
        available: false,
        authentication: "unknown",
        ready: false,
      });
      expect(output).not.toContain("fixture-private-credential");
    });
  });
});
