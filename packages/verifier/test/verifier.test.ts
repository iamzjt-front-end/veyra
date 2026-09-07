import { isJsonValue, type VeyraEvent } from "@veyra/protocol";
import { ProcessExecutionError, type ProcessResult, type ProcessRunner } from "@veyra/runtime";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_VERIFICATION_TIMEOUT_MS, ShellVerifier } from "../src/index.js";

const passed: ProcessResult = {
  exitCode: 0,
  signal: null,
  stdout: "passed",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  durationMs: 12,
};
const execution = { runId: "run-1", stepId: "verify", attempt: 1 };

describe("ShellVerifier", () => {
  it("runs commands sequentially and returns an aggregate plus per-command evidence", async () => {
    let active = false;
    const run = vi.fn<ProcessRunner>(async () => {
      expect(active).toBe(false);
      active = true;
      await Promise.resolve();
      active = false;
      return passed;
    });
    const events: VeyraEvent[] = [];
    const verifier = new ShellVerifier({
      runProcess: run,
      emit: (event) => {
        events.push(event);
      },
    });
    const report = await verifier.verify({
      commands: ["pnpm check", "pnpm test", "pnpm build"],
      execution,
    });
    expect(report.success).toBe(true);
    expect(report.results.map((result) => result.command)).toEqual([
      "pnpm check",
      "pnpm test",
      "pnpm build",
    ]);
    expect(report.results.every((result) => result.success && result.durationMs === 12)).toBe(true);
    expect(report.results[0]?.execution).toEqual(execution);
    expect(events.map((event) => event.type)).toEqual([
      "verification.started",
      "verification.completed",
    ]);
    expect(isJsonValue({ report, events })).toBe(true);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[0]?.[0].timeoutMs).toBe(DEFAULT_VERIFICATION_TIMEOUT_MS);
  });

  it.each([0, 1])("stops on failing command at index %i", async (failureIndex) => {
    let index = 0;
    const run = vi.fn<ProcessRunner>(async () => ({
      ...passed,
      exitCode: index++ === failureIndex ? 3 : 0,
      stderr: "diagnostic",
    }));
    const report = await new ShellVerifier({ runProcess: run }).verify({
      commands: ["first", "second", "third"],
    });
    expect(report.success).toBe(false);
    expect(report.results).toHaveLength(failureIndex + 1);
    expect(report.results.at(-1)).toMatchObject({
      success: false,
      exitCode: 3,
      stderr: "diagnostic",
    });
    expect(run).toHaveBeenCalledTimes(failureIndex + 1);
  });

  it("succeeds without spawning for an empty command list", async () => {
    const run = vi.fn<ProcessRunner>();
    const report = await new ShellVerifier({ runProcess: run }).verify({ commands: [] });
    expect(report).toMatchObject({ success: true, results: [] });
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["timeout", "cancelled"] as const)(
    "reports %s even if a shutdown handler exits zero",
    async (terminationReason) => {
      const report = await new ShellVerifier({
        runProcess: async () => ({ ...passed, terminationReason }),
      }).verify({ commands: ["check"] });
      expect(report.success).toBe(false);
      expect(report.results[0]?.error?.code).toBe(`process_${terminationReason}`);
    },
  );

  it("normalizes runtime startup errors and does not run later commands", async () => {
    const run = vi.fn<ProcessRunner>(async () => {
      throw new ProcessExecutionError(
        "executable_not_found",
        "Local executable was not found.",
        "ENOENT",
      );
    });
    const report = await new ShellVerifier({ runProcess: run }).verify({
      commands: ["first", "second"],
    });
    expect(report.success).toBe(false);
    expect(report.results[0]).toMatchObject({
      exitCode: null,
      stdout: "",
      error: { code: "process_executable_not_found" },
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not expose an unexpected runner exception", async () => {
    const report = await new ShellVerifier({
      runProcess: async () => {
        throw new Error("private environment value");
      },
    }).verify({ commands: ["check"] });
    expect(report.success).toBe(false);
    expect(JSON.stringify(report)).not.toContain("private environment value");
    expect(report.results[0]?.error?.code).toBe("verification_process_failed");
  });

  it("forwards cwd, environment, cancellation, timeout, and output limits", async () => {
    const run = vi.fn<ProcessRunner>(async () => ({ ...passed, stdoutTruncated: true }));
    const signal = new AbortController().signal;
    const env = { VEYRA_VERIFIER_TEST: "value" };
    const report = await new ShellVerifier({ runProcess: run }).verify({
      commands: ["check && test"],
      cwd: "/fixture",
      env,
      signal,
      timeoutMs: 42,
      maxOutputBytes: 64,
    });
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      cwd: "/fixture",
      env,
      signal,
      timeoutMs: 42,
      maxOutputBytes: 64,
    });
    expect(run.mock.calls[0]?.[0].args?.at(-1)).toBe("check && test");
    expect(report.results[0]?.stdoutTruncated).toBe(true);
  });

  it("requires execution metadata when publishing shared events", async () => {
    const run = vi.fn<ProcessRunner>();
    const verifier = new ShellVerifier({ runProcess: run, emit: () => undefined });
    await expect(verifier.verify({ commands: ["check"] })).rejects.toThrow("runId and stepId");
    expect(run).not.toHaveBeenCalled();
  });

  it("does not let an event consumer mutate commands or returned evidence", async () => {
    const run = vi.fn<ProcessRunner>(async () => passed);
    const verifier = new ShellVerifier({
      runProcess: run,
      emit: (event) => {
        if (event.type === "verification.started") event.commands.push("injected");
        if (event.type === "verification.completed") event.results.length = 0;
      },
    });
    const report = await verifier.verify({ commands: ["check"], execution });
    expect(run).toHaveBeenCalledTimes(1);
    expect(report.results).toHaveLength(1);
  });

  it("propagates event persistence failures before executing commands", async () => {
    const run = vi.fn<ProcessRunner>();
    const verifier = new ShellVerifier({
      runProcess: run,
      emit: () => {
        throw new Error("event storage unavailable");
      },
    });
    await expect(verifier.verify({ commands: ["check"], execution })).rejects.toThrow(
      "event storage unavailable",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects blank commands before execution", async () => {
    const run = vi.fn<ProcessRunner>();
    await expect(
      new ShellVerifier({ runProcess: run }).verify({ commands: ["check", " "] }),
    ).rejects.toThrow("non-empty strings");
    expect(run).not.toHaveBeenCalled();
  });
});
