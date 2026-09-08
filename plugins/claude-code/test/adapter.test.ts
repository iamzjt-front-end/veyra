import { type AgentInput, isJsonValue } from "@veyra/protocol";
import {
  ProcessExecutionError,
  type ProcessResult,
  type ProcessRunner,
  runProcess,
} from "@veyra/runtime";
import { describe, expect, it, vi } from "vitest";
import { buildPrompt, ClaudeCodeAdapter, type ClaudeCodeAdapterOptions } from "../src/index.js";

const input: AgentInput = {
  runId: "run",
  stepId: "execute",
  attemptId: "attempt",
  attempt: 2,
  parentStepId: "parent",
  role: "executor",
  goal: "Repair $(literal) `greeting`",
  instructions: "Change only src/message.js",
  context: { planner: { instructions: "Use expected greeting" } },
};
const message = {
  type: "result",
  subtype: "success",
  is_error: false,
  permission_denials: [],
  structured_output: {
    status: "success",
    summary: "Repaired greeting",
    changedFiles: ["src/message.js"],
    commandsRun: ["node --test"],
  },
};
const completed = (fields: Partial<ProcessResult> = {}): ProcessResult => ({
  exitCode: 0,
  signal: null,
  stdout: JSON.stringify(message),
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  durationMs: 3,
  ...fields,
});
const help = "--print --output-format --json-schema --no-session-persistence --permission-mode";

