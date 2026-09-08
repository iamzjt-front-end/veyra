import { type AgentInput, isJsonValue } from "@veyra/protocol";
import {
  ProcessExecutionError,
  type ProcessResult,
  type ProcessRunner,
  runProcess,
} from "@veyra/runtime";
import { describe, expect, it, vi } from "vitest";
import { GeminiCliAdapter, type GeminiCliAdapterOptions } from "../src/cli.js";
import { cliPrompt } from "../src/cli-input.js";
import { GeminiCliOutput } from "../src/cli-output.js";

const input: AgentInput = {
  runId: "run",
  stepId: "execute",
  attemptId: "attempt",
  attempt: 2,
  parentStepId: "parent",
  role: "executor",
  goal: "Repair $(literal) `greeting` @/private/file",
  instructions: "Change only src/message.js",
  context: { planner: { instructions: "Use expected greeting" } },
};
const claim = {
  status: "success",
  summary: "Repaired greeting",
  changedFiles: ["src/message.js"],
  commandsRun: ["node --test"],
};
const envelope = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({ response: JSON.stringify(claim), ...fields });
const completed = (fields: Partial<ProcessResult> = {}): ProcessResult => ({
  exitCode: 0,
  signal: null,
  stdout: envelope(),
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  durationMs: 3,
  ...fields,
});
const help = "--prompt --output-format --approval-mode";
const parse = (value: string) => {
  const output = new GeminiCliOutput();
  output.feed(value);
  return { result: output.finish(), usage: output.usage };
};

