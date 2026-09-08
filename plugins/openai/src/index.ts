import {
  type AgentAdapter,
  type AgentDescriptor,
  type AgentReadiness,
  type AgentInput,
  type AgentResult,
  type AgentRunOptions,
  type ExecutionMetadata,
  isJsonValue,
  type UsageMetadata,
} from "@veyra/protocol";
import OpenAI from "openai";
import { createSecretRedactor } from "@veyra/runtime";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
} from "openai/resources/responses/responses";
import { outputFormat, parseOutput, roleInstructions } from "./output.js";
export { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from "./compatible.js";

export interface OpenAIResponsesClient {
  responses: {
    create(
      body: ResponseCreateParamsNonStreaming,
      options?: OpenAI.RequestOptions,
    ): Promise<Pick<Response, "status" | "output" | "output_text" | "usage" | "error">>;
  };
}

export interface OpenAIAdapterOptions {
  model: string;
  id?: string;
  role?: "planner" | "reviewer" | "judge";
  apiKeyEnv?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
}

export class OpenAIAdapter implements AgentAdapter {
  readonly id: string;
  readonly provider = "openai";
  readonly #options: Readonly<OpenAIAdapterOptions>;
  readonly #client?: OpenAIResponsesClient;
  readonly #env: Readonly<NodeJS.ProcessEnv>;

  constructor(
    options: OpenAIAdapterOptions,
    dependencies: { client?: OpenAIResponsesClient; env?: Readonly<NodeJS.ProcessEnv> } = {},
  ) {
    if (
      Object.keys(options).some(
        (key) =>
          !["model", "id", "role", "apiKeyEnv", "timeoutMs", "maxOutputTokens"].includes(key),
      )
    )
      throw new Error("Unknown OpenAI adapter option; use apiKeyEnv for credential indirection.");
    if (options.id !== undefined && (typeof options.id !== "string" || !options.id.trim()))
      throw new Error("OpenAI adapter id must be a non-empty string.");
    if (typeof options.model !== "string" || !options.model.trim())
      throw new Error("OpenAI adapter requires a model.");
    if (options.role !== undefined && !["planner", "reviewer", "judge"].includes(options.role))
      throw new Error("OpenAI role must be planner, reviewer, or judge.");
    if (options.apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.apiKeyEnv))
      throw new Error("apiKeyEnv must name an environment variable, not contain a credential.");
    for (const [name, value] of [
      ["timeoutMs", options.timeoutMs],
      ["maxOutputTokens", options.maxOutputTokens],
    ] as const) {
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) || value <= 0 || value > 2 ** 31 - 1)
      )
        throw new Error(`${name} must be a positive integer below 2^31.`);
    }
    this.id = options.id ?? "openai";
    this.#options = Object.freeze({ ...options });
    this.#client = dependencies.client;
    this.#env = dependencies.env ?? process.env;
  }

  describe(): AgentDescriptor {
    return {
      schemaVersion: 1,
      id: this.id,
      provider: this.provider,
      adapterVersion: "0.1.0",
      model: this.#options.model,
      roles: this.#options.role ? [this.#options.role] : ["planner", "reviewer", "judge"],
      capabilities: ["reasoning", "structured-output"],
    };
  }

  async checkReadiness(options: AgentRunOptions = {}): Promise<AgentReadiness> {
    if (options.signal?.aborted)
      return {
        status: "unknown",
        scope: "configuration",
        message: "OpenAI readiness check was cancelled.",
      };
    if (this.#client)
      return {
        status: "unknown",
        scope: "configuration",
        message:
          "An injected client is configured; its authentication and API access were not probed.",
      };
    const key = this.#options.apiKeyEnv ?? "OPENAI_API_KEY";
    const present = Boolean(this.#env[key]?.trim());
    return {
      status: present ? "ready" : "unavailable",
      scope: "configuration",
      message: present
        ? `${key} is present; API access and model capabilities were not tested.`
        : `Set ${key} before using this adapter.`,
    };
  }

  async run(input: AgentInput, options: AgentRunOptions = {}): Promise<AgentResult> {
    const start = performance.now();
    const startedAt = new Date().toISOString();
    const execution: ExecutionMetadata = {
      runId: input.runId,
      stepId: input.stepId,
      ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
      ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    };
    let usage: UsageMetadata | undefined;
    const finish = (result: AgentResult): AgentResult => ({
      ...result,
      execution,
      timing: {
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: performance.now() - start,
      },
      ...(usage ? { usage } : {}),
    });
    const failure = (
      code: string,
      message: string,
      retryable = false,
      status: "failure" | "needs_input" = "failure",
    ) => finish({ status, summary: message, error: { code, message, retryable } });
    const role: string = this.#options.role ?? input.role;
    if (role !== "planner" && role !== "reviewer" && role !== "judge")
      return failure(
        "openai_unsupported_role",
        "OpenAI adapter supports planner, reviewer, and judge roles.",
      );
    if (!isJsonValue(input) || typeof input.goal !== "string" || !input.goal.trim())
      return failure(
        "openai_invalid_input",
        "Agent input must contain a goal and plain JSON data.",
      );
    if (options.signal?.aborted)
      return failure("openai_cancelled", "OpenAI request was cancelled.");
    const timeout = options.timeoutMs ?? this.#options.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2 ** 31 - 1)
      return failure(
        "openai_invalid_input",
        "OpenAI timeout must be a positive integer below 2^31.",
      );
    const apiKey = this.#env[this.#options.apiKeyEnv ?? "OPENAI_API_KEY"];
    const redactor = createSecretRedactor({ env: this.#env, values: apiKey ? [apiKey] : [] });
    if (!this.#client && !apiKey?.trim())
      return failure(
        "openai_missing_api_key",
        `Set ${this.#options.apiKeyEnv ?? "OPENAI_API_KEY"} before using the OpenAI adapter.`,
      );
    const content = JSON.stringify(redactor.json(input));
    if (Buffer.byteLength(content) > 256 * 1024)
      return failure(
        "openai_input_too_large",
        "OpenAI input exceeds 256 KiB; pass relevant excerpts and artifact references.",
      );
    try {
      const client =
        this.#client ??
        new OpenAI({
          apiKey,
          maxRetries: 0,
          logLevel: "off",
          baseURL: "https://api.openai.com/v1",
        });
      const response = await client.responses.create(
        {
          model: this.#options.model,
          store: false,
          stream: false,
          max_output_tokens: this.#options.maxOutputTokens ?? 8192,
          input: [
            { role: "developer", content: roleInstructions(role) },
            { role: "user", content },
          ],
          text: { format: outputFormat(role) },
        },
        { timeout, signal: options.signal, maxRetries: 0 },
      );
      usage = normalizeUsage(response.usage);
      if (!Array.isArray(response.output))
        return failure("openai_invalid_output", "OpenAI returned an invalid output envelope.");
      if (options.signal?.aborted || response.status === "cancelled")
        return failure("openai_cancelled", "OpenAI request was cancelled.");
      if (
        response.output.some(
          (item) => item.type === "message" && item.content.some((part) => part.type === "refusal"),
        )
      )
        return failure(
          "openai_refusal",
          "OpenAI declined the request; revise it before continuing.",
          false,
          "needs_input",
        );
      if (response.status === "incomplete")
        return failure(
          "openai_incomplete",
          "OpenAI response was incomplete; check the output-token limit or revise the request.",
        );
      if (response.status !== "completed" || response.error)
        return failure("openai_response_failed", "OpenAI did not complete a usable response.");
      if (
        typeof response.output_text !== "string" ||
        Buffer.byteLength(response.output_text) > 256 * 1024
      )
        return failure(
          "openai_invalid_output",
          "OpenAI output is missing or exceeds the 256 KiB limit.",
        );
      let parsed: AgentResult;
      try {
        parsed = parseOutput(role, response.output_text, input.artifacts ?? []);
      } catch {
        return failure(
          "openai_invalid_output",
          "OpenAI response did not match the requested planner/reviewer schema.",
        );
      }
      if (!isJsonValue(parsed))
        return failure("openai_invalid_output", "OpenAI normalization produced non-JSON data.");
      const redacted = redactor.json(parsed);
      if (
        !redacted ||
        typeof redacted !== "object" ||
        Array.isArray(redacted) ||
        redacted.status !== parsed.status ||
        redacted.outcome !== parsed.outcome
      )
        return failure(
          "openai_invalid_output",
          "Credential values must not overlap workflow status or outcome identifiers.",
        );
      return finish(redacted as unknown as AgentResult);
    } catch (error) {
      if (options.signal?.aborted || error instanceof OpenAI.APIUserAbortError)
        return failure("openai_cancelled", "OpenAI request was cancelled.");
      if (error instanceof OpenAI.APIConnectionTimeoutError)
        return failure("openai_timeout", "OpenAI request timed out.", true);
      if (error instanceof OpenAI.AuthenticationError)
        return failure(
          "openai_authentication_failed",
          "OpenAI rejected the configured API credential.",
        );
      if (error instanceof OpenAI.PermissionDeniedError)
        return failure(
          "openai_permission_denied",
          "OpenAI denied access; check project and model permissions.",
        );
      if (error instanceof OpenAI.RateLimitError)
        return failure("openai_rate_limited", "OpenAI rate or quota limit was reached.", true);
      if (error instanceof OpenAI.BadRequestError)
        return failure(
          "openai_invalid_request",
          "OpenAI rejected the request; check model and structured-output support.",
        );
      if (error instanceof OpenAI.APIConnectionError)
        return failure("openai_connection_failed", "Could not connect to OpenAI.", true);
      return failure(
        "openai_request_failed",
        "OpenAI request failed.",
        error instanceof OpenAI.APIError && (error.status ?? 0) >= 500,
      );
    }
  }
}

function normalizeUsage(value: Response["usage"]): UsageMetadata | undefined {
  if (!value) return undefined;
  const usage: UsageMetadata = {};
  for (const [key, count] of [
    ["inputTokens", value.input_tokens],
    ["outputTokens", value.output_tokens],
    ["totalTokens", value.total_tokens],
    ["cachedInputTokens", value.input_tokens_details?.cached_tokens],
    ["reasoningTokens", value.output_tokens_details?.reasoning_tokens],
  ] as const) {
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) usage[key] = count;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}