describe("Claude Code runtime adapter", () => {
  it.each([null, [], false, "options"].map((value) => [value]))(
    "rejects a non-object options container %#",
    (value) => {
      expect(() => new ClaudeCodeAdapter(value as ClaudeCodeAdapterOptions)).toThrow();
    },
  );
  it("describes implemented executor capabilities without starting a process", () => {
    const runner = vi.fn<ProcessRunner>();
    const adapter = new ClaudeCodeAdapter(
      { id: "coding", model: "configured" },
      { runProcess: runner },
    );
    expect(adapter.describe()).toEqual({
      schemaVersion: 1,
      id: "coding",
      provider: "claude-code",
      adapterVersion: "0.1.0",
      model: "configured",
      roles: ["executor"],
      permissions: { mode: "default", source: "adapter-argument", toolAllowRules: 0 },
      capabilities: ["code-execution", "tool-use", "local-cli", "structured-output"],
    });
    expect(runner).not.toHaveBeenCalled();
  });
  it("passes literal stdin, explicit native permissions and execution controls through runtime", async () => {
    const runner = vi.fn<ProcessRunner>(async (request) => {
      request.onStdout?.(JSON.stringify(message));
      return completed();
    });
    const allowedTools = ["Read", "Edit(src/message.js)", "Bash(node --test)"];
    const adapter = new ClaudeCodeAdapter(
      {
        workingDirectory: "/configured",
        executable: "/custom/claude",
        model: "configured model",
        allowedTools,
        maxTurns: 7,
      },
      { runProcess: runner, env: {} },
    );
    allowedTools.push("Bash");
    const signal = new AbortController().signal;
    const result = await adapter.run(input, { cwd: "/target", timeoutMs: 42000, signal });
    const request = runner.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      executable: "/custom/claude",
      cwd: "/target",
      timeoutMs: 42000,
      signal,
      stdin: buildPrompt(input, {}),
      maxOutputBytes: 65536,
    });
    expect(request?.args?.slice(0, 12)).toEqual([
      "--print",
      "--input-format",
      "text",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--permission-mode",
      "default",
      "--max-turns",
      "7",
      "--json-schema",
      expect.any(String),
    ]);
    expect(JSON.parse(request?.args?.[11] ?? "")).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["status", "summary", "changedFiles", "commandsRun"],
    });
    expect(request?.args?.slice(12)).toEqual([
      "--model=configured model",
      "--allowedTools=Read,Edit(src/message.js),Bash(node --test)",
    ]);
    expect(result).toMatchObject({
      status: "success",
      execution: {
        runId: "run",
        stepId: "execute",
        attemptId: "attempt",
        attempt: 2,
        parentStepId: "parent",
      },
      data: { changedFiles: ["src/message.js"], process: { exitCode: 0, durationMs: 3 } },
    });
    expect(result.timing?.durationMs).toBeGreaterThanOrEqual(0);
    expect(isJsonValue(result)).toBe(true);
  });
  it("preserves project instructions, bounded defaults and configured working directory", async () => {
    const runner = vi.fn<ProcessRunner>(async () => completed());
    await new ClaudeCodeAdapter(
      { workingDirectory: "/configured" },
      { runProcess: runner, env: {} },
    ).run(input);
    expect(runner.mock.calls[0]?.[0]).toMatchObject({
      executable: "claude",
      cwd: "/configured",
      timeoutMs: 900000,
    });
    const prompt = buildPrompt(input, {});
    expect(prompt).toContain("AGENTS.md and CLAUDE.md");
    expect(prompt).toContain("Do not delegate to subagents, commit, push, publish, deploy");
    expect(JSON.parse(prompt.split("Task envelope:\n\n")[1] ?? "")).toEqual(input);
    expect(
      runner.mock.calls[0]?.[0].args?.some((arg) =>
        /allowedTools|bypass|dangerously|--bare|--continue|--resume|--verbose/.test(arg),
      ),
    ).toBe(false);
  });
  it.each([
    [{ exitCode: 1 }, "claude_code_process_failed"],
    [{ exitCode: null, signal: "SIGTERM" }, "claude_code_process_failed"],
    [{ terminationReason: "timeout" }, "claude_code_timeout"],
    [{ terminationReason: "cancelled" }, "claude_code_cancelled"],
    [{ stdout: "human output" }, "claude_code_invalid_output"],
    [{ stdoutTruncated: true }, "claude_code_invalid_output"],
  ] satisfies [Partial<ProcessResult>, string][])(
    "normalizes process completion %j",
    async (fields, code) => {
      const result = await new ClaudeCodeAdapter(
        {},
        { runProcess: async () => completed(fields) },
      ).run(input);
      expect(result).toMatchObject({
        status: "failure",
        error: { code },
        data: { process: fields },
      });
      expect(isJsonValue(result)).toBe(true);
    },
  );
  it("preserves a structured native error on a nonzero exit", async () => {
    const result = await new ClaudeCodeAdapter(
      {},
      {
        runProcess: async () =>
          completed({
            exitCode: 1,
            stdout: JSON.stringify({ ...message, subtype: "error_max_turns", is_error: true }),
          }),
      },
    ).run(input);
    expect(result.error?.code).toBe("claude_code_error_max_turns");
  });
  it.each([
    "executable_not_found",
    "invalid_cwd",
    "spawn_failed",
    "output_callback_failed",
    "termination_failed",
  ] as const)("normalizes runtime %s without echoing native errors", async (code) => {
    const result = await new ClaudeCodeAdapter(
      {},
      {
        runProcess: async () => {
          throw new ProcessExecutionError(
            code,
            "private native detail",
            "ENOENT",
            completed({ exitCode: null }),
          );
        },
      },
    ).run(input);
    expect(result.error?.code).toBe(
      `claude_code_${code === "executable_not_found" ? "not_found" : code}`,
    );
    expect(JSON.stringify(result)).not.toContain("private native detail");
    expect(result.data?.process).toBeDefined();
  });
  it("rejects invalid input and controls without spawning", async () => {
    const runner = vi.fn<ProcessRunner>();
    const adapter = new ClaudeCodeAdapter({}, { runProcess: runner });
    expect((await adapter.run(input, { signal: AbortSignal.abort() })).error?.code).toBe(
      "claude_code_cancelled",
    );
    expect((await adapter.run(input, { timeoutMs: 0 })).error?.code).toBe(
      "claude_code_invalid_timeout",
    );
    expect((await adapter.run({ ...input, role: "reviewer" })).error?.code).toBe(
      "claude_code_unsupported_role",
    );
    expect((await adapter.run({ ...input, goal: " " })).error?.code).toBe(
      "claude_code_invalid_input",
    );
    expect((await adapter.run({ ...input, goal: "x".repeat(256 * 1024) })).error?.code).toBe(
      "claude_code_input_too_large",
    );
    expect(
      (await adapter.run({ ...input, context: { invalid: new Date() } } as unknown as AgentInput))
        .error?.code,
    ).toBe("claude_code_invalid_input");
    expect(runner).not.toHaveBeenCalled();
  });
  it("retains bounded diagnostics while assembling the complete final result", async () => {
    const runner: ProcessRunner = async (request) => {
      const json = JSON.stringify({ ...message, result: "x".repeat(100000) });
      request.onStdout?.(json.slice(0, 20));
      request.onStdout?.(json.slice(20));
      return completed({ stdout: "retained prefix", stdoutTruncated: true });
    };
    const result = await new ClaudeCodeAdapter({ maxOutputBytes: 0 }, { runProcess: runner }).run(
      input,
    );
    expect(result.status).toBe("success");
    expect(result.data?.process).toMatchObject({ stdoutTruncated: true });
  });
  it("uses the real runtime to consume stdin and assemble JSON beyond log retention", async () => {
    const runner: ProcessRunner = (request) =>
      runProcess({
        ...request,
        executable: process.execPath,
        args: [
          "--input-type=module",
          "-e",
          `let input=""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => input+=chunk); process.stdin.on("end", () => { if (!input.includes("Repair $(literal)")) process.exit(2); console.log(JSON.stringify(${JSON.stringify(message)})); console.error("fixture diagnostic"); });`,
        ],
      });
    const result = await new ClaudeCodeAdapter({ maxOutputBytes: 10 }, { runProcess: runner }).run(
      input,
      { timeoutMs: 10000 },
    );
    expect(result.status).toBe("success");
    expect(result.data?.process).toMatchObject({
      stdoutTruncated: true,
      stderrTruncated: true,
      stdout: '{"type":"r',
      stderr: "fixture di",
    });
  });
  it("redacts environment secrets, credential fields and bearer diagnostics", async () => {
    const secret = 'fixture-token-with-"quote';
    const runner: ProcessRunner = async (request) => {
      expect(request.stdin).not.toContain("fixture-token");
      expect(request.stdin).not.toContain("nested-secret");
      return completed({
        stdout: JSON.stringify({
          ...message,
          structured_output: {
            ...message.structured_output,
            summary: secret,
            commandsRun: [secret],
          },
        }),
        stderr: `Bearer private-bearer ${secret}`,
      });
    };
    const result = await new ClaudeCodeAdapter(
      {},
      { runProcess: runner, env: { CLAUDE_CODE_OAUTH_TOKEN: secret } },
    ).run({
      ...input,
      context: { note: secret, apiKey: "nested-secret", environment: { NAME: "hidden" } },
    });
    expect(JSON.stringify(result)).not.toMatch(/fixture-token|private-bearer|nested-secret/);
    expect(result.summary).toBe("[REDACTED]");
    expect(result.data?.commandsRun).toEqual(["[REDACTED]"]);
  });
  it.each([
    { apiKey: "forbidden" },
    { permissionMode: "bypassPermissions" },
    { executable: "" },
    { timeoutMs: 0 },
    { maxOutputBytes: -1 },
    { maxOutputBytes: 2 ** 21 },
    { id: "x".repeat(129) },
    { model: "x".repeat(513) },
    { maxTurns: 0 },
    { maxTurns: 1001 },
    { allowedTools: "Bash" },
    { allowedTools: [""] },
    { allowedTools: ["Read\nBash"] },
    { executable: "null\0path" },
  ])("rejects unsupported options %#", (options) => {
    expect(() => new ClaudeCodeAdapter(options as ClaudeCodeAdapterOptions)).toThrow();
  });
});

