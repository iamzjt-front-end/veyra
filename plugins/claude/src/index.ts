import Anthropic from "@anthropic-ai/sdk";
import { createDeadline, createSecretRedactor } from "@veyra/runtime";
import type {
  Message,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/messages";
import {
  isJsonValue,
  type AgentAdapter,
  type AgentDescriptor,
  type AgentInput,
  type AgentReadiness,
  type AgentResult,
  type AgentRunOptions,
  type ExecutionMetadata,
  type UsageMetadata,
} from "@veyra/protocol";
import { outputFormat, parseOutput, roleInstructions, type ClaudeRole } from "./output.js";

export interface ClaudeMessagesClient {
  messages: {
    create(
      body: MessageCreateParamsNonStreaming,
      options?: Anthropic.RequestOptions,
    ): Promise<
      Pick<Message, "content" | "stop_reason" | "usage"> & Partial<Pick<Message, "stop_details">>
    >;
  };
}

export interface ClaudeAdapterOptions {
  model: string;
  id?: string;
  role?: ClaudeRole;
  apiKeyEnv?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly id: string;
  readonly provider = "claude";
  readonly #options: Readonly<ClaudeAdapterOptions>;
  readonly #client?: ClaudeMessagesClient;
  readonly #env: Readonly<NodeJS.ProcessEnv>;

  constructor(
    options: ClaudeAdapterOptions,
    dependencies: { client?: ClaudeMessagesClient; env?: Readonly<NodeJS.ProcessEnv> } = {},
  ) {
    if (
      Object.keys(options).some(
        (key) =>
          !["model", "id", "role", "apiKeyEnv", "timeoutMs", "maxOutputTokens"].includes(key),
      )
    )
      throw new Error("Unknown Claude adapter option; credentials must use apiKeyEnv indirection.");
    if (
      typeof options.model !== "string" ||
      !options.model.trim() ||
      [...options.model].length > 512
    )
      throw new Error("Claude requires a model of at most 512 characters.");
    if (
      options.id !== undefined &&
      (typeof options.id !== "string" || !options.id.trim() || [...options.id].length > 128)
    )
      throw new Error("Claude adapter id must contain 1 to 128 characters.");
    if (options.role !== undefined && !["planner", "reviewer", "judge"].includes(options.role))
      throw new Error("Claude role must be planner, reviewer, or judge.");
    if (
      options.apiKeyEnv !== undefined &&
      (typeof options.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.apiKeyEnv))
    )
      throw new Error("apiKeyEnv must name an environment variable.");
    for (const [name, value] of [
      ["timeoutMs", options.timeoutMs],
      ["maxOutputTokens", options.maxOutputTokens],
    ] as const)
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) ||
          value <= 0 ||
          value > (name === "timeoutMs" ? 86_400_000 : 2 ** 31 - 1))
      )
        throw new Error(
          `${name} must be a positive integer no greater than ${name === "timeoutMs" ? 86_400_000 : 2 ** 31 - 1}.`,
        );
    this.id = options.id ?? "claude";
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
        message: "Claude readiness check was cancelled.",
      };
    if (this.#client)
      return {
        status: "unknown",
        scope: "configuration",
        message: "An injected client is configured; API authentication and access were not probed.",
      };
    const key = this.#options.apiKeyEnv ?? "ANTHROPIC_API_KEY";
    const present = Boolean(this.#env[key]?.trim());
    return {
      status: present ? "ready" : "unavailable",
      scope: "configuration",
      message: present
        ? `${key} is present; API access and model capabilities were not tested.`
        : `Set ${key} before using the Claude adapter.`,
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
      ...(input.parentStepId !== undefined ? { parentStepId: input.parentStepId } : {}),
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
        "claude_unsupported_role",
        "Claude adapter supports planner, reviewer, and judge roles.",
      );
    if (!isJsonValue(input) || typeof input.goal !== "string" || !input.goal.trim())
      return failure(
        "claude_invalid_input",
        "Agent input must contain a goal and plain JSON data.",
      );
    if (options.signal?.aborted)
      return failure("claude_cancelled", "Claude request was cancelled.");
    const timeout = options.timeoutMs ?? this.#options.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 86_400_000)
      return failure(
        "claude_invalid_input",
        "Claude timeout must be an integer from 1 to 86400000 milliseconds.",
      );
    const keyName = this.#options.apiKeyEnv ?? "ANTHROPIC_API_KEY";
    const apiKey = this.#env[keyName];
    const redactor = createSecretRedactor({ env: this.#env, values: apiKey ? [apiKey] : [] });
    if (!this.#client && !apiKey?.trim())
      return failure("claude_missing_api_key", `Set ${keyName} before using the Claude adapter.`);
    const content = JSON.stringify(redactor.json(input));
    if (Buffer.byteLength(content) > 256 * 1024)
      return failure(
        "claude_input_too_large",
        "Claude input exceeds 256 KiB; supply relevant excerpts and artifact references.",
      );
    const deadline = createDeadline(timeout, options.signal);
    try {
      const client =
        this.#client ??
        new Anthropic({
          apiKey,
          authToken: null,
          baseURL: "https://api.anthropic.com",
          timeout,
          maxRetries: 0,
          logLevel: "off",
        });
      const response = await client.messages.create(
        {
          model: this.#options.model,
          max_tokens: this.#options.maxOutputTokens ?? 8192,
          stream: false,
          system: roleInstructions(role),
          messages: [{ role: "user", content }],
          output_config: { format: outputFormat(role) },
        },
        { signal: deadline.signal, timeout, maxRetries: 0 },
      );
      usage = normalizeUsage(response.usage);
      if (options.signal?.aborted)
        return failure("claude_cancelled", "Claude request was cancelled.");
      if (deadline.timedOut()) return failure("claude_timeout", "Claude request timed out.", true);
      if (response.stop_reason === "refusal" || response.stop_details?.type === "refusal")
        return failure(
          "claude_refusal",
          "Claude declined the request; revise it before continuing.",
          false,
          "needs_input",
        );
      if (
        response.stop_reason === "max_tokens" ||
        response.stop_reason === "model_context_window_exceeded"
      )
        return failure(
          "claude_incomplete",
          "Claude output was incomplete; check token limits and supplied context.",
        );
      if (response.stop_reason !== "end_turn")
        return failure(
          "claude_incomplete",
          "Claude did not complete a final response; this adapter does not execute tool or continuation requests.",
        );
      if (!Array.isArray(response.content) || response.content.length > 64)
        return failure("claude_invalid_output", "Claude returned an invalid content envelope.");
      const texts: string[] = [];
      let bytes = 0;
      for (const block of response.content) {
        if (!block || typeof block !== "object")
          return failure("claude_invalid_output", "Claude returned an invalid content block.");
        if (block.type === "thinking" || block.type === "redacted_thinking") continue;
        if (block.type !== "text" || typeof block.text !== "string")
          return failure("claude_invalid_output", "Claude returned unsupported non-text content.");
        bytes += Buffer.byteLength(block.text);
        if (bytes > 256 * 1024)
          return failure("claude_invalid_output", "Claude output exceeds 256 KiB.");
        texts.push(block.text);
      }
      let parsed: AgentResult;
      try {
        parsed = parseOutput(role, texts.join(""), input.artifacts ?? []);
      } catch {
        return failure(
          "claude_invalid_output",
          "Claude response did not match the requested role schema and evidence constraints.",
        );
      }
      if (!isJsonValue(parsed))
        return failure("claude_invalid_output", "Claude normalization produced non-JSON data.");
      const safe = redactor.json(parsed);
      if (
        !safe ||
        typeof safe !== "object" ||
        Array.isArray(safe) ||
        safe.status !== parsed.status ||
        safe.outcome !== parsed.outcome
      )
        return failure(
          "claude_invalid_output",
          "Credential values must not overlap workflow status or outcome identifiers.",
        );
      return finish(safe as unknown as AgentResult);
    } catch (error) {
      if (!options.signal?.aborted && deadline.timedOut())
        return failure("claude_timeout", "Claude request timed out.", true);
      if (options.signal?.aborted || error instanceof Anthropic.APIUserAbortError)
        return failure("claude_cancelled", "Claude request was cancelled.");
      if (error instanceof Anthropic.APIConnectionTimeoutError)
        return failure("claude_timeout", "Claude request timed out.", true);
      if (error instanceof Anthropic.AuthenticationError)
        return failure(
          "claude_authentication_failed",
          "Claude rejected the configured API credential.",
        );
      if (error instanceof Anthropic.PermissionDeniedError)
        return failure(
          "claude_permission_denied",
          "Claude denied access; check account and model permissions.",
        );
      if (error instanceof Anthropic.RateLimitError)
        return failure("claude_rate_limited", "Claude rate or quota limit was reached.", true);
      if (error instanceof Anthropic.BadRequestError)
        return failure(
          "claude_invalid_request",
          "Claude rejected the request; check model and structured-output support.",
        );
      if (error instanceof Anthropic.APIConnectionError)
        return failure("claude_connection_failed", "Could not connect to Claude.", true);
      return failure(
        "claude_request_failed",
        "Claude request failed.",
        error instanceof Anthropic.APIError && (error.status ?? 0) >= 500,
      );
    } finally {
      deadline.dispose();
    }
  }
}

function normalizeUsage(value: Message["usage"]): UsageMetadata | undefined {
  if (!value) return undefined;
  const valid = (count: unknown): count is number =>
    typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
  const usage: UsageMetadata = {};
  const inputs = [
    value.input_tokens,
    value.cache_creation_input_tokens,
    value.cache_read_input_tokens,
  ];
  if (inputs.every(valid)) {
    const sum = inputs.reduce((total, count) => total + count, 0);
    if (valid(sum)) usage.inputTokens = sum;
  }
  if (valid(value.output_tokens)) usage.outputTokens = value.output_tokens;
  if (valid(value.cache_read_input_tokens)) usage.cachedInputTokens = value.cache_read_input_tokens;
  const reasoning = value.output_tokens_details?.thinking_tokens;
  if (valid(reasoning) && valid(usage.outputTokens) && reasoning <= usage.outputTokens)
    usage.reasoningTokens = reasoning;
  if (
    valid(usage.inputTokens) &&
    valid(usage.outputTokens) &&
    valid(usage.inputTokens + usage.outputTokens)
  )
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  return Object.keys(usage).length ? usage : undefined;
}
