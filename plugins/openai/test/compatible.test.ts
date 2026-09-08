import { createServer, type RequestListener } from "node:http";
import { type AgentInput, isJsonValue } from "@veyraoss/protocol";
import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from "../src/index.js";

const options: OpenAICompatibleAdapterOptions = {
  model: "local-model:tag",
  baseURL: "http://127.0.0.1:11434/v1",
};
const input: AgentInput = {
  runId: "run",
  stepId: "plan",
  attemptId: "attempt",
  attempt: 2,
  parentStepId: "parent",
  role: "planner",
  goal: "Plan a verified change",
  artifacts: [{ id: "check", kind: "test-output", path: "checks.txt" }],
};
const plan = {
  summary: "Plan",
  instructions: "Update the greeting and run tests",
  acceptanceCriteria: ["Tests pass"],
  artifactIds: ["check"],
};
const review = {
  summary: "Needs repair",
  outcome: "fail",
  requiredFixes: ["Fix the assertion"],
  evidenceArtifactIds: ["check"],
};
const envelope = (content: unknown = plan, finish_reason: unknown = "stop") => ({
  choices: [{ finish_reason, message: { role: "assistant", content: JSON.stringify(content) } }],
});
const transport = (value: unknown = envelope()) =>
  vi.fn<typeof fetch>(async () => Response.json(value));