describe("Claude Code read-only readiness", () => {
  const runnerFor = (auth: Partial<ProcessResult> = {}) =>
    vi.fn<ProcessRunner>(async (request) =>
      completed({
        stdout:
          request.args?.[0] === "--version"
            ? "2.1.159 (Claude Code)\n"
            : request.args?.[0] === "--help"
              ? help
              : JSON.stringify({ loggedIn: true, email: "private@example.test" }),
        ...(request.args?.[0] === "auth" ? auth : {}),
      }),
    );
  it("checks executable, required structured flags and native authentication without printing identity", async () => {
    const runner = runnerFor();
    const adapter = new ClaudeCodeAdapter({}, { runProcess: runner });
    const result = await adapter.checkReadiness({ cwd: "/target", timeoutMs: 3210 });
    expect(result).toMatchObject({ status: "ready", scope: "local", version: "2.1.159" });
    expect(runner.mock.calls.map(([request]) => request.args)).toEqual([
      ["--version"],
      ["--help"],
      ["auth", "status"],
    ]);
    expect(runner.mock.calls[2]?.[0]).toMatchObject({
      cwd: "/target",
      timeoutMs: 3210,
      maxOutputBytes: 4096,
    });
    expect(JSON.stringify(result)).not.toContain("private@example.test");
    expect(isJsonValue(result)).toBe(true);
  });
  it.each([
    [{ exitCode: 1, stdout: '{"loggedIn":false}' }, "unavailable"],
    [{ stdout: '{"loggedIn":false}' }, "unavailable"],
    [{ exitCode: 4 }, "unknown"],
    [{ stdout: "legacy auth output" }, "unknown"],
    [{ stdout: "{}" }, "unknown"],
    [{ terminationReason: "timeout" }, "unknown"],
    [{ stdoutTruncated: true }, "unknown"],
  ] satisfies [Partial<ProcessResult>, string][])(
    "handles auth diagnostic %j",
    async (auth, status) => {
      expect(
        (await new ClaudeCodeAdapter({}, { runProcess: runnerFor(auth) }).checkReadiness()).status,
      ).toBe(status);
    },
  );
  it("distinguishes missing executable, unsupported flags and inconclusive checks", async () => {
    const missing: ProcessRunner = async () => {
      throw new ProcessExecutionError("executable_not_found", "private error");
    };
    expect((await new ClaudeCodeAdapter({}, { runProcess: missing }).checkReadiness()).status).toBe(
      "unavailable",
    );
    const runner = runnerFor();
    runner.mockImplementationOnce(async () => completed({ stdout: "some other executable" }));
    expect((await new ClaudeCodeAdapter({}, { runProcess: runner }).checkReadiness()).status).toBe(
      "unknown",
    );
    expect(runner).toHaveBeenCalledTimes(1);
    const old = runnerFor();
    old
      .mockImplementationOnce(async () => completed({ stdout: "2.0.0 (Claude Code)" }))
      .mockImplementationOnce(async () => completed({ stdout: "--print" }));
    expect(await new ClaudeCodeAdapter({}, { runProcess: old }).checkReadiness()).toMatchObject({
      status: "unavailable",
      message: expect.stringContaining("update"),
    });
    expect(old).toHaveBeenCalledTimes(2);
  });
  it("cancels readiness before spawning and enforces one deadline across probes", async () => {
    const runner = runnerFor();
    const adapter = new ClaudeCodeAdapter({}, { runProcess: runner });
    expect((await adapter.checkReadiness({ signal: AbortSignal.abort() })).status).toBe("unknown");
    expect((await adapter.checkReadiness({ timeoutMs: -1 })).status).toBe("unknown");
    expect(runner).not.toHaveBeenCalled();
    const slow = vi.fn<ProcessRunner>(
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
      (await new ClaudeCodeAdapter({}, { runProcess: slow }).checkReadiness({ timeoutMs: 10 }))
        .status,
    ).toBe("unknown");
    expect(slow).toHaveBeenCalledTimes(1);
  });
});
