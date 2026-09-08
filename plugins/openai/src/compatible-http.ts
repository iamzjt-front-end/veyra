import type { UsageMetadata } from "@veyra/protocol";

export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A deadline covers response consumption, including a server that stalls after headers. */
export async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error("Missing response body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) {
      cancel();
      throw new Error("Response aborted.");
    }
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error("Response aborted.");
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 512 * 1024) {
        await reader.cancel();
        throw new Error("Response exceeds 512 KiB.");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export function normalizeUsage(value: unknown): UsageMetadata | undefined {
  if (!object(value)) return undefined;
  const usage: UsageMetadata = {};
  for (const [name, count] of [
    ["inputTokens", value.prompt_tokens],
    ["outputTokens", value.completion_tokens],
    ["totalTokens", value.total_tokens],
    [
      "cachedInputTokens",
      object(value.prompt_tokens_details) ? value.prompt_tokens_details.cached_tokens : undefined,
    ],
    [
      "reasoningTokens",
      object(value.completion_tokens_details)
        ? value.completion_tokens_details.reasoning_tokens
        : undefined,
    ],
  ] as const) {
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) usage[name] = count;
  }
  return Object.keys(usage).length ? usage : undefined;
}

export function httpFailure(status: number): [string, string, boolean] {
  if (status === 401 || status === 403)
    return [
      "authentication_failed",
      "The compatible server rejected authentication or access; set apiKeyEnv to a valid credential variable and check model permissions.",
      false,
    ];
  if (status === 404)
    return [
      "not_found",
      "The compatible endpoint or model was not found; check baseURL (including its API prefix), start the server and load the configured model.",
      false,
    ];
  if (status === 400 || status === 422)
    return [
      "invalid_request",
      "The compatible server rejected the request; check the model, token limit and responseFormat support. Choose json_schema, json_object or text explicitly; no automatic fallback was attempted.",
      false,
    ];
  if (status === 429)
    return [
      "rate_limited",
      "The compatible server reached a rate, quota or capacity limit; check capacity before retrying.",
      true,
    ];
  if (status >= 500)
    return [
      "server_failed",
      "The compatible server failed; check its logs, model loading and available memory before retrying.",
      true,
    ];
  return [
    "http_failed",
    `The compatible server returned HTTP ${status}; check its Chat Completions endpoint configuration.`,
    false,
  ];
}