async function withServer(handler: RequestListener, body: (baseURL: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address.");
    await body(`http://127.0.0.1:${address.port}/custom/v1`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("OpenAI-compatible adapter", () => {
  it("uses only explicit configuration and basic Chat Completions fields by default", async () => {
    const fetch = transport();
    const adapter = new OpenAICompatibleAdapter(
      { ...options, baseURL: "https://models.example.test/prefix/v1/", maxOutputTokens: 123 },
      {
        fetch,
        env: {
          OPENAI_API_KEY: "unrelated-key",
          OPENAI_BASE_URL: "https://wrong.invalid",
          LOCAL_TOKEN: "not-selected",
        },
      },
    );
    const result = await adapter.run(input);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://models.example.test/prefix/v1/chat/completions");
    expect(request).toMatchObject({
      method: "POST",
      redirect: "error",
      signal: expect.any(AbortSignal),
      headers: { "Content-Type": "application/json" },
    });
    expect(new Headers(request?.headers).has("authorization")).toBe(false);
    const body = JSON.parse(String(request?.body));
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "stream"]);
    expect(body).toMatchObject({
      model: options.model,
      stream: false,
      max_tokens: 123,
      messages: [{ role: "system" }, { role: "user", content: JSON.stringify(input) }],
    });
    expect(body.messages[0].content).toContain("untrusted evidence");
    expect(body.messages[0].content).toContain('"additionalProperties":false');
    expect(result).toMatchObject({
      status: "success",
      summary: "Plan",
      data: { instructions: plan.instructions },
      artifacts: input.artifacts,
      execution: {
        runId: "run",
        stepId: "plan",
        attemptId: "attempt",
        attempt: 2,
        parentStepId: "parent",
      },
    });
    expect(result.timing?.durationMs).toBeGreaterThanOrEqual(0);
    expect(isJsonValue(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("unrelated-key");
  });

  it.each(["text", "json_object", "json_schema"] as const)(
    "sends exactly the selected %s format with conservative capabilities",
    async (responseFormat) => {
      const fetch = transport();
      const adapter = new OpenAICompatibleAdapter(
        { ...options, responseFormat, role: "planner", id: "analysis" },
        { fetch },
      );
      expect(adapter.describe()).toMatchObject({
        id: "analysis",
        provider: "openai-compatible",
        roles: ["planner"],
        capabilities:
          responseFormat === "json_schema" ? ["reasoning", "structured-output"] : ["reasoning"],
      });
      expect(fetch).not.toHaveBeenCalled();
      expect((await adapter.run(input)).status).toBe("success");
      const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
      expect(body.response_format).toEqual(
        responseFormat === "text"
          ? undefined
          : responseFormat === "json_object"
            ? { type: "json_object" }
            : {
                type: "json_schema",
                json_schema: {
                  name: "veyra_planner",
                  strict: true,
                  schema: expect.objectContaining({ type: "object", additionalProperties: false }),
                },
              },
      );
    },
  );

  it.each(["reviewer", "judge"] as const)(
    "normalizes the %s verdict separately from invocation failure",
    async (role) => {
      const fetch = transport(envelope(review));
      const result = await new OpenAICompatibleAdapter({ ...options, role }, { fetch }).run(input);
      expect(result).toMatchObject({
        status: "success",
        outcome: "fail",
        data: { requiredFixes: ["Fix the assertion"], evidenceArtifactIds: ["check"] },
      });
      expect(String(fetch.mock.calls[0]?.[1]?.body)).toContain(`Your role is ${role}`);
      if (role === "judge")
        expect(String(fetch.mock.calls[0]?.[1]?.body)).toContain("context.consensus.reviews");
    },
  );

  it("keeps missing usage unknown and normalizes only valid reported counters", async () => {
    const fetch = transport({
      ...envelope(),
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 3 },
        cost: 0,
      },
    });
    expect((await new OpenAICompatibleAdapter(options, { fetch }).run(input)).usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cachedInputTokens: 2,
      reasoningTokens: 3,
    });
    fetch.mockImplementation(async () =>
      Response.json({
        ...envelope(),
        usage: {
          prompt_tokens: -1,
          completion_tokens: "3",
          total_tokens: 1.5,
          prompt_tokens_details: [],
          completion_tokens_details: { reasoning_tokens: Number.MAX_SAFE_INTEGER + 1 },
        },
      }),
    );
    expect(
      (await new OpenAICompatibleAdapter(options, { fetch }).run(input)).usage,
    ).toBeUndefined();
    fetch.mockImplementation(async () =>
      Response.json({ ...envelope(), usage: { prompt_tokens: 0, completion_tokens: 2 } }),
    );
    expect((await new OpenAICompatibleAdapter(options, { fetch }).run(input)).usage).toEqual({
      inputTokens: 0,
      outputTokens: 2,
    });
  });

  it("selects only apiKeyEnv and redacts credential fields, key variants and bearer text", async () => {
    const key = "fixture/key+secret";
    const fetch = transport(
      envelope({ ...plan, summary: `${key} ${encodeURIComponent(key)} Bearer another-secret` }),
    );
    const adapter = new OpenAICompatibleAdapter(
      { ...options, apiKeyEnv: "LOCAL_KEY" },
      { fetch, env: { LOCAL_KEY: key, OPENAI_API_KEY: "not-this-key" } },
    );
    const result = await adapter.run({
      ...input,
      instructions: key,
      context: {
        nested: { apiKey: "other", environment: { FOO: "private" } },
        note: encodeURIComponent(key),
      },
    });
    const request = fetch.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get("authorization")).toBe(`Bearer ${key}`);
    expect(String(request?.body)).not.toContain(key);
    expect(String(request?.body)).not.toContain(encodeURIComponent(key));
    expect(String(request?.body)).not.toContain("private");
    expect(result.summary).toBe("[REDACTED] [REDACTED] Bearer [REDACTED]");
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it("checks configuration without contacting the endpoint or claiming server access", async () => {
    const fetch = transport();
    expect(
      await new OpenAICompatibleAdapter(options, { fetch, env: {} }).checkReadiness(),
    ).toMatchObject({
      status: "ready",
      scope: "configuration",
      message: expect.stringContaining("without authentication"),
    });
    const adapter = new OpenAICompatibleAdapter(
      { ...options, apiKeyEnv: "LOCAL_KEY" },
      { fetch, env: { OPENAI_API_KEY: "wrong" } },
    );
    expect(await adapter.checkReadiness()).toMatchObject({
      status: "unavailable",
      message: "Set LOCAL_KEY before using the compatible adapter.",
    });
    expect((await adapter.run(input)).error?.code).toBe("compatible_missing_api_key");
    expect(await adapter.checkReadiness({ signal: AbortSignal.abort() })).toMatchObject({
      status: "unknown",
    });
    expect(fetch).not.toHaveBeenCalled();
    const ready = await new OpenAICompatibleAdapter(
      { ...options, apiKeyEnv: "LOCAL_KEY" },
      { fetch, env: { LOCAL_KEY: "fixture-key" } },
    ).checkReadiness();
    expect(ready.message).toContain("output-format support were not tested");
    expect(JSON.stringify(ready)).not.toContain("fixture-key");
  });

  it.each(
    [
      null,
      [],
      { ...options, unknown: true },
      { ...options, apiKey: "never-echo-this" },
      { ...options, model: "" },
      { ...options, model: "x".repeat(513) },
      { ...options, id: "a\nb" },
      { ...options, role: "executor" },
      { ...options, responseFormat: "auto" },
      { ...options, timeoutMs: 0 },
      { ...options, timeoutMs: 86_400_001 },
      { ...options, maxOutputTokens: 1.5 },
      { ...options, maxOutputTokens: 65537 },
      { ...options, apiKeyEnv: "bad-key" },
      { ...options, apiKeyEnv: 123 },
      { ...options, baseURL: undefined },
      { ...options, baseURL: "http://192.168.1.10/v1" },
      { ...options, baseURL: "http://localhost.evil.test/v1" },
      { ...options, baseURL: "ftp://localhost/v1" },
      { ...options, baseURL: "https://user:never-echo-this@example.test/v1" },
      { ...options, baseURL: "https://example.test/v1?key=never-echo-this" },
      { ...options, baseURL: "https://example.test/v1#never-echo-this" },
      { ...options, baseURL: "https://example.test/\nv1" },
      { ...options, baseURL: "https:\\example.test/v1" },
    ].map((value) => [value]),
  )("rejects unsupported or unsafe options without echoing values (%#)", (value) => {
    expect(() => new OpenAICompatibleAdapter(value as OpenAICompatibleAdapterOptions)).toThrow();
    try {
      new OpenAICompatibleAdapter(value as OpenAICompatibleAdapterOptions);
    } catch (error) {
      expect(String(error)).not.toContain("never-echo-this");
    }
  });

  it("rejects accessor options without executing their getters and snapshots ordinary options", () => {
    const getter = vi.fn(() => "http://localhost/v1");
    expect(
      () =>
        new OpenAICompatibleAdapter({
          model: "local",
          get baseURL() {
            return getter();
          },
        }),
    ).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const mutable = { ...options };
    const adapter = new OpenAICompatibleAdapter(mutable);
    mutable.model = "different";
    expect(adapter.describe().model).toBe(options.model);
  });

  it.each([
    "http://localhost/v1",
    "http://127.0.0.2/v1",
    "http://[::1]:1234/v1",
    "https://models.example.test/v1",
  ])("accepts a supported explicit endpoint %s", (baseURL) => {
    expect(new OpenAICompatibleAdapter({ ...options, baseURL }).describe().provider).toBe(
      "openai-compatible",
    );
  });

  it.each([
    [400, "invalid_request", false],
    [422, "invalid_request", false],
    [401, "authentication_failed", false],
    [403, "authentication_failed", false],
    [404, "not_found", false],
    [429, "rate_limited", true],
    [503, "server_failed", true],
    [418, "http_failed", false],
  ] as const)(
    "normalizes HTTP %s without leaking raw bodies or retrying",
    async (status, code, retryable) => {
      const cancel = vi.fn();
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("private-server-detail"));
              },
              cancel,
            }),
            { status },
          ),
      );
      const result = await new OpenAICompatibleAdapter(options, { fetch }).run(input);
      expect(result).toMatchObject({
        status: status === 401 || status === 403 ? "needs_input" : "failure",
        error: { code: `compatible_${code}`, retryable },
      });
      expect(JSON.stringify(result)).not.toContain("private-server-detail");
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(
    [
      null,
      [],
      {},
      { error: { message: "private" }, ...envelope() },
      { choices: [] },
      { choices: [...envelope().choices, ...envelope().choices] },
      envelope({ ...plan, unexpected: true }),
      envelope({ ...plan, acceptanceCriteria: [] }),
      envelope({ ...plan, artifactIds: ["invented"] }),
      {
        choices: [
          { finish_reason: "stop", message: { role: "assistant", content: "```json\n{}\n```" } },
        ],
      },
      {
        choices: [
          { finish_reason: "stop", message: { role: "user", content: JSON.stringify(plan) } },
        ],
      },
      { choices: [{ finish_reason: "stop", message: { role: "assistant", content: null } }] },
      {
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify(plan),
              tool_calls: [{ id: "call" }],
            },
          },
        ],
      },
      {
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify(plan),
              function_call: { name: "do_it" },
            },
          },
        ],
      },
      envelope({ ...plan, summary: "x".repeat(256 * 1024) }),
    ].map((value) => [value]),
  )("fails closed for malformed output (%#)", async (value) => {
    const fetch = transport(value);
    expect((await new OpenAICompatibleAdapter(options, { fetch }).run(input)).error?.code).toBe(
      "compatible_invalid_output",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([null, "length", "tool_calls", "unknown"])(
    "rejects incomplete finish_reason %s even with valid JSON",
    async (reason) => {
      expect(
        (
          await new OpenAICompatibleAdapter(options, {
            fetch: transport(envelope(plan, reason)),
          }).run(input)
        ).error?.code,
      ).toBe("compatible_incomplete");
    },
  );
  it("pauses on refusal/content filtering without exposing provider text", async () => {
    for (const value of [
      envelope(plan, "content_filter"),
      {
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              refusal: "private-refusal",
              content: JSON.stringify(plan),
            },
          },
        ],
      },
    ]) {
      const result = await new OpenAICompatibleAdapter(options, { fetch: transport(value) }).run(
        input,
      );
      expect(result).toMatchObject({
        status: "needs_input",
        error: { code: "compatible_refusal" },
      });
      expect(JSON.stringify(result)).not.toContain("private-refusal");
    }
  });

  it("refuses contradictory review verdicts and unknown evidence", async () => {
    for (const value of [
      { ...review, outcome: "pass" },
      { ...review, requiredFixes: [] },
      { ...review, evidenceArtifactIds: ["unknown"] },
    ]) {
      expect(
        (
          await new OpenAICompatibleAdapter(
            { ...options, role: "reviewer" },
            { fetch: transport(envelope(value)) },
          ).run(input)
        ).error?.code,
      ).toBe("compatible_invalid_output");
    }
  });

  it("rejects invalid input, unsupported roles, oversized input and invalid execution timeouts before HTTP", async () => {
    const fetch = transport();
    const adapter = new OpenAICompatibleAdapter(options, { fetch });
    for (const [value, code] of [
      [{ ...input, goal: "" }, "invalid_input"],
      [{ ...input, context: { date: new Date() } }, "invalid_input"],
      [{ ...input, role: "executor" }, "unsupported_role"],
      [{ ...input, goal: "x".repeat(256 * 1024) }, "input_too_large"],
    ] as const) {
      expect((await adapter.run(value as unknown as AgentInput)).error?.code).toBe(
        `compatible_${code}`,
      );
    }
    expect((await adapter.run(input, { timeoutMs: 0 })).error?.code).toBe(
      "compatible_invalid_timeout",
    );
    expect((await adapter.run(input, { signal: AbortSignal.abort() })).error?.code).toBe(
      "compatible_cancelled",
    );
    expect(
      (
        await new OpenAICompatibleAdapter(
          { ...options, apiKeyEnv: "LOCAL_KEY" },
          { fetch, env: { LOCAL_KEY: "key\nvalue" } },
        ).run(input)
      ).error?.code,
    ).toBe("compatible_invalid_api_key");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds and cancels an oversized streamed body", async () => {
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(512 * 1024 + 1));
            },
            cancel,
          }),
        ),
    );
    expect((await new OpenAICompatibleAdapter(options, { fetch }).run(input)).error?.code).toBe(
      "compatible_invalid_output",
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("normalizes malformed outer JSON and missing body", async () => {
    for (const response of [new Response("not-json"), new Response(null)]) {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
      expect((await new OpenAICompatibleAdapter(options, { fetch }).run(input)).error?.code).toBe(
        "compatible_invalid_output",
      );
    }
  });

  it("uses a complete-body deadline and cancels a stalled reader", async () => {
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"choices":'));
            },
            cancel,
          }),
        ),
    );
    const result = await new OpenAICompatibleAdapter(options, { fetch }).run(input, {
      timeoutMs: 20,
    });
    expect(result.error?.code).toBe("compatible_timeout");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("propagates cancellation during fetch and hides transport exceptions", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_url, request) =>
        new Promise((_resolve, reject) => {
          request?.signal?.addEventListener(
            "abort",
            () => reject(new Error("private-transport-detail")),
            { once: true },
          );
          controller.abort();
        }),
    );
    const result = await new OpenAICompatibleAdapter(options, { fetch }).run(input, {
      signal: controller.signal,
    });
    expect(result.error?.code).toBe("compatible_cancelled");
    expect(JSON.stringify(result)).not.toContain("private-transport-detail");
    fetch.mockRejectedValue(new Error("private-transport-detail"));
    const failed = await new OpenAICompatibleAdapter(options, { fetch }).run(input);
    expect(failed.error?.code).toBe("compatible_connection_failed");
    expect(failed.summary).toContain("start it");
    expect(JSON.stringify(failed)).not.toContain("private-transport-detail");
  });
});

