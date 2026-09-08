import {
  type AgentAdapter,
  type AgentDescriptor,
  type AgentInput,
  type AgentReadiness,
  type AgentResult,
  type AgentRunOptions,
  type UsageMetadata,
  isJsonValue,
} from "@veyraoss/protocol";
import { createDeadline, createSecretRedactor } from "@veyraoss/runtime";
import { requestParts, visionModels } from "./input.js";
import { readJson } from "./http.js";
export { GeminiCliAdapter, type GeminiCliAdapterOptions } from "./cli.js";
import {
  type GeminiRole,
  normalizeUsage,
  object,
  outputSchema,
  parseOutput,
  roleInstructions,
} from "./output.js";

export interface GeminiAdapterOptions {
  model: string;
  id?: string;
  role?: GeminiRole;
  apiKeyEnv?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  /** Enable only the implemented inline-image path for documented exact model IDs. */
  vision?: boolean;
}
const validTimeout = (value: number) =>
  Number.isSafeInteger(value) && value >= 1 && value <= 86_400_000;

export class GeminiAdapter implements AgentAdapter {
  readonly id: string;
  readonly provider = "gemini";
  readonly #options: Readonly<GeminiAdapterOptions>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #env: Readonly<NodeJS.ProcessEnv>;

  constructor(
    options: GeminiAdapterOptions,
    dependencies: { fetch?: typeof globalThis.fetch; env?: Readonly<NodeJS.ProcessEnv> } = {},
  ) {
    if (
      options === null ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      !isJsonValue(options as unknown) ||
      Object.keys(options).some(
        (key) =>
          !["model", "id", "role", "apiKeyEnv", "timeoutMs", "maxOutputTokens", "vision"].includes(
            key,
          ),
      )
    )
      throw new Error("Gemini options must contain only supported plain JSON fields.");
    if (
      typeof options.model !== "string" ||
      !/^(?:models\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.model)
    )
      throw new Error(
        "Gemini model must be a model ID (optionally prefixed with models/); URLs and Vertex resource paths are not supported.",
      );
    if (
      options.id !== undefined &&
      (typeof options.id !== "string" || !options.id.trim() || options.id.length > 128)
    )
      throw new Error("Gemini id must be non-empty text of at most 128 characters.");
    if (options.role !== undefined && options.role !== "planner" && options.role !== "reviewer")
      throw new Error("Gemini role must be planner or reviewer.");
    if (
      options.apiKeyEnv !== undefined &&
      (typeof options.apiKeyEnv !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(options.apiKeyEnv))
    )
      throw new Error(
        "Gemini apiKeyEnv must be an environment variable name of at most 128 characters.",
      );
    if (options.timeoutMs !== undefined && !validTimeout(options.timeoutMs))
      throw new Error("Gemini timeoutMs must be an integer from 1 through 86400000.");
    if (
      options.maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(options.maxOutputTokens) ||
        options.maxOutputTokens <= 0 ||
        options.maxOutputTokens > 65536)
    )
      throw new Error("Gemini maxOutputTokens must be an integer from 1 through 65536.");
    if (options.vision !== undefined && typeof options.vision !== "boolean")
      throw new Error("Gemini vision must be a boolean.");
    const model = options.model.replace(/^models\//, "");
    if (options.vision && !visionModels.includes(model))
      throw new Error(
        "Gemini vision is implemented only for documented gemini-2.5-flash, gemini-2.5-pro and gemini-2.5-flash-lite models; leave vision disabled for other models.",
      );
    this.id = options.id ?? "gemini";
    this.#options = Object.freeze({ ...options, model });
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#env = dependencies.env ?? process.env;
  }

