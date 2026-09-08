import { ADAPTER_VERSION } from "../src/version.js";
import { access, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type AgentInput, isJsonValue } from "@veyraoss/protocol";
import { ProcessExecutionError, type ProcessResult, type ProcessRunner } from "@veyraoss/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPrompt, CodexAdapter, type CodexAdapterOptions } from "../src/index.js";

const input: AgentInput = {
  runId: "run",
  stepId: "execute",
  attemptId: "attempt",
  attempt: 2,
  role: "executor",
  goal: "Repair the greeting",
  instructions: "Change only src/message.js",
  context: { plan: { instructions: "Use the expected greeting" }, verification: { exitCode: 1 } },
  artifacts: [{ id: "diff", kind: "diff", path: "change.patch" }],
};
const message = {
  status: "success",
  summary: "Repaired greeting",
  changedFiles: ["src/message.js"],
  commandsRun: ["node --test"],
};
const lines = (value = message) =>
  [
    { type: "thread.started", thread_id: "provider-thread" },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(value) } },
    {
      type: "turn.completed",
      usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 },
    },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
const completed = (overrides: Partial<ProcessResult> = {}): ProcessResult => ({
  exitCode: 0,
  signal: null,
  stdout: lines(),
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  durationMs: 12,
  ...overrides,
});
afterEach(() => vi.unstubAllEnvs());