describe("Gemini CLI execution", () => {
  it("describes only its native executor path without processes or API construction", () => {
    const runner = vi.fn<ProcessRunner>();
    const adapter = new GeminiCliAdapter(
      { id: "coding", model: "selected" },
      { runProcess: runner },
    );
    expect(adapter.describe()).toMatchObject({
      id: "coding",
      provider: "gemini-cli",
      model: "selected",
      roles: ["executor"],
      capabilities: ["code-execution", "tool-use", "local-cli", "structured-output"],
    });
    adapter.describe().roles.push("planner");
    expect(adapter.describe().roles).toEqual(["executor"]);
    expect(runner).not.toHaveBeenCalled();
  });
  it("uses literal stdin, prevents native file inclusion and preserves native policies", async () => {
    const runner = vi.fn<ProcessRunner>(async () => completed());
    const options = {
      executable: "/custom/gemini",
      model: "configured model",
      workingDirectory: "/configured",
    };
    const adapter = new GeminiCliAdapter(options, { runProcess: runner, env: {} });
    options.model = "mutated";
    const signal = new AbortController().signal;
    const result = await adapter.run(input, { cwd: "/target", timeoutMs: 42000, signal });
    const request = runner.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      executable: "/custom/gemini",
      cwd: "/target",
      timeoutMs: 42000,
      signal,
      maxOutputBytes: 65536,
    });
    expect(request?.args).toEqual([
      "--prompt",
      expect.any(String),
      "--output-format",
      "json",
      "--approval-mode",
      "default",
      "--model=configured model",
    ]);
    expect(request?.args?.join(" ")).not.toContain(input.goal);
    expect(request?.stdin).toContain("AGENTS.md and GEMINI.md");
    expect(request?.stdin).toContain("Do not delegate to subagents, commit, push, publish, deploy");
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
      data: {
        changedFiles: claim.changedFiles,
        commandsRun: claim.commandsRun,
        process: { exitCode: 0 },
      },
    });
    expect(result.timing?.durationMs).toBeGreaterThanOrEqual(0);
    expect(isJsonValue(result)).toBe(true);
  });
  it("uses configured cwd and bounded defaults without changing native trust, tools or sessions", async () => {
    const runner = vi.fn<ProcessRunner>(async () => completed());
    await new GeminiCliAdapter({ workingDirectory: "/configured" }, { runProcess: runner }).run(
      input,
    );
    expect(runner.mock.calls[0]?.[0]).toMatchObject({
      executable: "gemini",
      cwd: "/configured",
      timeoutMs: 900000,
    });
    expect(
      runner.mock.calls[0]?.[0].args?.some((arg) =>
        /yolo|auto_edit|skip-trust|allowed-tools|policy|resume|extensions|worktree/.test(arg),
      ),
    ).toBe(false);
  });
  it.each([
    [{ exitCode: 1 }, "process_failed"],
    [{ exitCode: null, signal: "SIGTERM" }, "process_failed"],
    [{ terminationReason: "timeout" }, "timeout"],
    [{ terminationReason: "cancelled" }, "cancelled"],
    [{ stdout: "human output" }, "invalid_output"],
    [{ stdoutTruncated: true }, "invalid_output"],
    [{ exitCode: 42, stdout: "" }, "invalid_request"],
    [{ exitCode: 52, stdout: "" }, "invalid_config"],
    [{ exitCode: 53, stdout: "" }, "turn_limit"],
    [{ exitCode: 130, stdout: "" }, "cancelled"],
  ] satisfies [Partial<ProcessResult>, string][])(
    "normalizes native exit/termination %#",
    async (fields, code) => {
      const result = await new GeminiCliAdapter(
        {},
        { runProcess: async () => completed(fields) },
      ).run(input);
      expect(result).toMatchObject({
        status: "failure",
        error: { code: `gemini_cli_${code}` },
        data: { process: fields },
      });
    },
  );
  it("pauses on native authentication failure even when its JSON was written to stderr", async () => {
    const result = await new GeminiCliAdapter(
      {},
      {
        runProcess: async () =>
          completed({
            exitCode: 41,
            stdout: "",
            stderr: '[ERROR] {"error":{"type":"Error","code":41}}',
          }),
      },
    ).run(input);
    expect(result).toMatchObject({
      status: "needs_input",
      error: { code: "gemini_cli_auth_required" },
    });
  });
  it("preserves native error normalization on nonzero exit without returning private error text", async () => {
    const result = await new GeminiCliAdapter(
      {},
      {
        runProcess: async () =>
          completed({
            exitCode: 1,
            stdout: envelope({ error: { type: "ApiError", message: "private failure" } }),
          }),
      },
    ).run(input);
    expect(result.error?.code).toBe("gemini_cli_provider_error");
    expect(result.summary).not.toContain("private failure");
  });
  it.each([
    "executable_not_found",
    "invalid_cwd",
    "spawn_failed",
    "output_callback_failed",
    "termination_failed",
  ] as const)("normalizes runtime %s", async (code) => {
    const result = await new GeminiCliAdapter(
      {},
      {
        runProcess: async () => {
          throw new ProcessExecutionError(
            code,
            "private native error",
            "ENOENT",
            completed({ exitCode: null }),
          );
        },
      },
    ).run(input);
    expect(result.error?.code).toBe(
      `gemini_cli_${code === "executable_not_found" ? "not_found" : code}`,
    );
    expect(JSON.stringify(result)).not.toContain("private native error");
  });
  it("handles unexpected runtime failures without echoing their message", async () => {
    const result = await new GeminiCliAdapter(
      {},
      {
        runProcess: async () => {
          throw new Error("private failure");
        },
      },
    ).run(input);
    expect(result.error?.code).toBe("gemini_cli_execution_failed");
    expect(JSON.stringify(result)).not.toContain("private failure");
  });
  it("rejects malformed input, invalid controls and pre-cancellation before spawning", async () => {
    const runner = vi.fn<ProcessRunner>();
    const adapter = new GeminiCliAdapter({}, { runProcess: runner });
    expect((await adapter.run(input, { signal: AbortSignal.abort() })).error?.code).toBe(
      "gemini_cli_cancelled",
    );
    expect((await adapter.run(input, { timeoutMs: 0 })).error?.code).toBe(
      "gemini_cli_invalid_timeout",
    );
    expect((await adapter.run({ ...input, role: "planner" })).error?.code).toBe(
      "gemini_cli_unsupported_role",
    );
    expect((await adapter.run({ ...input, goal: " " })).error?.code).toBe(
      "gemini_cli_invalid_input",
    );
    expect(
      (await adapter.run({ ...input, context: { invalid: new Date() } } as unknown as AgentInput))
        .error?.code,
    ).toBe("gemini_cli_invalid_input");
    expect((await adapter.run({ ...input, goal: "@".repeat(50000) })).error?.code).toBe(
      "gemini_cli_input_too_large",
    );
    expect(runner).not.toHaveBeenCalled();
  });
  it("assembles chunked results independently of retained diagnostics", async () => {
    const runner: ProcessRunner = async (request) => {
      const json = envelope({ extra: "x".repeat(100000) });
      request.onStdout?.(json.slice(0, 30));
      request.onStdout?.(json.slice(30));
      return completed({ stdout: "", stdoutTruncated: true });
    };
    expect(
      (await new GeminiCliAdapter({ maxOutputBytes: 0 }, { runProcess: runner }).run(input)).status,
    ).toBe("success");
  });
  it("consumes stdin through the real Runtime and captures bounded stdout/stderr", async () => {
    const runner: ProcessRunner = (request) =>
      runProcess({
        ...request,
        executable: process.execPath,
        args: [
          "--input-type=module",
          "-e",
          `let input=""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => input+=chunk); process.stdin.on("end", () => { if (!input.includes("Repair $(literal)")) process.exit(2); console.log(${JSON.stringify(envelope())}); console.error("fixture diagnostic"); });`,
        ],
      });
    const result = await new GeminiCliAdapter({ maxOutputBytes: 10 }, { runProcess: runner }).run(
      input,
      { timeoutMs: 10000 },
    );
    expect(result.status).toBe("success");
    expect(result.data?.process).toMatchObject({
      stdoutTruncated: true,
      stderrTruncated: true,
      stdout: '{"response',
      stderr: "fixture di",
    });
  });
  it("redacts keys and nested credentials in prompts, result claims and encoded diagnostics", async () => {
    const key = 'fixture-key-"quote';
    const result = await new GeminiCliAdapter(
      {},
      {
        env: { GEMINI_API_KEY: key },
        runProcess: async (request) => {
          expect(request.stdin).not.toMatch(/fixture-key|nested-secret/);
          return completed({
            stdout: envelope({
              response: JSON.stringify({ ...claim, summary: key, commandsRun: [key] }),
            }),
            stderr: `Bearer private-bearer ${key}`,
          });
        },
      },
    ).run({
      ...input,
      context: { note: key, token: "nested-secret", env: { PRIVATE: "private-value" } },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /fixture-key|nested-secret|private-value|private-bearer/,
    );
    expect(result.summary).toBe("[REDACTED]");
    expect(result.data?.commandsRun).toEqual(["[REDACTED]"]);
  });
  it.each(
    [
      null,
      [],
      false,
      "options",
      { apiKey: "forbidden" },
      { approvalMode: "yolo" },
      { allowedTools: ["shell"] },
      { executable: "" },
      { workingDirectory: "null\0path" },
      { model: "x".repeat(513) },
      { id: "x".repeat(129) },
      { timeoutMs: 0 },
      { timeoutMs: 86400001 },
      { maxOutputBytes: -1 },
      { maxOutputBytes: 2 ** 21 },
    ].map((value) => [value]),
  )("rejects unsafe/unsupported options %#", (options) => {
    expect(() => new GeminiCliAdapter(options as GeminiCliAdapterOptions)).toThrow();
  });
  it("rejects accessors without evaluating them", () => {
    const getter = vi.fn();
    expect(
      () =>
        new GeminiCliAdapter(Object.defineProperty({}, "model", { enumerable: true, get: getter })),
    ).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      cliPrompt({ ...input, context: { native: new Date() } } as unknown as AgentInput, {}),
    ).toThrow();
  });
});