  describe(): AgentDescriptor {
    return {
      schemaVersion: 1,
      id: this.id,
      provider: this.provider,
      adapterVersion: "0.1.0",
      model: this.#options.model,
      roles: this.#options.role ? [this.#options.role] : ["planner", "reviewer"],
      capabilities: ["reasoning", "structured-output", ...(this.#options.vision ? ["vision"] : [])],
    };
  }
  async checkReadiness(controls: AgentRunOptions = {}): Promise<AgentReadiness> {
    if (controls.signal?.aborted)
      return {
        status: "unknown",
        scope: "configuration",
        message: "Gemini readiness check was cancelled.",
      };
    const keyName = this.#options.apiKeyEnv ?? "GEMINI_API_KEY";
    const present = Boolean(this.#env[keyName]?.trim());
    return {
      status: present ? "ready" : "unavailable",
      scope: "configuration",
      message: present
        ? `${keyName} is present; API/model access was not tested.`
        : `Set ${keyName} before using the Gemini adapter.`,
    };
  }

  async run(input: AgentInput, controls: AgentRunOptions = {}): Promise<AgentResult> {
    const startedAt = new Date().toISOString();
    const start = performance.now();
    let usage: UsageMetadata | undefined;
    const finish = (result: AgentResult): AgentResult => ({
      ...result,
      execution: {
        runId: input.runId,
        stepId: input.stepId,
        ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
        ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
        ...(input.parentStepId !== undefined ? { parentStepId: input.parentStepId } : {}),
      },
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
    if (role !== "planner" && role !== "reviewer")
      return failure("gemini_unsupported_role", "Gemini supports planner and reviewer roles.");
    if (!isJsonValue(input) || typeof input.goal !== "string" || !input.goal.trim())
      return failure(
        "gemini_invalid_input",
        "Gemini input must contain a goal and plain JSON data.",
      );
    if (controls.signal?.aborted)
      return failure("gemini_cancelled", "Gemini request was cancelled.");
    const timeoutMs = controls.timeoutMs ?? this.#options.timeoutMs ?? 120000;
    if (!validTimeout(timeoutMs))
      return failure(
        "gemini_invalid_timeout",
        "Gemini timeout must be an integer from 1 through 86400000 milliseconds.",
      );
    const keyName = this.#options.apiKeyEnv ?? "GEMINI_API_KEY";
    const apiKey = this.#env[keyName];
    const redactor = createSecretRedactor({ env: this.#env, values: apiKey ? [apiKey] : [] });
    if (!apiKey?.trim())
      return failure("gemini_missing_api_key", `Set ${keyName} before using the Gemini adapter.`);
    if (Buffer.byteLength(JSON.stringify(input)) > 256 * 1024)
      return failure(
        "gemini_input_too_large",
        "Gemini input exceeds 256 KiB including inline image data; supply relevant excerpts.",
      );
    let parts: ReturnType<typeof requestParts>;
    try {
      parts = requestParts(input, this.#options.vision === true, redactor);
    } catch {
      return failure(
        "gemini_invalid_images",
        "context.images requires enabled vision and up to four PNG/JPEG/WebP inline images with canonical base64 data; paths and URLs are unsupported.",
      );
    }
    const deadline = createDeadline(timeoutMs, controls.signal);
    try {
      const response = await this.#fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.#options.model)}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          redirect: "error",
          signal: deadline.signal,
          body: JSON.stringify({
            contents: [{ role: "user", parts }],
            systemInstruction: { parts: [{ text: roleInstructions(role) }] },
            generationConfig: {
              candidateCount: 1,
              maxOutputTokens: this.#options.maxOutputTokens ?? 8192,
              responseMimeType: "application/json",
              responseJsonSchema: outputSchema(role),
            },
            store: false,
          }),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        const [code, message, retryable] = httpFailure(response.status);
        return failure(code, message, retryable);
      }
      let value: unknown;
      try {
        value = await readJson(response, deadline.signal);
      } catch (error) {
        if (deadline.signal.aborted) throw error;
        return failure(
          "gemini_invalid_output",
          "Gemini returned invalid JSON or a response larger than 512 KiB.",
        );
      }
      if (controls.signal?.aborted)
        return failure("gemini_cancelled", "Gemini request was cancelled.");
      if (deadline.timedOut()) return failure("gemini_timeout", "Gemini request timed out.", true);
      if (!object(value))
        return failure("gemini_invalid_output", "Gemini returned an invalid response envelope.");
      usage = normalizeUsage(value.usageMetadata);
      if (
        object(value.promptFeedback) &&
        value.promptFeedback.blockReason &&
        value.promptFeedback.blockReason !== "BLOCK_REASON_UNSPECIFIED"
      )
        return failure(
          "gemini_blocked",
          "Gemini declined the supplied prompt; revise it before continuing.",
          false,
          "needs_input",
        );
      if (
        !Array.isArray(value.candidates) ||
        value.candidates.length !== 1 ||
        !object(value.candidates[0])
      )
        return failure("gemini_invalid_output", "Gemini did not return exactly one candidate.");
      const candidate = value.candidates[0];
      if (
        [
          "SAFETY",
          "RECITATION",
          "BLOCKLIST",
          "PROHIBITED_CONTENT",
          "SPII",
          "IMAGE_SAFETY",
        ].includes(typeof candidate.finishReason === "string" ? candidate.finishReason : "")
      )
        return failure(
          "gemini_blocked",
          "Gemini declined the response; revise the request before continuing.",
          false,
          "needs_input",
        );
      if (candidate.finishReason !== "STOP")
        return failure(
          "gemini_incomplete",
          "Gemini did not complete its response; check output limits and supplied context.",
        );
      if (
        !object(candidate.content) ||
        !Array.isArray(candidate.content.parts) ||
        candidate.content.parts.length > 64
      )
        return failure("gemini_invalid_output", "Gemini returned an invalid content envelope.");
      let output = "";
      for (const part of candidate.content.parts) {
        if (!object(part))
          return failure("gemini_invalid_output", "Gemini returned an invalid content part.");
        if (part.thought === true) continue;
        if (
          (part.thought !== undefined && typeof part.thought !== "boolean") ||
          typeof part.text !== "string" ||
          Object.keys(part).some((key) => !["text", "thought", "thoughtSignature"].includes(key))
        )
          return failure(
            "gemini_invalid_output",
            "Gemini returned unsupported non-text output; this adapter does not execute tools.",
          );
        output += part.text;
        if (Buffer.byteLength(output) > 256 * 1024)
          return failure("gemini_invalid_output", "Gemini structured output exceeds 256 KiB.");
      }
      let parsed: AgentResult;
      try {
        parsed = parseOutput(role, output, input.artifacts ?? []);
      } catch {
        return failure(
          "gemini_invalid_output",
          "Gemini result did not match the role schema and supplied evidence constraints.",
        );
      }
      if (!isJsonValue(parsed))
        return failure("gemini_invalid_output", "Gemini normalization produced non-JSON output.");
      const safe = redactor.json(parsed);
      if (!object(safe) || safe.status !== parsed.status || safe.outcome !== parsed.outcome)
        return failure(
          "gemini_invalid_output",
          "Credential values must not overlap workflow status or outcome identifiers.",
        );
      return finish(safe as unknown as AgentResult);
    } catch {
      if (controls.signal?.aborted)
        return failure("gemini_cancelled", "Gemini request was cancelled.");
      if (deadline.timedOut()) return failure("gemini_timeout", "Gemini request timed out.", true);
      return failure(
        "gemini_connection_failed",
        "Gemini request could not complete; check network access to the Gemini API.",
        true,
      );
    } finally {
      deadline.dispose();
    }
  }
}

function httpFailure(status: number): [string, string, boolean] {
  if (status === 401)
    return [
      "gemini_authentication_failed",
      "Gemini rejected authentication; check the configured API key.",
      false,
    ];
  if (status === 403)
    return [
      "gemini_permission_denied",
      "Gemini denied access; check API key permissions, API enablement and model access.",
      false,
    ];
  if (status === 404)
    return [
      "gemini_model_not_found",
      "Gemini model was not found; select an accessible generateContent model.",
      false,
    ];
  if (status === 400 || status === 422)
    return [
      "gemini_invalid_request",
      "Gemini rejected the request; check the API key, model and structured-output configuration.",
      false,
    ];
  if (status === 429)
    return ["gemini_rate_limited", "Gemini rate limit or quota was exceeded.", true];
  return ["gemini_request_failed", "Gemini API request failed.", status === 408 || status >= 500];
}
