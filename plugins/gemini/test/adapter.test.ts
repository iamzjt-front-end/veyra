import { type AgentInput, type JsonObject, isJsonValue } from "@veyraoss/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiAdapter, type GeminiAdapterOptions } from "../src/index.js";
import { env, envelope, input, options, plan, png, review } from "./fixtures.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const transport = (value: unknown = envelope()) =>
  vi.fn<typeof fetch>(async () => Response.json(value));

describe("Gemini API adapter", () => {
  it("sends one stateless constrained request to the fixed Developer API without tools or ambient credentials", async () => {
    vi.stubEnv("GOOGLE_GEMINI_BASE_URL", "https://untrusted.invalid");
    vi.stubEnv("GOOGLE_GENAI_USE_VERTEXAI", "true");
    vi.stubEnv("GOOGLE_API_KEY", "wrong-key");
    const fetch = transport();
    vi.stubGlobal("fetch", fetch);
    const adapter = new GeminiAdapter(
      { ...options, id: "planning", maxOutputTokens: 1234 },
      { env },
    );
    const result = await adapter.run(input, { cwd: "/unused", timeoutMs: 5000 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(request).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      signal: expect.any(AbortSignal),
    });
    const body = JSON.parse(String(request?.body));
    expect(body).toMatchObject({
      store: false,
      contents: [{ role: "user", parts: [{ text: JSON.stringify(input) }] }],
      generationConfig: {
        candidateCount: 1,
        maxOutputTokens: 1234,
        responseMimeType: "application/json",
        responseJsonSchema: { type: "object", additionalProperties: false },
      },
    });
    expect(body.systemInstruction.parts[0].text).toContain("untrusted evidence");
    expect(body.tools).toBeUndefined();
    expect(body.safetySettings).toBeUndefined();
    expect(body.cachedContent).toBeUndefined();
    expect(result).toMatchObject({
      status: "success",
      data: { instructions: plan.instructions },
      execution: {
        runId: "run",
        stepId: "plan",
        attemptId: "attempt",
        attempt: 2,
        parentStepId: "parent",
      },
      usage: { inputTokens: 20, outputTokens: 5, reasoningTokens: 3, totalTokens: 28 },
    });
    expect(result.timing?.durationMs).toBeGreaterThanOrEqual(0);
    expect(isJsonValue(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(env.GEMINI_API_KEY);
  });
  it("describes declared roles and only advertises enabled, model-supported vision without making requests", () => {
    const fetch = transport();
    expect(new GeminiAdapter(options, { fetch, env }).describe()).toMatchObject({
      roles: ["planner", "reviewer"],
      capabilities: ["reasoning", "structured-output"],
    });
    expect(
      new GeminiAdapter(
        { model: "models/gemini-2.5-pro", vision: true, role: "reviewer" },
        { fetch, env },
      ).describe(),
    ).toMatchObject({
      model: "gemini-2.5-pro",
      roles: ["reviewer"],
      capabilities: ["reasoning", "structured-output", "vision"],
    });
    expect(
      new GeminiAdapter({ model: "custom-text-model" }, { fetch, env }).describe().capabilities,
    ).not.toContain("vision");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses an explicit role override and configured key variable", async () => {
    const fetch = transport(envelope(review));
    const adapter = new GeminiAdapter(
      { ...options, role: "reviewer", apiKeyEnv: "CUSTOM_GEMINI" },
      { fetch, env: { CUSTOM_GEMINI: "custom-key" } },
    );
    expect(await adapter.run(input)).toMatchObject({ status: "success", outcome: "pass" });
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ "x-goog-api-key": "custom-key" });
    expect(
      JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).generationConfig.responseJsonSchema
        .required,
    ).toContain("outcome");
  });
  it("checks only credential presence and never calls HTTP during readiness", async () => {
    const fetch = transport();
    expect(await new GeminiAdapter(options, { fetch, env }).checkReadiness()).toMatchObject({
      status: "ready",
      scope: "configuration",
    });
    expect(await new GeminiAdapter(options, { fetch, env: {} }).checkReadiness()).toMatchObject({
      status: "unavailable",
    });
    expect(
      await new GeminiAdapter(options, { fetch, env }).checkReadiness({
        signal: AbortSignal.abort(),
      }),
    ).toMatchObject({ status: "unknown" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects invalid, excessive, unsupported-role, missing-key and pre-cancelled input before HTTP", async () => {
    const fetch = transport();
    const adapter = new GeminiAdapter(options, { fetch, env });
    expect((await adapter.run({ ...input, goal: " " })).error?.code).toBe("gemini_invalid_input");
    expect(
      (await adapter.run({ ...input, context: { invalid: new Date() } } as unknown as AgentInput))
        .error?.code,
    ).toBe("gemini_invalid_input");
    expect((await adapter.run({ ...input, goal: "x".repeat(256 * 1024) })).error?.code).toBe(
      "gemini_input_too_large",
    );
    expect((await adapter.run({ ...input, role: "executor" })).error?.code).toBe(
      "gemini_unsupported_role",
    );
    expect((await adapter.run(input, { signal: AbortSignal.abort() })).error?.code).toBe(
      "gemini_cancelled",
    );
    expect((await adapter.run(input, { timeoutMs: 0 })).error?.code).toBe("gemini_invalid_timeout");
    expect((await new GeminiAdapter(options, { fetch, env: {} }).run(input)).error?.code).toBe(
      "gemini_missing_api_key",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    [400, "gemini_invalid_request", false],
    [401, "gemini_authentication_failed", false],
    [403, "gemini_permission_denied", false],
    [404, "gemini_model_not_found", false],
    [408, "gemini_request_failed", true],
    [429, "gemini_rate_limited", true],
    [500, "gemini_request_failed", true],
    [503, "gemini_request_failed", true],
  ] as const)(
    "normalizes HTTP %i with no retries or raw error leakage",
    async (status, code, retryable) => {
      const cancel = vi.fn();
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("private upstream error"));
              },
              cancel,
            }),
            { status },
          ),
      );
      const result = await new GeminiAdapter(options, { fetch, env }).run(input);
      expect(result).toMatchObject({ status: "failure", error: { code, retryable } });
      expect(JSON.stringify(result)).not.toContain("private upstream");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
  it("normalizes network errors without echoing native exceptions", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error("private transport credential");
    });
    const result = await new GeminiAdapter(options, { fetch, env }).run(input);
    expect(result.error).toMatchObject({ code: "gemini_connection_failed", retryable: true });
    expect(JSON.stringify(result)).not.toContain("private transport");
  });
  it.each(
    [
      null,
      [],
      {},
      { candidates: [] },
      { candidates: [envelope().candidates[0], envelope().candidates[0]] },
      { candidates: [null] },
      { candidates: [{ finishReason: "STOP", content: {} }] },
      { candidates: [{ finishReason: "STOP", content: { parts: [null] } }] },
      {
        candidates: [
          { finishReason: "STOP", content: { parts: [{ functionCall: { name: "execute" } }] } },
        ],
      },
      envelope({ ...plan, artifactIds: ["invented"] }),
      envelope({ ...plan, summary: " " }),
      envelope({ ...plan, summary: "x".repeat(256 * 1024) }),
    ].map((value) => [value]),
  )("rejects invalid response %#", async (value) => {
    expect(
      (await new GeminiAdapter(options, { fetch: transport(value), env }).run(input)).error?.code,
    ).toBe("gemini_invalid_output");
  });
  it.each(["MAX_TOKENS", "OTHER", undefined, { toString: "invalid" }].map((reason) => [reason]))(
    "rejects incomplete or malformed finish reason %#",
    async (finishReason) => {
      const value = { candidates: [{ ...envelope().candidates[0], finishReason }] };
      expect(
        (await new GeminiAdapter(options, { fetch: transport(value), env }).run(input)).error?.code,
      ).toBe("gemini_incomplete");
    },
  );
  it.each(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"])(
    "normalizes %s refusal as needs_input and preserves reported usage",
    async (finishReason) => {
      const value = { ...envelope(), candidates: [{ ...envelope().candidates[0], finishReason }] };
      expect(
        await new GeminiAdapter(options, { fetch: transport(value), env }).run(input),
      ).toMatchObject({
        status: "needs_input",
        error: { code: "gemini_blocked" },
        usage: { totalTokens: 28 },
      });
    },
  );
  it("handles prompt refusal, ignores hidden thoughts and masks known secrets", async () => {
    expect(
      await new GeminiAdapter(options, {
        fetch: transport({ promptFeedback: { blockReason: "SAFETY" } }),
        env,
      }).run(input),
    ).toMatchObject({ status: "needs_input", error: { code: "gemini_blocked" } });
    const fetch = transport({
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              { thought: true, text: "private deliberation" },
              { text: JSON.stringify({ ...plan, summary: env.GEMINI_API_KEY }) },
            ],
          },
        },
      ],
    });
    const result = await new GeminiAdapter(options, { fetch, env }).run({
      ...input,
      context: {
        apiKey: "nested-secret",
        note: env.GEMINI_API_KEY,
        environment: { SECRET: "hidden" },
      },
    });
    expect(result.summary).toBe("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain("private deliberation");
    expect(
      JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).contents[0].parts[0].text,
    ).not.toMatch(/fixture-gemini-key|nested-secret|hidden/);
  });
  it("sends enabled images as separate parts without duplicating base64 into the prompt or mutating input", async () => {
    const fetch = transport();
    const withImage = { ...input, context: { images: [{ mimeType: "image/png", data: png }] } };
    expect(
      (await new GeminiAdapter({ ...options, vision: true }, { fetch, env }).run(withImage)).status,
    ).toBe("success");
    const parts = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).contents[0].parts;
    expect(parts[0].text).not.toContain(png);
    expect(parts[1]).toEqual({ inlineData: { mimeType: "image/png", data: png } });
    expect(withImage.context.images[0]?.data).toBe(png);
  });
  it.each([
    { mimeType: "image/png", data: "not-base64" },
    { mimeType: "image/svg+xml", data: png },
    { mimeType: "image/png", data: png, url: "https://untrusted.invalid" },
    { mimeType: "image/png", path: "../../secret" },
    { mimeType: "image/png", data: "YQ=" },
    { mimeType: "image/png", data: "Zh==" },
  ])("rejects unsafe or malformed images %# without HTTP", async (image) => {
    const fetch = transport();
    const adapter = new GeminiAdapter({ ...options, vision: true }, { fetch, env });
    const result = await adapter.run({
      ...input,
      context: { images: [image as unknown as JsonObject] },
    });
    expect(result.error?.code).toBe("gemini_invalid_images");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects disabled images, non-array input and excessive image count", async () => {
    const fetch = transport();
    const adapter = new GeminiAdapter(options, { fetch, env });
    for (const images of [
      [{ mimeType: "image/png", data: png }],
      "path",
      new Array(5).fill({ mimeType: "image/png", data: png }),
    ]) {
      expect((await adapter.run({ ...input, context: { images } })).error?.code).toBe(
        "gemini_invalid_images",
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(
    [
      null,
      [],
      {},
      { model: "" },
      { model: "https://untrusted.invalid" },
      { model: "../../secret" },
      { ...options, role: "executor" },
      { ...options, apiKey: "forbidden" },
      { ...options, baseUrl: "https://untrusted.invalid" },
      { ...options, timeoutMs: 0 },
      { ...options, maxOutputTokens: 0 },
      { ...options, maxOutputTokens: 65537 },
      { ...options, vision: "true" },
      { model: "unknown", vision: true },
      { model: "gemini-2.5-flash-preview-09-2025", vision: true },
      { ...options, apiKeyEnv: "bad name" },
      { ...options, id: "x".repeat(129) },
    ].map((value) => [value]),
  )("rejects invalid options %#", (value) => {
    expect(() => new GeminiAdapter(value as GeminiAdapterOptions)).toThrow();
  });
});

describe("Gemini transport deadlines and bounds", () => {
  it("propagates timeout through fetch and external cancellation without persisting controls", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_url, request) =>
        new Promise((_resolve, reject) => {
          request?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("private abort", "AbortError")),
            { once: true },
          );
        }),
    );
    const adapter = new GeminiAdapter({ ...options, timeoutMs: 10 }, { fetch, env });
    expect((await adapter.run(input)).error?.code).toBe("gemini_timeout");
    const controller = new AbortController();
    const pending = adapter.run(input, { timeoutMs: 1000, signal: controller.signal });
    controller.abort();
    expect((await pending).error?.code).toBe("gemini_cancelled");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("cancels a stalled response body after headers and releases the reader", async () => {
    const cancel = vi.fn();
    let body: ReadableStream<Uint8Array> | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"candidates":['));
        },
        cancel,
      });
      return new Response(body);
    });
    const result = await new GeminiAdapter({ ...options, timeoutMs: 20 }, { fetch, env }).run(
      input,
    );
    expect(result.error?.code).toBe("gemini_timeout");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body?.locked).toBe(false);
  });
  it("handles invalid JSON, missing bodies and oversized streamed responses with cancellation", async () => {
    for (const response of [new Response("not JSON"), new Response(null)]) {
      expect(
        (await new GeminiAdapter(options, { fetch: async () => response, env }).run(input)).error
          ?.code,
      ).toBe("gemini_invalid_output");
    }
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(512 * 1024 + 1));
      },
      cancel,
    });
    const result = await new GeminiAdapter(options, {
      fetch: async () => new Response(body),
      env,
    }).run(input);
    expect(result.error?.code).toBe("gemini_invalid_output");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
});