describe("Gemini CLI envelope validation", () => {
  it.each(["success", "failure", "needs_input"])(
    "accepts a complete executor %s claim",
    (status) => {
      expect(
        parse(envelope({ response: JSON.stringify({ ...claim, status }) })).result,
      ).toMatchObject({ status, summary: claim.summary });
    },
  );
  it.each([
    "",
    "null",
    "[]",
    "{}",
    '{"response":""}',
    envelope({ response: `\`\`\`json\n${JSON.stringify(claim)}\n\`\`\`` }),
    envelope({ response: JSON.stringify({ ...claim, extra: true }) }),
    envelope({ response: JSON.stringify({ ...claim, status: "passed" }) }),
    envelope({ response: JSON.stringify({ ...claim, summary: " " }) }),
    envelope({ response: JSON.stringify({ ...claim, changedFiles: "file" }) }),
    envelope({ response: JSON.stringify({ ...claim, commandsRun: [1] }) }),
    envelope({ response: JSON.stringify({ ...claim, commandsRun: Array(1025).fill("cmd") }) }),
    envelope({ response: JSON.stringify({ ...claim, summary: "x".repeat(256 * 1024) }) }),
    envelope({ error: "broken" }),
    envelope({ warnings: "broken" }),
    envelope({ stats: { tools: { totalDecisions: { reject: -1 } } } }),
  ])("rejects malformed or incomplete JSON %#", (value) => {
    expect(parse(value).result).toBeUndefined();
  });
  it("rejects warnings and rejected permissions even with a success claim", () => {
    expect(
      parse(envelope({ warnings: ["Agent execution stopped by hook"] })).result?.error?.code,
    ).toBe("gemini_cli_incomplete");
    expect(
      parse(envelope({ stats: { tools: { totalDecisions: { reject: 1 } } } })).result,
    ).toMatchObject({ status: "needs_input", error: { code: "gemini_cli_permission_required" } });
    expect(
      parse(envelope({ error: { type: "Error", message: "private", code: 41 } })).result?.status,
    ).toBe("needs_input");
  });
  it("sums reported per-model usage without cached/thinking or nested-role double counting", () => {
    const model = {
      tokens: { prompt: 10, input: 7, cached: 3, candidates: 4, thoughts: 2, total: 16 },
      roles: { main: { tokens: { prompt: 10000 } } },
    };
    expect(parse(envelope({ stats: { models: { first: model, second: model } } })).usage).toEqual({
      inputTokens: 20,
      outputTokens: 8,
      totalTokens: 32,
      cachedInputTokens: 6,
      reasoningTokens: 4,
    });
  });
  it("omits unknown, invalid, incomplete and overflowing usage fields without inventing costs", () => {
    expect(parse(envelope()).usage).toBeUndefined();
    expect(parse(envelope({ stats: { models: {} } })).usage).toBeUndefined();
    expect(
      parse(
        envelope({
          stats: {
            models: {
              a: { tokens: { prompt: 3, candidates: 2 } },
              b: { tokens: { candidates: 4 } },
            },
          },
        }),
      ).usage,
    ).toEqual({ outputTokens: 6 });
    expect(
      parse(
        envelope({
          stats: {
            models: {
              a: { tokens: { prompt: Number.MAX_SAFE_INTEGER, total: -1, thoughts: 0.5 } },
              b: { tokens: { prompt: 1 } },
            },
          },
        }),
      ).usage,
    ).toBeUndefined();
  });
  it("stops retaining an oversized envelope and fails closed", () => {
    const output = new GeminiCliOutput();
    output.feed("x".repeat(1024 * 1024));
    output.feed("x");
    output.feed(envelope());
    expect(output.oversized).toBe(true);
    expect(output.finish()).toBeUndefined();
  });
});

