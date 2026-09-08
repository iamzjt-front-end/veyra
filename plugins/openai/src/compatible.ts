import { ADAPTER_VERSION } from "./version.js";
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
import { httpFailure, normalizeUsage, object, readJson } from "./compatible-http.js";
import { outputFormat, parseOutput, roleInstructions } from "./output.js";

export interface OpenAICompatibleAdapterOptions {
  model: string;
  /** API prefix, for example http://127.0.0.1:11434/v1; never an implicit OpenAI URL. */
  baseURL: string;
  id?: string;
  role?: "planner" | "reviewer" | "judge";
  /** Omit for unauthenticated local servers. No ambient credential is selected by default. */
  apiKeyEnv?: string;
  /** Explicit server support; text sends no response_format. All modes validate JSON locally. */
  responseFormat?: "json_schema" | "json_object" | "text";
  timeoutMs?: number;
  maxOutputTokens?: number;
}

const validTimeout = (value: number) =>
  Number.isSafeInteger(value) && value >= 1 && value <= 86_400_000;
const validText = (value: unknown, max: number) =>
  typeof value === "string" &&
  value.trim() === value &&
  value.length > 0 &&
  value.length <= max &&
  ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

function endpoint(baseURL: unknown): string {
  const message =
    "Compatible baseURL must be an explicit HTTPS API prefix, or HTTP on localhost/127.0.0.0/8/[::1], without credentials, query or fragment.";
  if (!validText(baseURL, 4096) || typeof baseURL !== "string" || /[\s\\]/.test(baseURL))
    throw new Error(message);
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new Error(message);
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    baseURL.includes("?") ||
    baseURL.includes("#")
  )
    throw new Error(message);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error(message);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`;
  return url.href;
}

/** Explicit Chat Completions compatibility, separate from the official Responses adapter. */
export class OpenAICompatibleAdapter implements AgentAdapter {
  readonly id: string;
  readonly provider = "openai-compatible";
  readonly #options: Readonly<OpenAICompatibleAdapterOptions>;
  readonly #endpoint: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #env: Readonly<NodeJS.ProcessEnv>;

  constructor(
    options: OpenAICompatibleAdapterOptions,
    dependencies: { fetch?: typeof globalThis.fetch; env?: Readonly<NodeJS.ProcessEnv> } = {},
  ) {
    if (
      !object(options) ||
      !isJsonValue(options as unknown) ||
      Object.keys(options).some(
        (key) =>
          ![
            "model",
            "baseURL",
            "id",
            "role",
            "apiKeyEnv",
            "responseFormat",
            "timeoutMs",
            "maxOutputTokens",
          ].includes(key),
      )
    )
      throw new Error(
        "Compatible options must contain only supported plain JSON fields; use apiKeyEnv for credentials.",
      );
    if (!validText(options.model, 512))
      throw new Error("Compatible model must be non-empty text of at most 512 characters.");
    if (options.id !== undefined && !validText(options.id, 128))
      throw new Error("Compatible id must be non-empty text of at most 128 characters.");
    if (options.role !== undefined && !["planner", "reviewer", "judge"].includes(options.role))
      throw new Error("Compatible role must be planner, reviewer or judge.");
    if (
      options.apiKeyEnv !== undefined &&
      (typeof options.apiKeyEnv !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(options.apiKeyEnv))
    )
      throw new Error(
        "Compatible apiKeyEnv must name an environment variable of at most 128 characters.",
      );
    if (
      options.responseFormat !== undefined &&
      !["json_schema", "json_object", "text"].includes(options.responseFormat)
    )
      throw new Error("Compatible responseFormat must be json_schema, json_object or text.");
    if (options.timeoutMs !== undefined && !validTimeout(options.timeoutMs))
      throw new Error("Compatible timeoutMs must be an integer from 1 through 86400000.");
    if (
      options.maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(options.maxOutputTokens) ||
        options.maxOutputTokens < 1 ||
        options.maxOutputTokens > 65536)
    )
      throw new Error("Compatible maxOutputTokens must be an integer from 1 through 65536.");
    this.#endpoint = endpoint(options.baseURL);
    this.#options = Object.freeze({ ...options });
    this.id = options.id ?? "openai-compatible";
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#env = dependencies.env ?? process.env;
  }

  describe(): AgentDescriptor {
    return {
      schemaVersion: 1,
      id: this.id,
      provider: this.provider,
      adapterVersion: ADAPTER_VERSION,
      model: this.#options.model,
      roles: this.#options.role ? [this.#options.role] : ["planner", "reviewer", "judge"],
      capabilities: [
        "reasoning",
        ...(this.#options.responseFormat === "json_schema" ? ["structured-output"] : []),
      ],
    };
  }

  async checkReadiness(controls: AgentRunOptions = {}): Promise<AgentReadiness> {
    if (controls.signal?.aborted)
      return {
        status: "unknown",
        scope: "configuration",
        message: "Compatible readiness check was cancelled.",
      };
    const keyName = this.#options.apiKeyEnv;
    const present = !keyName || Boolean(this.#env[keyName]?.trim());
    return {
      status: present ? "ready" : "unavailable",
      scope: "configuration",
      message: !present
        ? `Set ${keyName} before using the compatible adapter.`
        : `${keyName ? `${keyName} is present` : "Endpoint configured without authentication"}; server availability, model access and output-format support were not tested.`,
    };
  }

  async run(input: AgentInput, controls: AgentRunOptions = {}): Promise<AgentResult> {
    const start = performance.now();
    const startedAt = new Date().toISOString();
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
    ) =>
      finish({
        status,
        summary: message,
        error: { code: `compatible_${code}`, message, retryable },
      });
    const role: string = this.#options.role ?? input.role;
    if (role !== "planner" && role !== "reviewer" && role !== "judge")
      return failure(
        "unsupported_role",
        "Compatible adapter supports planner, reviewer and judge roles.",
      );
    if (!isJsonValue(input) || typeof input.goal !== "string" || !input.goal.trim())
      return failure("invalid_input", "Compatible input must contain a goal and plain JSON data.");
    if (controls.signal?.aborted) return failure("cancelled", "Compatible request was cancelled.");
    const timeoutMs = controls.timeoutMs ?? this.#options.timeoutMs ?? 120000;
    if (!validTimeout(timeoutMs))
      return failure(
        "invalid_timeout",
        "Compatible timeout must be an integer from 1 through 86400000 milliseconds.",
      );
    const keyName = this.#options.apiKeyEnv;
    const apiKey = keyName ? this.#env[keyName] : undefined;
    const redactor = createSecretRedactor({ env: this.#env, values: apiKey ? [apiKey] : [] });
    if (keyName && !apiKey?.trim())
      return failure("missing_api_key", `Set ${keyName} before using the compatible adapter.`);
    if (apiKey && !/^[\x21-\x7e]+$/.test(apiKey))
      return failure(
        "invalid_api_key",
        "The configured credential must contain printable ASCII without whitespace; check its environment variable.",
      );
    if (Buffer.byteLength(JSON.stringify(input)) > 256 * 1024)
      return failure(
        "input_too_large",
        "Compatible input exceeds 256 KiB; supply relevant excerpts and artifact references.",
      );
    const format = outputFormat(role);
    const mode = this.#options.responseFormat ?? "text";
    const deadline = createDeadline(timeoutMs, controls.signal);
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: "POST",
        redirect: "error",
        signal: deadline.signal,
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.#options.model,
          stream: false,
          max_tokens: this.#options.maxOutputTokens ?? 8192,
          messages: [
            {
              role: "system",
              content: `${roleInstructions(role)} Return exactly this JSON Schema, without Markdown or extra text: ${JSON.stringify(format.schema)}`,
            },
            { role: "user", content: JSON.stringify(redactor.json(input)) },
          ],
          ...(mode === "text"
            ? {}
            : {
                response_format:
                  mode === "json_object"
                    ? { type: "json_object" }
                    : {
                        type: "json_schema",
                        json_schema: { name: format.name, strict: true, schema: format.schema },
                      },
              }),
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const [code, message, retryable] = httpFailure(response.status);
        return failure(
          code,
          message,
          retryable,
          response.status === 401 || response.status === 403 ? "needs_input" : "failure",
        );
      }
      let value: unknown;
      try {
        value = await readJson(response, deadline.signal);
      } catch (error) {
        if (deadline.signal.aborted) throw error;
        return failure(
          "invalid_output",
          "Compatible server returned invalid JSON or a body exceeding 512 KiB; check its Chat Completions implementation.",
        );
      }
      if (controls.signal?.aborted)
        return failure("cancelled", "Compatible request was cancelled.");
      if (deadline.timedOut())
        return failure(
          "timeout",
          "Compatible request timed out; check server/model loading or increase timeoutMs.",
          true,
        );
      if (
        !object(value) ||
        value.error ||
        !Array.isArray(value.choices) ||
        value.choices.length !== 1 ||
        !object(value.choices[0])
      )
        return failure(
          "invalid_output",
          "Compatible server must return exactly one Chat Completions choice without an error.",
        );
      usage = normalizeUsage(value.usage);
      const choice = value.choices[0];
      const message = choice.message;
      if (
        choice.finish_reason === "content_filter" ||
        (object(message) &&
          message.refusal !== undefined &&
          message.refusal !== null &&
          message.refusal !== "")
      )
        return failure(
          "refusal",
          "Compatible model declined the request; revise it before continuing.",
          false,
          "needs_input",
        );
      if (choice.finish_reason !== "stop")
        return failure(
          "incomplete",
          "Compatible model did not finish normally; check output-token limits, context length and server finish_reason support. Tools are not executed.",
        );
      if (
        !object(message) ||
        message.role !== "assistant" ||
        typeof message.content !== "string" ||
        Buffer.byteLength(message.content) > 256 * 1024 ||
        (message.tool_calls != null &&
          (!Array.isArray(message.tool_calls) || message.tool_calls.length > 0)) ||
        message.function_call != null
      )
        return failure(
          "invalid_output",
          "Compatible output must be assistant text of at most 256 KiB without tool/function calls.",
        );
      let parsed: AgentResult;
      try {
        parsed = parseOutput(role, message.content, input.artifacts ?? []);
      } catch {
        return failure(
          "invalid_output",
          "Compatible result did not match the role JSON schema or supplied artifact evidence. Use a capable model and an explicitly supported responseFormat; no fallback was attempted.",
        );
      }
      if (!isJsonValue(parsed))
        return failure("invalid_output", "Compatible normalization produced non-JSON data.");
      const safe = redactor.json(parsed);
      if (!object(safe) || safe.status !== parsed.status || safe.outcome !== parsed.outcome)
        return failure(
          "invalid_output",
          "Credential values must not overlap workflow status or outcome identifiers.",
        );
      return finish(safe as unknown as AgentResult);
    } catch {
      if (controls.signal?.aborted)
        return failure("cancelled", "Compatible request was cancelled.");
      if (deadline.timedOut())
        return failure(
          "timeout",
          "Compatible request timed out; check server/model loading or increase timeoutMs.",
          true,
        );
      return failure(
        "connection_failed",
        "Could not reach the compatible server; start it, verify baseURL and model loading, and check TLS. Redirects are refused; configure the final endpoint directly.",
        true,
      );
    } finally {
      deadline.dispose();
    }
  }
}
