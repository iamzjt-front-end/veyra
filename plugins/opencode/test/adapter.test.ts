import { type AgentInput, isJsonValue } from "@veyraoss/protocol";
import {
  ProcessExecutionError,
  type ProcessResult,
  type ProcessRunner,
  runProcess,
} from "@veyraoss/runtime";
import { describe, expect, it, vi } from "vitest";
import { OpenCodeAdapter, type OpenCodeAdapterOptions } from "../src/index.js";
import { buildPrompt } from "../src/input.js";
import { claim, completed, events, help, input, record, withVersion } from "./fixtures.js";

describe("OpenCode runtime adapter", () => {
  it("advertises executor capabilities without processes and validates configured models", () => {
    const runner = vi.fn<ProcessRunner>();
    const adapter = new OpenCodeAdapter(
      { id: "coding", model: "provider/model" },
      { runProcess: runner },
    );
    expect(adapter.describe()).toMatchObject({
      permissions: { mode: "unknown", source: "native-configuration" },
      id: "coding",
      provider: "opencode",
      model: "provider/model",
      roles: ["executor"],
      capabilities: ["code-execution", "tool-use", "local-cli", "structured-output"],
    });
    expect(runner).not.toHaveBeenCalled();
  });
  it("preflights the supported release and sends literal stdin with sharing/auto mode disabled", async () => {
    const runner = vi.fn<ProcessRunner>(withVersion(async () => completed()));
    const options = {
      executable: "/custom/opencode",
      model: "provider/model",
      workingDirectory: "/configured",
    };
    const adapter = new OpenCodeAdapter(options, { runProcess: runner, env: {} });
    options.model = "mutated/model";
    const result = await adapter.run(input, { cwd: "/target", timeoutMs: 42000 });
    expect(runner.mock.calls[0]?.[0]).toMatchObject({
      args: ["--version"],
      timeoutMs: 5000,
      env: { OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_SHARE: "true" },
    });
    const request = runner.mock.calls[1]?.[0];
    expect(request).toMatchObject({
      executable: "/custom/opencode",
      cwd: "/target",
      timeoutMs: 42000,
      maxOutputBytes: 65536,
      env: {
        PWD: "/target",
        OPENCODE_DISABLE_SHARE: "true",
        OPENCODE_AUTO_SHARE: "false",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
      },
    });
    expect(request?.args).toEqual([
      "run",
      "--format",
      "json",
      "--dir",
      "/target",
      "--title",
      "Veyra executor",
      "--no-auto",
      "--no-thinking",
      "--model=provider/model",
    ]);
    expect(request?.args?.join(" ")).not.toContain(input.goal);
    expect(request?.stdin).toContain("AGENTS.md");
    expect(request?.stdin).not.toContain("@");
    expect(
      JSON.parse(
        String(request?.stdin ?? "").split("Task envelope (decode JSON string escapes):\n\n")[1] ??
          "",
      ),
    ).toEqual(input);
    expect(result).toMatchObject({
      status: "success",
      execution: {
        runId: "run",
        stepId: "execute",
        attemptId: "attempt",
        attempt: 2,
        parentStepId: "parent",
      },
      data: { changedFiles: claim.changedFiles, commandsRun: claim.commandsRun },
    });
    expect(isJsonValue(result)).toBe(true);
    expect(result.timing?.durationMs).toBeGreaterThanOrEqual(0);
  });
  it.each(["1.18.28", "1.17.99", "1.18.29-preview", "2.0.0", "unexpected"])(
    "refuses unsupported %s before creating a native session",
    async (version) => {
      const runner = vi.fn<ProcessRunner>(async () => completed({ stdout: version }));
      expect((await new OpenCodeAdapter({}, { runProcess: runner }).run(input)).error?.code).toBe(
        "opencode_unsupported_version",
      );
      expect(runner).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    [{ exitCode: 1 }, "process_failed"],
    [{ exitCode: null, signal: "SIGTERM" }, "process_failed"],
    [{ terminationReason: "timeout" }, "timeout"],
    [{ terminationReason: "cancelled" }, "cancelled"],
    [{ exitCode: 130 }, "cancelled"],
    [{ stdout: "human output" }, "invalid_output"],
    [{ stdoutTruncated: true }, "invalid_output"],
  ] satisfies [Partial<ProcessResult>, string][])(
    "normalizes native completion %#",
    async (fields, code) => {
      const result = await new OpenCodeAdapter(
        {},
        { runProcess: withVersion(async () => completed(fields)) },
      ).run(input);
      expect(result).toMatchObject({
        status: "failure",
        error: { code: `opencode_${code}` },
        data: { process: fields },
      });
    },
  );
  it("preserves an authentication pause on a failed native process exit", async () => {
    const result = await new OpenCodeAdapter(
      {},
      {
        runProcess: withVersion(async () =>
          completed({
            exitCode: 1,
            stdout: record("error", {
              error: { name: "ProviderAuthError", data: { message: "private provider text" } },
            }),
          }),
        ),
      },
    ).run(input);
    expect(result).toMatchObject({
      status: "needs_input",
      error: { code: "opencode_auth_required" },
    });
    expect(result.summary).not.toContain("private provider text");
  });
  it.each([
    "executable_not_found",
    "invalid_cwd",
    "spawn_failed",
    "stdin_failed",
    "output_callback_failed",
    "termination_failed",
  ] as const)("normalizes runtime %s without echoing exceptions", async (code) => {
    const result = await new OpenCodeAdapter(
      {},
      {
        runProcess: async () => {
          throw new ProcessExecutionError(
            code,
            "private error",
            "ENOENT",
            completed({ exitCode: null }),
          );
        },
      },
    ).run(input);
    expect(result.error?.code).toBe(
      `opencode_${code === "executable_not_found" ? "not_found" : code}`,
    );
    expect(JSON.stringify(result)).not.toContain("private error");
  });
  it("rejects invalid input and pre-cancellation without probing", async () => {
    const runner = vi.fn<ProcessRunner>();
    const adapter = new OpenCodeAdapter({}, { runProcess: runner });
    expect((await adapter.run(input, { signal: AbortSignal.abort() })).error?.code).toBe(
      "opencode_cancelled",
    );
    expect((await adapter.run(input, { timeoutMs: 0 })).error?.code).toBe(
      "opencode_invalid_timeout",
    );
    expect((await adapter.run({ ...input, role: "planner" })).error?.code).toBe(
      "opencode_unsupported_role",
    );
    expect((await adapter.run({ ...input, goal: " " })).error?.code).toBe("opencode_invalid_input");
    expect(
      (await adapter.run({ ...input, context: { native: new Date() } } as unknown as AgentInput))
        .error?.code,
    ).toBe("opencode_invalid_input");
    expect((await adapter.run({ ...input, goal: "x".repeat(256 * 1024) })).error?.code).toBe(
      "opencode_input_too_large",
    );
    expect(runner).not.toHaveBeenCalled();
  });
  it("shares one cancellable deadline across version preflight and execution, then disposes it", async () => {
    const signals: AbortSignal[] = [];
    const runner: ProcessRunner = async (request) => {
      signals.push(request.signal as AbortSignal);
      if (request.args?.[0] === "--version") return completed({ stdout: "1.18.29" });
      return new Promise((resolve) =>
        request.signal?.addEventListener(
          "abort",
          () => resolve(completed({ terminationReason: "cancelled" })),
          { once: true },
        ),
      );
    };
    expect(
      (await new OpenCodeAdapter({}, { runProcess: runner }).run(input, { timeoutMs: 10 })).error
        ?.code,
    ).toBe("opencode_timeout");
    expect(signals[0]).toBe(signals[1]);
    const controller = new AbortController();
    const listener = vi.spyOn(controller.signal, "removeEventListener");
    const fast = new OpenCodeAdapter({}, { runProcess: withVersion(async () => completed()) });
    expect((await fast.run(input, { signal: controller.signal })).status).toBe("success");
    expect(listener).toHaveBeenCalledWith("abort", expect.any(Function));
  });
  it("uses real Runtime stdin/streaming independently of retained prefixes", async () => {
    const runner = withVersion((request) =>
      runProcess({
        ...request,
        executable: process.execPath,
        args: [
          "--input-type=module",
          "-e",
          `let input=""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => input+=chunk); process.stdin.on("end", () => { if (!input.includes("Repair $(literal)")) process.exit(2); process.stdout.write(${JSON.stringify(events())}); console.error("fixture diagnostic"); });`,
        ],
      }),
    );
    const result = await new OpenCodeAdapter({ maxOutputBytes: 10 }, { runProcess: runner }).run(
      input,
      { timeoutMs: 10000 },
    );
    expect(result.status).toBe("success");
    expect(result.data?.process).toMatchObject({
      stdoutTruncated: true,
      stderrTruncated: true,
      stderr: "fixture di",
    });
  });
  it("redacts configured credentials and encoded diagnostics while preserving native auth configuration", async () => {
    const key = 'fixture-key-"quote';
    const result = await new OpenCodeAdapter(
      {},
      {
        env: { CUSTOM_API_KEY: key },
        runProcess: withVersion(async (request) => {
          expect(request.stdin).not.toMatch(/fixture-key|nested-secret/);
          expect(request.env).not.toHaveProperty("OPENCODE_CONFIG_CONTENT");
          expect(request.env).not.toHaveProperty("OPENCODE_PERMISSION");
          return completed({
            stdout: events({ ...claim, summary: key, commandsRun: [key] }),
            stderr: `Bearer private-bearer ${key}`,
          });
        }),
      },
    ).run({ ...input, context: { note: key, token: "nested-secret", env: { NAME: "hidden" } } });
    expect(JSON.stringify(result)).not.toMatch(/fixture-key|nested-secret|private-bearer/);
    expect(result.summary).toBe("[REDACTED]");
  });
  it.each(
    [
      null,
      [],
      { model: "missing-provider" },
      { model: "provider/" },
      { model: "provider/model with whitespace" },
      { agent: "unknown" },
      { auto: true },
      { args: ["--share"] },
      { executable: "" },
      { id: "x".repeat(129) },
      { timeoutMs: 0 },
      { maxOutputBytes: -1 },
      { maxOutputBytes: 2 ** 21 },
    ].map((options) => [options]),
  )("rejects unsupported options %#", (options) => {
    expect(() => new OpenCodeAdapter(options as OpenCodeAdapterOptions)).toThrow();
  });
  it("rejects accessors without executing them", () => {
    const getter = vi.fn();
    expect(
      () =>
        new OpenCodeAdapter(Object.defineProperty({}, "model", { enumerable: true, get: getter })),
    ).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      buildPrompt({ ...input, context: { native: new Date() } } as unknown as AgentInput, {}),
    ).toThrow();
  });
});