describe("Gemini CLI offline readiness", () => {
  const runnerFor = () =>
    vi.fn<ProcessRunner>(async (request) =>
      completed({ stdout: request.args?.[0] === "--version" ? "0.58.0\n" : help }),
    );
  it("checks only version/help and reports key presence with configuration scope", async () => {
    const runner = runnerFor();
    const result = await new GeminiCliAdapter(
      {},
      { runProcess: runner, env: { GEMINI_API_KEY: "private-key" } },
    ).checkReadiness({ cwd: "/target", timeoutMs: 3210 });
    expect(result).toMatchObject({ status: "ready", scope: "configuration", version: "0.58.0" });
    expect(runner.mock.calls.map(([request]) => request.args)).toEqual([["--version"], ["--help"]]);
    expect(runner.mock.calls[0]?.[0]).toMatchObject({
      cwd: "/target",
      timeoutMs: 3210,
      maxOutputBytes: 4096,
    });
    expect(JSON.stringify(result)).not.toContain("private-key");
  });
  it.each([
    {},
    { GEMINI_API_KEY: " " },
    { GOOGLE_API_KEY: "present" },
    { GEMINI_API_KEY: "present", GOOGLE_GENAI_USE_GCA: "true" },
    { GOOGLE_GENAI_USE_VERTEXAI: "true" },
    { GOOGLE_GEMINI_BASE_URL: "https://example.invalid" },
    { GEMINI_CLI_USE_COMPUTE_ADC: "true" },
    { CLOUD_SHELL: "true" },
  ])("does not claim native login or alternative auth is valid %#", async (env) => {
    const result = await new GeminiCliAdapter(
      {},
      { runProcess: runnerFor(), env },
    ).checkReadiness();
    expect(result).toMatchObject({ status: "unknown", scope: "local", version: "0.58.0" });
    expect(result.message).toContain("Offline checks");
  });
  it.each([
    { stdout: "another executable" },
    { stdoutTruncated: true },
    { exitCode: 1 },
    { terminationReason: "timeout" },
    { signal: "SIGTERM" },
  ] satisfies Partial<ProcessResult>[])("fails inconclusive version probes %#", async (fields) => {
    const runner = runnerFor().mockImplementationOnce(async () => completed(fields));
    expect((await new GeminiCliAdapter({}, { runProcess: runner }).checkReadiness()).status).toBe(
      "unknown",
    );
    expect(runner).toHaveBeenCalledTimes(1);
  });
  it("distinguishes missing executables and unsupported structured flags", async () => {
    const missing: ProcessRunner = async () => {
      throw new ProcessExecutionError("executable_not_found", "private detail");
    };
    expect(await new GeminiCliAdapter({}, { runProcess: missing }).checkReadiness()).toMatchObject({
      status: "unavailable",
      message: expect.stringContaining("install"),
    });
    const old = runnerFor()
      .mockImplementationOnce(async () => completed({ stdout: "0.1.0" }))
      .mockImplementationOnce(async () => completed({ stdout: "--prompt" }));
    expect(await new GeminiCliAdapter({}, { runProcess: old }).checkReadiness()).toMatchObject({
      status: "unavailable",
      message: expect.stringContaining("update"),
    });
  });
  it("rejects controls before spawning and uses one deadline across probes", async () => {
    const runner = runnerFor();
    const adapter = new GeminiCliAdapter({}, { runProcess: runner });
    expect((await adapter.checkReadiness({ signal: AbortSignal.abort() })).status).toBe("unknown");
    expect((await adapter.checkReadiness({ timeoutMs: -1 })).status).toBe("unknown");
    expect(runner).not.toHaveBeenCalled();
    const slow = runnerFor().mockImplementationOnce(
      async (request) =>
        new Promise((resolve) =>
          request.signal?.addEventListener(
            "abort",
            () => resolve(completed({ terminationReason: "cancelled" })),
            { once: true },
          ),
        ),
    );
    expect(
      (await new GeminiCliAdapter({}, { runProcess: slow }).checkReadiness({ timeoutMs: 10 }))
        .status,
    ).toBe("unknown");
    expect(slow).toHaveBeenCalledTimes(1);
  });
});