describe("compatible loopback HTTP integration", () => {
  it("sends JSON to a real custom API prefix and parses the server reply", async () => {
    const requests: { url?: string; method?: string; authorization?: string; body: string }[] = [];
    await withServer(
      (req, res) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          requests.push({
            url: req.url,
            method: req.method,
            authorization: req.headers.authorization,
            body,
          });
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(envelope()));
        });
      },
      async (baseURL) => {
        const adapter = new OpenAICompatibleAdapter(
          { ...options, baseURL, responseFormat: "json_object" },
          { env: { OPENAI_API_KEY: "must-not-send" } },
        );
        expect((await adapter.run(input)).status).toBe("success");
      },
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "/custom/v1/chat/completions",
      method: "POST",
      authorization: undefined,
    });
    expect(JSON.parse(requests[0]?.body ?? "{}").response_format).toEqual({ type: "json_object" });
    expect(JSON.stringify(requests)).not.toContain("must-not-send");
  });

  it("refuses HTTP redirects without reaching the redirected credential target", async () => {
    const urls: string[] = [];
    await withServer(
      (req, res) => {
        urls.push(req.url ?? "");
        res.writeHead(307, { Location: "/stolen" });
        res.end();
      },
      async (baseURL) => {
        const result = await new OpenAICompatibleAdapter(
          { ...options, baseURL, apiKeyEnv: "LOCAL_KEY" },
          { env: { LOCAL_KEY: "fixture-key" } },
        ).run(input);
        expect(result.error?.code).toBe("compatible_connection_failed");
        expect(result.summary).toContain("Redirects are refused");
      },
    );
    expect(urls).toEqual(["/custom/v1/chat/completions"]);
  });

  it("aborts a real HTTP body that stops producing data", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"choices":');
      },
      async (baseURL) => {
        const result = await new OpenAICompatibleAdapter({ ...options, baseURL }).run(input, {
          timeoutMs: 100,
        });
        expect(result.error?.code).toBe("compatible_timeout");
      },
    );
  });
});
