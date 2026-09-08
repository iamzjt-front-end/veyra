import Anthropic from "@anthropic-ai/sdk";
import type { Usage } from "@anthropic-ai/sdk/resources/messages";
import { isJsonValue, type AgentInput } from "@veyra/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeAdapter,
  type ClaudeAdapterOptions,
  type ClaudeMessagesClient,
} from "../src/index.js";

const input: AgentInput = {
  runId: "run",
  stepId: "plan",
  attemptId: "attempt",
  attempt: 1,
  parentStepId: "group",
  role: "planner",
  goal: "Repair the greeting",
  instructions: "Use the supplied evidence",
  context: { previous: "One failing test" },
  artifacts: [{ id: "test-log", kind: "verification", path: "artifacts/test.txt" }],
};
const plan = {
  summary: "Correct the greeting",
  instructions: "Change the misspelled word",
  acceptanceCriteria: ["The greeting test passes"],
  artifactIds: ["test-log"],
};
const review = {
  summary: "Matches the goal and supplied tests",
  outcome: "pass",
  requiredFixes: [],
  evidenceArtifactIds: ["test-log"],
};
type Response = Awaited<ReturnType<ClaudeMessagesClient["messages"]["create"]>>;
const usage: Usage = {
  input_tokens: 10,
  output_tokens: 20,
  cache_creation_input_tokens: 3,
  cache_read_input_tokens: 7,
  output_tokens_details: { thinking_tokens: 5 },
  cache_creation: null,
  inference_geo: null,
  server_tool_use: null,
  service_tier: null,
};
const response = (value: unknown = plan, patch: Partial<Response> = {}): Response => ({
  content: [{ type: "text", text: JSON.stringify(value), citations: null }],
  stop_reason: "end_turn",
  usage,
  ...patch,
});
const fixture = (
  value = response(),
  options: Partial<ClaudeAdapterOptions> = {},
  env: NodeJS.ProcessEnv = {},
) => {
  const create = vi.fn<ClaudeMessagesClient["messages"]["create"]>(async () => value);
  return {
    create,
    adapter: new ClaudeAdapter(
      { model: "fixture-model", ...options },
      { client: { messages: { create } }, env },
    ),
  };
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Claude Messages adapter", () => {
  it("requests constrained JSON, forwards controls, and normalizes evidence, execution and usage", async () => {
    const { adapter, create } = fixture();
    const signal = new AbortController().signal;
    const result = await adapter.run(input, { cwd: "/fixture", signal, timeoutMs: 3210 });
    expect(result).toMatchObject({
      status: "success",
      summary: plan.summary,
      data: { instructions: plan.instructions, acceptanceCriteria: plan.acceptanceCriteria },
      artifacts: input.artifacts,
      execution: {
        runId: "run",
        stepId: "plan",
        attemptId: "attempt",
        attempt: 1,
        parentStepId: "group",
      },
      usage: {
        inputTokens: 20,
        outputTokens: 20,
        cachedInputTokens: 7,
        reasoningTokens: 5,
        totalTokens: 40,
      },
    });
    expect(result.timing?.durationMs).toBeGreaterThanOrEqual(0);
    expect(isJsonValue(result)).toBe(true);
    const [body, controls] = create.mock.calls[0] ?? [];
    expect(controls).toMatchObject({
      signal: expect.any(AbortSignal),
      timeout: 3210,
      maxRetries: 0,
    });
    expect(body).toMatchObject({
      model: "fixture-model",
      stream: false,
      max_tokens: 8192,
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            additionalProperties: false,
            required: ["summary", "instructions", "acceptanceCriteria", "artifactIds"],
          },
        },
      },
    });
    expect(body?.system).toContain("untrusted evidence");
    expect(body?.messages).toEqual([{ role: "user", content: JSON.stringify(input) }]);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("cwd");
  });
  it.each(["reviewer", "judge"] as const)(
    "supports explicit %s verdicts without turning failure into an execution error",
    async (role) => {
      const { adapter, create } = fixture(
        response({ ...review, outcome: "fail", requiredFixes: ["Fix the failing test"] }),
      );
      const result = await adapter.run({ ...input, role });
      expect(result).toMatchObject({
        status: "success",
        outcome: "fail",
        data: { requiredFixes: ["Fix the failing test"] },
      });
      expect(create.mock.calls[0]?.[0].system).toContain(`Act as ${role}`);
      expect(fixture(response(review), { role }).adapter.describe().roles).toEqual([role]);
    },
  );
  it("uses a configured role for custom bindings and advertises only implemented text capabilities", async () => {
    const { adapter, create } = fixture(response(review), { id: "analysis", role: "reviewer" });
    const descriptor = adapter.describe();
    expect(descriptor).toMatchObject({
      id: "analysis",
      provider: "claude",
      model: "fixture-model",
      roles: ["reviewer"],
      capabilities: ["reasoning", "structured-output"],
    });
    descriptor.capabilities.push("vision");
    expect(adapter.describe().capabilities).not.toContain("vision");
    expect(create).not.toHaveBeenCalled();
    expect((await adapter.run({ ...input, role: "analysis" })).outcome).toBe("pass");
  });
  it("distinguishes credential presence, unknown injected-client readiness, and cancellation without probing", async () => {
    const env = { CUSTOM_CLAUDE_KEY: "" };
    const adapter = new ClaudeAdapter(
      { model: "fixture", apiKeyEnv: "CUSTOM_CLAUDE_KEY" },
      { env },
    );
    expect(await adapter.checkReadiness()).toMatchObject({
      status: "unavailable",
      scope: "configuration",
    });
    expect(await adapter.run(input)).toMatchObject({ error: { code: "claude_missing_api_key" } });
    env.CUSTOM_CLAUDE_KEY = "fixture-credential";
    const ready = await adapter.checkReadiness();
    expect(ready).toMatchObject({ status: "ready", scope: "configuration" });
    expect(JSON.stringify(ready)).not.toContain("fixture-credential");
    expect((await adapter.checkReadiness({ signal: AbortSignal.abort() })).status).toBe("unknown");
    const fake = fixture();
    expect((await fake.adapter.checkReadiness()).status).toBe("unknown");
    expect(fake.create).not.toHaveBeenCalled();
  });
  it.each([
    { model: "" },
    { model: "x".repeat(513) },
    { id: " " },
    { role: "executor" },
    { apiKeyEnv: "not-a-key-value!" },
    { timeoutMs: 0 },
    { timeoutMs: Number.NaN },
    { maxOutputTokens: -1 },
    { maxOutputTokens: 2 ** 31 },
    { baseURL: "http://example.com" },
    { apiKey: "do-not-accept" },
  ])("rejects unsupported or invalid option %#", (patch) => {
    expect(
      () => new ClaudeAdapter({ model: "fixture", ...patch } as ClaudeAdapterOptions),
    ).toThrow();
  });
  it.each([
    ["role", { ...input, role: "executor" }, {}, "claude_unsupported_role"],
    ["goal", { ...input, goal: " " }, {}, "claude_invalid_input"],
    ["JSON", { ...input, context: { bad: () => true } }, {}, "claude_invalid_input"],
    ["size", { ...input, goal: "x".repeat(256 * 1024) }, {}, "claude_input_too_large"],
    ["timeout", input, { timeoutMs: -1 }, "claude_invalid_input"],
    ["abort", input, { signal: AbortSignal.abort() }, "claude_cancelled"],
  ] as const)(
    "rejects invalid %s before invoking the client",
    async (_label, request, controls, code) => {
      const { adapter, create } = fixture();
      expect(await adapter.run(request as AgentInput, controls)).toMatchObject({
        status: "failure",
        error: { code },
      });
      expect(create).not.toHaveBeenCalled();
    },
  );
  it.each([
    "refusal",
    "max_tokens",
    "model_context_window_exceeded",
    "pause_turn",
    "tool_use",
    "stop_sequence",
    null,
  ] as const)("handles stop reason %s explicitly", async (stop_reason) => {
    const { adapter } = fixture(response(plan, { stop_reason }));
    expect(await adapter.run(input)).toMatchObject({
      status: stop_reason === "refusal" ? "needs_input" : "failure",
      error: { code: stop_reason === "refusal" ? "claude_refusal" : "claude_incomplete" },
      usage: { totalTokens: 40 },
    });
  });
  it.each(
    [
      { ...plan, summary: "" },
      { ...plan, acceptanceCriteria: [] },
      { ...plan, instructions: null },
      { ...plan, artifactIds: ["invented"] },
      { ...plan, extra: "ignored" },
      [],
      null,
    ].map((value) => [value]),
  )("rejects malformed planner output %#", async (value) => {
    expect(await fixture(response(value)).adapter.run(input)).toMatchObject({
      error: { code: "claude_invalid_output" },
    });
  });
  it.each([
    { ...review, outcome: "PASS" },
    { ...review, outcome: "fail" },
    { ...review, requiredFixes: ["Must fix"] },
    { ...review, evidenceArtifactIds: ["invented"] },
  ])("rejects contradictory or unsupported review output %#", async (value) => {
    expect(
      await fixture(response(value)).adapter.run({ ...input, role: "reviewer" }),
    ).toMatchObject({ error: { code: "claude_invalid_output" } });
  });
  it("ignores thinking blocks and normalizes only the bounded final JSON text", async () => {
    const text = JSON.stringify(plan);
    const result = await fixture(
      response(plan, {
        content: [
          {
            type: "thinking",
            thinking: "unpersisted reasoning",
            signature: "not-a-public-artifact",
          },
          { type: "redacted_thinking", data: "private-data" },
          { type: "text", text: text.slice(0, 15), citations: null },
          { type: "text", text: text.slice(15), citations: null },
        ],
      }),
    ).adapter.run(input);
    expect(result.status).toBe("success");
    expect(JSON.stringify(result)).not.toContain("unpersisted");
    expect(JSON.stringify(result)).not.toContain("private-data");
  });
  it.each(
    [
      [],
      [{ type: "text", text: "not json", citations: null }],
      [{ type: "text", text: "x".repeat(256 * 1024 + 1), citations: null }],
      [{ type: "tool_use", id: "tool", name: "unexpected", input: {} }],
      [null],
      Array.from({ length: 65 }, () => ({ type: "text", text: "", citations: null })),
    ].map((content) => [content]),
  )("rejects invalid content blocks %#", async (content) => {
    expect(
      await fixture(response(plan, { content: content as Response["content"] })).adapter.run(input),
    ).toMatchObject({ error: { code: "claude_invalid_output" } });
  });
  it("omits unknown usage components and avoids invalid totals", async () => {
    const partial = await fixture(
      response(plan, {
        usage: { ...usage, cache_creation_input_tokens: null, output_tokens_details: null },
      }),
    ).adapter.run(input);
    expect(partial.usage).toEqual({ outputTokens: 20, cachedInputTokens: 7 });
    const invalid = await fixture(
      response(plan, {
        usage: {
          ...usage,
          input_tokens: Number.MAX_SAFE_INTEGER,
          output_tokens: -1,
          output_tokens_details: { thinking_tokens: 100 },
        },
      }),
    ).adapter.run(input);
    expect(invalid.usage).toEqual({ cachedInputTokens: 7 });
    expect(
      (await fixture(response(plan, { usage: undefined as unknown as Usage })).adapter.run(input))
        .usage,
    ).toBeUndefined();
  });
  it("redacts credential values and secret-shaped input fields without changing the caller's input", async () => {
    const key = "fixture-credential";
    const { adapter, create } = fixture(
      response({ ...plan, summary: `Found ${key}` }),
      {},
      { ANTHROPIC_API_KEY: key },
    );
    const original = {
      ...input,
      goal: `Plan ${key}`,
      context: { password: "other-secret", environment: { VALUE: "other-secret" } },
    };
    const result = await adapter.run(original);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(create.mock.calls)).not.toContain(key);
    expect(JSON.stringify(create.mock.calls)).not.toContain("other-secret");
    expect(original.goal).toContain(key);
    expect(
      await fixture(response(review), {}, { ANTHROPIC_API_KEY: "pass" }).adapter.run({
        ...input,
        role: "reviewer",
      }),
    ).toMatchObject({ error: { code: "claude_invalid_output" } });
  });
  it.each([
    [new Anthropic.APIUserAbortError(), "claude_cancelled", false],
    [new Anthropic.APIConnectionTimeoutError(), "claude_timeout", true],
    [
      new Anthropic.AuthenticationError(401, {}, "private-auth-detail", new Headers()),
      "claude_authentication_failed",
      false,
    ],
    [
      new Anthropic.PermissionDeniedError(403, {}, "private-auth-detail", new Headers()),
      "claude_permission_denied",
      false,
    ],
    [
      new Anthropic.RateLimitError(429, {}, "private-auth-detail", new Headers()),
      "claude_rate_limited",
      true,
    ],
    [
      new Anthropic.BadRequestError(400, {}, "private-auth-detail", new Headers()),
      "claude_invalid_request",
      false,
    ],
    [
      new Anthropic.APIConnectionError({ message: "private-auth-detail" }),
      "claude_connection_failed",
      true,
    ],
    [
      new Anthropic.InternalServerError(529, {}, "private-auth-detail", new Headers()),
      "claude_request_failed",
      true,
    ],
    [new Error("private-auth-detail"), "claude_request_failed", false],
  ] as const)("normalizes provider exception %#", async (error, code, retryable) => {
    const { adapter, create } = fixture();
    create.mockRejectedValue(error);
    const result = await adapter.run(input);
    expect(result).toMatchObject({ status: "failure", error: { code, retryable } });
    expect(JSON.stringify(result)).not.toContain("private-auth-detail");
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("treats an abort arriving during a provider call as cancellation even if the client returns success", async () => {
    const controller = new AbortController();
    const { adapter, create } = fixture();
    create.mockImplementation(async () => {
      controller.abort();
      return response();
    });
    expect(await adapter.run(input, { signal: controller.signal })).toMatchObject({
      error: { code: "claude_cancelled" },
    });
  });
  it("pins the official endpoint and key authentication despite ambient overrides", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://untrusted.invalid");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "ambient-token");
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new globalThis.Response(
          JSON.stringify({
            id: "msg-fixture",
            type: "message",
            role: "assistant",
            model: "fixture-model",
            stop_sequence: null,
            stop_details: null,
            ...response(),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new ClaudeAdapter(
      { model: "fixture-model" },
      { env: { ANTHROPIC_API_KEY: "fixture-key" } },
    );
    expect((await adapter.run(input)).status).toBe("success");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(request?.headers);
    expect(headers.get("x-api-key")).toBe("fixture-key");
    expect(headers.has("authorization")).toBe(false);
  });
  it.each(["timeout", "cancel"] as const)(
    "honors %s through the real SDK transport without network access",
    async (kind) => {
      let started!: () => void;
      const pending = new Promise<void>((resolve) => {
        started = resolve;
      });
      const fetchMock = vi.fn<typeof fetch>(async (_url, options) => {
        started();
        return new Promise<globalThis.Response>((_resolve, reject) => {
          const signal = options?.signal;
          if (signal?.aborted) reject(new DOMException("aborted transport", "AbortError"));
          else
            signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted transport", "AbortError")),
              {
                once: true,
              },
            );
        });
      });
      const client = new Anthropic({
        apiKey: "fixture-key",
        authToken: null,
        baseURL: "https://api.anthropic.com",
        maxRetries: 0,
        logLevel: "off",
        fetch: fetchMock,
      });
      const controller = new AbortController();
      const adapter = new ClaudeAdapter({ model: "fixture-model" }, { client, env: {} });
      const result = adapter.run(input, {
        signal: controller.signal,
        timeoutMs: kind === "timeout" ? 30 : 5000,
      });
      await pending;
      if (kind === "cancel") controller.abort();
      expect(await result).toMatchObject({
        status: "failure",
        error: { code: kind === "timeout" ? "claude_timeout" : "claude_cancelled" },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
  it("keeps the deadline active while the SDK waits for a stalled response body", async () => {
    let cancelled = false;
    const fetchMock = vi.fn<typeof fetch>(
      async (_url, options) =>
        new globalThis.Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"content":'));
              options?.signal?.addEventListener(
                "abort",
                () => {
                  cancelled = true;
                  controller.error(new DOMException("Body aborted", "AbortError"));
                },
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const client = new Anthropic({
      apiKey: "fixture-key",
      authToken: null,
      maxRetries: 0,
      logLevel: "off",
      fetch: fetchMock,
    });
    const adapter = new ClaudeAdapter({ model: "fixture-model" }, { client, env: {} });
    expect(await adapter.run(input, { timeoutMs: 30 })).toMatchObject({
      status: "failure",
      error: { code: "claude_timeout" },
    });
    expect(cancelled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