describe("Codex CLI adapter", () => {
  it("exposes only implemented CLI capabilities and probes native readiness on request", async () => {
    const runner = vi.fn<ProcessRunner>(async (request) =>
      completed({ stdout: request.args?.[0] === "--version" ? "codex-cli 1.2.3" : "Logged in" }),
    );
    const adapter = new CodexAdapter({ model: "fixture-model" }, { runProcess: runner });
    expect(adapter.describe()).toMatchObject({
      permissions: { mode: "unknown", source: "native-configuration", sandbox: "workspace-write" },
      provider: "codex",
      adapterVersion: ADAPTER_VERSION,
      model: "fixture-model",
      roles: ["executor"],
      capabilities: ["code-execution", "tool-use", "local-cli", "structured-output"],
    });
    expect(runner).not.toHaveBeenCalled();
    const signal = new AbortController().signal;
    expect(await adapter.checkReadiness({ cwd: "/fixture", signal })).toMatchObject({
      status: "ready",
      scope: "local",
      version: "1.2.3",
    });
    expect(runner.mock.calls.map(([request]) => request.args)).toEqual([
      ["--version"],
      ["login", "status"],
    ]);
    expect(runner.mock.calls[0]?.[0]).toMatchObject({ cwd: "/fixture", signal });
  });
  it("does not advertise planned SDK mode as executable or launch a readiness process for it", async () => {
    const runner = vi.fn<ProcessRunner>();
    const adapter = new CodexAdapter({ mode: "sdk" }, { runProcess: runner });
    expect(adapter.describe()).toMatchObject({ roles: [], capabilities: [] });
    expect(await adapter.checkReadiness()).toMatchObject({
      status: "unavailable",
      scope: "configuration",
    });
    expect(runner).not.toHaveBeenCalled();
  });
  it("uses runtime, stdin, a restrictive structured invocation, and cleans its schema", async () => {
    let schemaPath = "";
    const runner = vi.fn<ProcessRunner>(async (request) => {
      schemaPath = request.args?.[request.args.indexOf("--output-schema") + 1] ?? "";
      expect(JSON.parse(await readFile(schemaPath, "utf8"))).toMatchObject({
        additionalProperties: false,
      });
      request.onStdout?.(lines().slice(0, 17));
      request.onStdout?.(lines().slice(17));
      return completed();
    });
    const signal = new AbortController().signal;
    const adapter = new CodexAdapter(
      { executable: "/custom/codex", workingDirectory: "/configured", model: "configured-model" },
      { runProcess: runner },
    );
    const result = await adapter.run(input, { cwd: "/target", timeoutMs: 42_000, signal });
    const request = runner.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      executable: "/custom/codex",
      cwd: "/target",
      timeoutMs: 42_000,
      signal,
      maxOutputBytes: 65536,
      stdin: buildPrompt(input),
    });
    expect(request?.args).toEqual([
      "exec",
      "--json",
      "--ephemeral",
      "--color",
      "never",
      "--sandbox",
      "workspace-write",
      "--output-schema",
      schemaPath,
      "--model",
      "configured-model",
      "-",
    ]);
    expect(result).toMatchObject({
      status: "success",
      summary: "Repaired greeting",
      execution: { runId: "run", stepId: "execute", attemptId: "attempt", attempt: 2 },
      data: {
        changedFiles: ["src/message.js"],
        commandsRun: ["node --test"],
        process: { exitCode: 0, durationMs: 12 },
      },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 2 },
    });
    expect(result.timing?.durationMs).toBeGreaterThanOrEqual(0);
    expect(isJsonValue(result)).toBe(true);
    await expect(access(dirname(schemaPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the task envelope and project instruction priority", () => {
    const prompt = buildPrompt(input);
    expect(prompt).toContain("Preserve and follow user/project AGENTS.md");
    expect(JSON.parse(prompt.split("Task envelope:\n\n")[1] ?? "")).toEqual(input);
  });

  it("uses the configured directory and bounded defaults", async () => {
    const runner = vi.fn<ProcessRunner>(async () => completed());
    await new CodexAdapter({ workingDirectory: "/configured" }, { runProcess: runner }).run(input);
    expect(runner.mock.calls[0]?.[0]).toMatchObject({
      cwd: "/configured",
      timeoutMs: 900000,
      executable: "codex",
    });
  });

  it.each(["failure", "needs_input"])("preserves the executor's %s status", async (status) => {
    const runner: ProcessRunner = async () => completed({ stdout: lines({ ...message, status }) });
    expect((await new CodexAdapter({}, { runProcess: runner }).run(input)).status).toBe(status);
  });

  it.each([
    ["executable_not_found", "codex_not_found"],
    ["invalid_cwd", "codex_invalid_cwd"],
    ["spawn_failed", "codex_spawn_failed"],
  ] as const)("normalizes %s and removes temporary schema files", async (code, expected) => {
    let schemaPath = "";
    const runner: ProcessRunner = async (request) => {
      schemaPath = request.args?.[request.args.indexOf("--output-schema") + 1] ?? "";
      throw new ProcessExecutionError(code, "unsafe native error detail");
    };
    const result = await new CodexAdapter({}, { runProcess: runner }).run(input);
    expect(result.error?.code).toBe(expected);
    expect(JSON.stringify(result)).not.toContain("unsafe native");
    await expect(access(dirname(schemaPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    [{ exitCode: 3 }, "codex_process_failed"],
    [{ signal: "SIGTERM", exitCode: null }, "codex_process_failed"],
    [{ terminationReason: "timeout" }, "codex_timeout"],
    [{ terminationReason: "cancelled" }, "codex_cancelled"],
    [{ stdout: "human-formatted output" }, "codex_invalid_output"],
    [{ stdoutTruncated: true }, "codex_invalid_output"],
  ] satisfies [Partial<ProcessResult>, string][])(
    "rejects unsuccessful or ambiguous completion %j",
    async (overrides, code) => {
      const result = await new CodexAdapter(
        {},
        { runProcess: async () => completed(overrides) },
      ).run(input);
      expect(result).toMatchObject({
        status: "failure",
        error: { code },
        data: { process: { ...overrides } },
      });
      expect(isJsonValue(result)).toBe(true);
    },
  );

  it("extracts the final streamed result after retained stdout is truncated", async () => {
    const runner: ProcessRunner = async (request) => {
      request.onStdout?.(
        `${JSON.stringify({ type: "item.completed", item: { type: "command_execution", output: "x".repeat(100_000) } })}\n`,
      );
      request.onStdout?.(lines());
      return completed({ stdout: "retained prefix", stdoutTruncated: true });
    };
    const result = await new CodexAdapter({}, { runProcess: runner }).run(input);
    expect(result.status).toBe("success");
    expect(result.data?.process).toMatchObject({
      stdout: "retained prefix",
      stdoutTruncated: true,
    });
  });

  it("rejects pre-cancellation, SDK mode, and invalid/oversized input without spawning", async () => {
    const runner = vi.fn<ProcessRunner>();
    const adapter = new CodexAdapter({}, { runProcess: runner });
    expect((await adapter.run(input, { signal: AbortSignal.abort() })).error?.code).toBe(
      "codex_cancelled",
    );
    expect((await adapter.run({ ...input, goal: "" })).error?.code).toBe("codex_invalid_input");
    expect((await adapter.run({ ...input, goal: "x".repeat(256 * 1024) })).error?.code).toBe(
      "codex_input_too_large",
    );
    expect(
      (await new CodexAdapter({ mode: "sdk" }, { runProcess: runner }).run(input)).error?.code,
    ).toBe("codex_sdk_not_implemented");
    expect(runner).not.toHaveBeenCalled();
  });

  it("redacts known credentials, credential fields, and bearer diagnostics safely", async () => {
    const secret = 'fixture-key-with-"quote';
    vi.stubEnv("CODEX_API_KEY", secret);
    const runner: ProcessRunner = async (request) => {
      expect(request.stdin).not.toContain("fixture-key");
      expect(request.stdin).not.toContain("nested-credential");
      return completed({
        stdout: lines({ ...message, summary: secret, commandsRun: [secret] }),
        stderr: `Bearer diagnostic-token ${secret}`,
      });
    };
    const result = await new CodexAdapter({}, { runProcess: runner }).run({
      ...input,
      context: { note: secret, apiKey: "nested-credential", env: { VARIABLE: "hidden" } },
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain("fixture-key");
    expect(json).not.toContain("diagnostic-token");
    expect(result.summary).toBe("[REDACTED]");
    expect(result.data?.commandsRun).toEqual(["[REDACTED]"]);
    expect(isJsonValue(result)).toBe(true);
  });

  it("redacts standard credentials from the supplied environment without rewriting native process auth", async () => {
    const secret = "fixture-github-credential";
    const runner: ProcessRunner = async (request) => {
      expect(request.stdin).not.toContain(secret);
      expect(request.env).toBeUndefined();
      return completed({
        stdout: lines({ ...message, summary: secret }),
        stderr: encodeURIComponent(secret),
      });
    };
    const result = await new CodexAdapter(
      {},
      { runProcess: runner, env: { GITHUB_TOKEN: secret } },
    ).run({ ...input, context: { note: secret } });
    expect(result.summary).toBe("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([
    { mode: "other" },
    { apiKey: "forbidden" },
    { timeoutMs: 0 },
    { maxOutputBytes: 2 * 1024 * 1024 },
    { executable: "" },
  ])("rejects unsupported options %j", (options) => {
    expect(() => new CodexAdapter(options as CodexAdapterOptions)).toThrow();
  });
});

describe("Codex readiness", () => {
  it("preserves installed/version evidence when the auth subprocess fails and never exposes diagnostics", async () => {
    const runner = vi.fn<ProcessRunner>(async (request) => {
      if (request.args?.[0] === "--version") return completed({ stdout: "codex-cli 0.153.4" });
      throw new ProcessExecutionError("executable_not_found", "fixture-private-credential");
    });
    const result = await new CodexAdapter(
      { executable: "/Applications/Native Codex/codex" },
      { runProcess: runner },
    ).doctor();
    expect(result).toMatchObject({
      available: true,
      version: "0.153.4",
      authentication: "unknown",
      ready: false,
    });
    expect(JSON.stringify(result)).not.toContain("fixture-private-credential");
    expect(
      runner.mock.calls.every(
        ([request]) =>
          request.executable === "/Applications/Native Codex/codex" &&
          request.maxOutputBytes === 4096 &&
          request.timeoutMs === 5000,
      ),
    ).toBe(true);
  });

  it.each([
    { signal: "SIGTERM" as const },
    { stdoutTruncated: true },
    { stdout: "codex-cli fixture-private-credential" },
  ])("fails an interrupted/truncated/invalid version probe closed %#", async (override) => {
    const runner = vi.fn<ProcessRunner>(async () =>
      completed({ stdout: "codex-cli 0.153.4", ...override }),
    );
    const result = await new CodexAdapter({}, { runProcess: runner }).doctor();
    expect(result).toMatchObject({ available: null, authentication: "unknown", ready: false });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("fixture-private-credential");
  });

  it.each([
    [0, "ready", true],
    [1, "not_authenticated", false],
    [4, "unknown", false],
  ] as const)(
    "checks version and read-only login status (exit %i)",
    async (exitCode, authentication, ready) => {
      const runner = vi.fn<ProcessRunner>(async (request) =>
        request.args?.[0] === "--version"
          ? completed({ stdout: "codex-cli 0.153.4\n" })
          : completed({ exitCode, stdout: "", stderr: "auth status" }),
      );
      expect(await new CodexAdapter({}, { runProcess: runner }).doctor()).toMatchObject({
        available: true,
        version: "0.153.4",
        authentication,
        ready,
      });
      expect(runner.mock.calls.map(([request]) => request.args)).toEqual([
        ["--version"],
        ["login", "status"],
      ]);
    },
  );

  it("reports missing executable without pretending authentication was checked", async () => {
    const runner: ProcessRunner = async () => {
      throw new ProcessExecutionError("executable_not_found", "missing");
    };
    expect(await new CodexAdapter({}, { runProcess: runner }).doctor()).toMatchObject({
      available: false,
      authentication: "unknown",
      ready: false,
    });
  });

  it("does not misclassify a timed-out auth check as logged out", async () => {
    const runner: ProcessRunner = async (request) =>
      request.args?.[0] === "--version"
        ? completed({ stdout: "codex-cli 0.153.4\n" })
        : completed({ exitCode: 1, terminationReason: "timeout" });
    expect(await new CodexAdapter({}, { runProcess: runner }).doctor()).toMatchObject({
      available: true,
      authentication: "unknown",
      ready: false,
    });
  });
});
