import { type AgentInput, isJsonValue } from "@veyra/protocol";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIAdapter, type OpenAIResponsesClient } from "../src/index.js";

const input: AgentInput = {
  runId: "run-1",
  stepId: "plan",
  attemptId: "attempt-1",
  attempt: 1,
  role: "planner",
  goal: "Repair the fixture",
  instructions: "Keep the change small",
  context: { previous: { summary: "One failing test" } },
  artifacts: [{ id: "test-log", kind: "verification", path: "artifacts/test.txt" }],
};
const plan = {
  summary: "Fix the fixture",
  instructions: "Correct the greeting",
  acceptanceCriteria: ["node --test passes"],
  artifactIds: ["test-log"],
};
type Response = Awaited<ReturnType<OpenAIResponsesClient["responses"]["create"]>>;

function fixture(output: unknown = plan, override: Partial<Response> = {}): Response {
  return {
    status: "completed",
    output: [],
    output_text: JSON.stringify(output),
    error: null,
    ...override,
  };
}

function adapter(
  response = fixture(),
  options: Partial<ConstructorParameters<typeof OpenAIAdapter>[0]> = {},
) {
  const create = vi.fn<OpenAIResponsesClient["responses"]["create"]>(async () => response);
  return {
    adapter: new OpenAIAdapter(
      { model: "fixture-model", ...options },
      { client: { responses: { create } } },
    ),
    create,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OpenAI reasoning adapter", () => {
  it("describes only implemented text/structured capabilities without probing the API", async () => {
    const { adapter: instance, create } = adapter();
    const description = instance.describe();
    expect(description).toMatchObject({
      schemaVersion: 1,
      provider: "openai",
      adapterVersion: "0.1.0",
      model: "fixture-model",
      roles: ["planner", "reviewer", "judge"],
      capabilities: ["reasoning", "structured-output"],
    });
    description.capabilities.push("vision");
    expect(instance.describe().capabilities).not.toContain("vision");
    expect(adapter(fixture(), { role: "judge" }).adapter.describe().roles).toEqual(["judge"]);
    expect(await instance.checkReadiness()).toMatchObject({
      status: "unknown",
      scope: "configuration",
    });
    expect(create).not.toHaveBeenCalled();
  });
  it("reports credential presence without exposing its value or claiming remote readiness", async () => {
    const instance = new OpenAIAdapter({ model: "fixture-model", apiKeyEnv: "VEYRA_TEST_API_KEY" });
    vi.stubEnv("VEYRA_TEST_API_KEY", "");
    expect(await instance.checkReadiness()).toMatchObject({
      status: "unavailable",
      scope: "configuration",
    });
    vi.stubEnv("VEYRA_TEST_API_KEY", "fixture-secret-value");
    const result = await instance.checkReadiness();
    expect(result).toMatchObject({ status: "ready", scope: "configuration" });
    expect(result.message).toContain("were not tested");
    expect(JSON.stringify(result)).not.toContain("fixture-secret-value");
    expect((await instance.checkReadiness({ signal: AbortSignal.abort() })).status).toBe("unknown");
  });
  it.each([
    { model: "" },
    { model: "fixture", id: " " },
    { model: "fixture", timeoutMs: -1 },
    { model: "fixture", maxOutputTokens: 0 },
    { model: "fixture", apiKeyEnv: "credential-with-hyphens" },
    { model: "fixture", apiKey: "do-not-store-this" },
  ])("rejects invalid adapter configuration %#", (options) => {
    expect(() => new OpenAIAdapter(options)).toThrow();
  });
  it("normalizes a plan and preserves the developer/user instruction boundary", async () => {
    const { adapter: instance, create } = adapter();
    const result = await instance.run(input);
    expect(result).toMatchObject({
      status: "success",
      summary: plan.summary,
      execution: {
        runId: input.runId,
        stepId: input.stepId,
        attemptId: input.attemptId,
        attempt: 1,
      },
      data: { instructions: plan.instructions, acceptanceCriteria: plan.acceptanceCriteria },
      artifacts: input.artifacts,
    });
    expect(isJsonValue(result)).toBe(true);
    expect(result.timing?.durationMs).toBeGreaterThanOrEqual(0);
    const body = create.mock.calls[0]?.[0];
    expect(body).toMatchObject({
      model: "fixture-model",
      store: false,
      stream: false,
      max_output_tokens: 8192,
      text: {
        format: {
          type: "json_schema",
          name: "veyra_planner",
          strict: true,
          schema: { additionalProperties: false },
        },
      },
    });
    expect(Array.isArray(body?.input)).toBe(true);
    if (!Array.isArray(body?.input)) throw new Error("Expected message input");
    expect(body.input[0]).toMatchObject({ role: "developer" });
    expect(JSON.stringify(body.input[0])).not.toContain(input.goal);
    expect(body.input[1]).toEqual({ role: "user", content: JSON.stringify(input) });
    expect(create.mock.calls[0]?.[1]).toMatchObject({ timeout: 120000, maxRetries: 0 });
    expect(result.usage).toBeUndefined();
  });

  it.each(["pass", "fail"] as const)(
    "keeps a reviewer %s outcome separate from execution status",
    async (outcome) => {
      const { adapter: instance } = adapter(
        fixture({
          outcome,
          summary: "Review complete",
          requiredFixes: outcome === "pass" ? [] : ["Fix the remaining test"],
          evidenceArtifactIds: ["test-log"],
        }),
      );
      const result = await instance.run({ ...input, role: "reviewer", stepId: "review" });
      expect(result).toMatchObject({
        status: "success",
        outcome,
        data: { evidenceArtifactIds: ["test-log"] },
      });
      expect(result.artifacts).toEqual(input.artifacts);
      expect(isJsonValue(result)).toBe(true);
    },
  );

  it("supports an explicitly configured role for a named agent", async () => {
    const { adapter: instance } = adapter(fixture(), { role: "planner", id: "architect" });
    expect(instance.id).toBe("architect");
    expect((await instance.run({ ...input, role: "architect" })).status).toBe("success");
  });

  it.each(["pass", "fail"] as const)(
    "normalizes an explicit judge %s using the review schema",
    async (outcome) => {
      const { adapter: instance, create } = adapter(
        fixture({
          outcome,
          summary: "Arbitrated",
          requiredFixes: outcome === "pass" ? [] : ["Fix the bug"],
          evidenceArtifactIds: [],
        }),
      );
      const result = await instance.run({
        ...input,
        role: "judge",
        context: {
          consensus: { reviews: [{ verdict: "pass" }, { verdict: "fail" }], verification: [] },
        },
      });
      expect(result).toMatchObject({ status: "success", outcome });
      expect(create.mock.calls[0]?.[0].text?.format).toMatchObject({
        name: "veyra_judge",
        strict: true,
      });
      expect(JSON.stringify(create.mock.calls[0]?.[0].input)).toContain(
        "cannot override required deterministic checks",
      );
    },
  );

  it.each([
    {},
    { ...plan, acceptanceCriteria: [] },
    { ...plan, instructions: 42 },
    { ...plan, artifactIds: ["invented-artifact"] },
    { ...plan, extra: "unexpected" },
  ])("rejects malformed planner output %#", async (output) => {
    const { adapter: instance } = adapter(fixture(output));
    expect((await instance.run(input)).error?.code).toBe("openai_invalid_output");
  });

  it.each([
    { outcome: "PASS", summary: "Review", requiredFixes: [], evidenceArtifactIds: [] },
    {
      outcome: "pass",
      summary: "Review",
      requiredFixes: ["Still broken"],
      evidenceArtifactIds: [],
    },
    { outcome: "fail", summary: "Review", requiredFixes: [], evidenceArtifactIds: [] },
  ])("rejects contradictory review output %#", async (output) => {
    const { adapter: instance } = adapter(fixture(output));
    const result = await instance.run({ ...input, role: "reviewer" });
    expect(result.status).toBe("failure");
    expect(result.error?.code).toBe("openai_invalid_output");
    expect(result.outcome).toBeUndefined();
  });

  it.each(["invalid-json", "x".repeat(256 * 1024 + 1)])(
    "rejects unusable output without retaining it %#",
    async (output_text) => {
      const { adapter: instance } = adapter(fixture(plan, { output_text }));
      const result = await instance.run(input);
      expect(result.error?.code).toBe("openai_invalid_output");
      expect(JSON.stringify(result).length).toBeLessThan(1000);
    },
  );

  it("returns needs_input for a refusal without persisting its raw content", async () => {
    const { adapter: instance } = adapter(
      fixture(plan, {
        output: [
          {
            id: "message",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "refusal", refusal: "private-provider-text" }],
          },
        ],
      }),
    );
    const result = await instance.run(input);
    expect(result).toMatchObject({ status: "needs_input", error: { code: "openai_refusal" } });
    expect(JSON.stringify(result)).not.toContain("private-provider-text");
  });

  it.each(["incomplete", "failed", "in_progress"] as const)(
    "does not accept a %s response",
    async (status) => {
      const { adapter: instance } = adapter(fixture(plan, { status }));
      expect((await instance.run(input)).status).toBe("failure");
    },
  );

  it("normalizes known token counts while leaving unknown cost absent", async () => {
    const { adapter: instance } = adapter(
      fixture(plan, {
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          total_tokens: 20,
          input_tokens_details: { cached_tokens: 4, cache_write_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 3 },
        },
      }),
    );
    const result = await instance.run(input);
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
      cachedInputTokens: 4,
      reasoningTokens: 3,
    });
  });

  it("forwards timeout/cancellation and honors an already-aborted request", async () => {
    const { adapter: instance, create } = adapter();
    const controller = new AbortController();
    await instance.run(input, { timeoutMs: 1234, signal: controller.signal });
    expect(create.mock.calls[0]?.[1]).toMatchObject({
      timeout: 1234,
      signal: controller.signal,
      maxRetries: 0,
    });
    controller.abort();
    const result = await instance.run(input, { signal: controller.signal });
    expect(result.error?.code).toBe("openai_cancelled");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("normalizes cancellation during an SDK request", async () => {
    const controller = new AbortController();
    const client: OpenAIResponsesClient = {
      responses: {
        create: (_body, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(new OpenAI.APIUserAbortError()),
              { once: true },
            );
          }),
      },
    };
    const running = new OpenAIAdapter({ model: "fixture" }, { client }).run(input, {
      signal: controller.signal,
    });
    controller.abort();
    expect((await running).error?.code).toBe("openai_cancelled");
  });

  it.each([
    [new OpenAI.APIConnectionTimeoutError(), "openai_timeout", true],
    [
      new OpenAI.AuthenticationError(
        401,
        { message: "private-key-value" },
        "private-key-value",
        new Headers(),
      ),
      "openai_authentication_failed",
      false,
    ],
    [
      new OpenAI.RateLimitError(429, {}, "private-key-value", new Headers()),
      "openai_rate_limited",
      true,
    ],
    [
      new OpenAI.BadRequestError(400, {}, "private-key-value", new Headers()),
      "openai_invalid_request",
      false,
    ],
    [
      new OpenAI.APIConnectionError({ message: "private-key-value" }),
      "openai_connection_failed",
      true,
    ],
    [new Error("private-key-value"), "openai_request_failed", false],
  ] as const)(
    "normalizes SDK failure %# without exposing raw diagnostics",
    async (error, code, retryable) => {
      const client: OpenAIResponsesClient = {
        responses: {
          create: async () => {
            throw error;
          },
        },
      };
      const result = await new OpenAIAdapter({ model: "fixture" }, { client }).run(input);
      expect(result).toMatchObject({ status: "failure", error: { code, retryable } });
      expect(JSON.stringify(result)).not.toContain("private-key-value");
      expect(isJsonValue(result)).toBe(true);
    },
  );

  it("fails missing credentials without creating a network request", async () => {
    vi.stubEnv("VEYRA_TEST_OPENAI_KEY", undefined);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const result = await new OpenAIAdapter({
      model: "fixture",
      apiKeyEnv: "VEYRA_TEST_OPENAI_KEY",
    }).run(input);
    expect(result.error?.code).toBe("openai_missing_api_key");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the official SDK with an environment key and mocked HTTP transport", async () => {
    const key = "fixture-api-credential";
    vi.stubEnv("VEYRA_TEST_OPENAI_KEY", "different-ambient-credential");
    vi.stubEnv("OPENAI_LOG", "debug");
    vi.stubEnv("OPENAI_BASE_URL", "https://unexpected.invalid/v1");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "response-fixture",
            object: "response",
            status: "completed",
            error: null,
            usage: null,
            output: [
              {
                id: "message",
                type: "message",
                status: "completed",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({ ...plan, summary: key }),
                    annotations: [],
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const instance = new OpenAIAdapter(
      {
        model: "fixture-model",
        apiKeyEnv: "VEYRA_TEST_OPENAI_KEY",
      },
      { env: { VEYRA_TEST_OPENAI_KEY: key } },
    );
    expect(await instance.checkReadiness()).toMatchObject({
      status: "ready",
      scope: "configuration",
    });
    const result = await instance.run({
      ...input,
      instructions: key,
      context: { password: "hidden-input-password" },
    });
    expect(result).toMatchObject({ status: "success", summary: "[REDACTED]" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const call = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(call[0])).toBe("https://api.openai.com/v1/responses");
    const body = String(call[1].body);
    expect(body).not.toContain(key);
    expect(body).not.toContain("hidden-input-password");
    expect(JSON.stringify(call)).not.toContain("different-ambient-credential");
    expect(new Headers(call[1].headers).get("authorization")).toBe(`Bearer ${key}`);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(debug).not.toHaveBeenCalled();
  });

  it("does not fall back from an explicitly supplied empty environment to ambient OpenAI auth", async () => {
    vi.stubEnv("OPENAI_API_KEY", "ambient-credential");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const instance = new OpenAIAdapter({ model: "fixture" }, { env: {} });
    expect((await instance.checkReadiness()).status).toBe("unavailable");
    expect((await instance.run(input)).error?.code).toBe("openai_missing_api_key");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unsupported roles and oversized context before calling the client", async () => {
    const { adapter: instance, create } = adapter();
    expect((await instance.run({ ...input, role: "executor" })).error?.code).toBe(
      "openai_unsupported_role",
    );
    expect((await instance.run({ ...input, goal: "x".repeat(256 * 1024) })).error?.code).toBe(
      "openai_input_too_large",
    );
    expect(create).not.toHaveBeenCalled();
  });
});