describe("OpenCode local readiness", () => {
  const runnerFor = () =>
    vi.fn<ProcessRunner>(withVersion(async () => completed({ stdout: help })));
  it.each(["stdout", "stderr"])(
    "checks run help on %s without an inference or auth-file probe",
    async (stream) => {
      const runner = vi.fn<ProcessRunner>(
        withVersion(async () => completed({ stdout: "", [stream]: help })),
      );
      expect(await new OpenCodeAdapter({}, { runProcess: runner }).checkReadiness()).toMatchObject({
        status: "ready",
        scope: "local",
        version: "1.18.29",
        message: expect.stringContaining("authentication and model access were not tested"),
      });
      expect(runner.mock.calls.map(([request]) => request.args)).toEqual([
        ["--version"],
        ["run", "--help"],
      ]);
      expect(
        runner.mock.calls.every(
          ([request]) => request.env?.OPENCODE_DISABLE_MODELS_FETCH === "true",
        ),
      ).toBe(true);
    },
  );
  it("detects missing executables and unsupported flags", async () => {
    const missing: ProcessRunner = async () => {
      throw new ProcessExecutionError("executable_not_found", "private detail");
    };
    expect((await new OpenCodeAdapter({}, { runProcess: missing }).checkReadiness()).status).toBe(
      "unavailable",
    );
    expect(
      (
        await new OpenCodeAdapter(
          {},
          { runProcess: withVersion(async () => completed({ stdout: "--format" })) },
        ).checkReadiness()
      ).status,
    ).toBe("unavailable");
  });
  it.each(["1.18.28", "1.18.29-preview", "2.0.0"])(
    "reports unsupported %s before help",
    async (version) => {
      const runner = vi.fn<ProcessRunner>(async () => completed({ stdout: version }));
      expect((await new OpenCodeAdapter({}, { runProcess: runner }).checkReadiness()).status).toBe(
        "unavailable",
      );
      expect(runner).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    { stdout: "unexpected" },
    { exitCode: 1 },
    { stdoutTruncated: true },
    { terminationReason: "timeout" },
  ] satisfies Partial<ProcessResult>[])(
    "reports inconclusive version probes %#",
    async (fields) => {
      expect(
        (
          await new OpenCodeAdapter(
            {},
            { runProcess: async () => completed(fields) },
          ).checkReadiness()
        ).status,
      ).toBe("unknown");
    },
  );
  it("rejects invalid controls before spawning and enforces a shared readiness deadline", async () => {
    const runner = runnerFor();
    const adapter = new OpenCodeAdapter({}, { runProcess: runner });
    expect((await adapter.checkReadiness({ signal: AbortSignal.abort() })).status).toBe("unknown");
    expect((await adapter.checkReadiness({ timeoutMs: 0 })).status).toBe("unknown");
    expect(runner).not.toHaveBeenCalled();
    const slow: ProcessRunner = async (request) =>
      new Promise((resolve) =>
        request.signal?.addEventListener(
          "abort",
          () => resolve(completed({ terminationReason: "cancelled" })),
          { once: true },
        ),
      );
    expect(
      (await new OpenCodeAdapter({}, { runProcess: slow }).checkReadiness({ timeoutMs: 10 }))
        .status,
    ).toBe("unknown");
  });
});
