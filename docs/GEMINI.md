# Gemini API adapter

`@veyra/gemini` implements planner and reviewer roles using the Gemini Developer API's `models.generateContent` endpoint and Node.js's built-in `fetch`. It adds no third-party runtime dependency. Core remains provider-neutral; the CLI registers `gemini` through the [SDK plugin contract](PLUGINS.md). The separate [Gemini CLI executor](GEMINI-CLI.md) shares this package under provider `gemini-cli`.

```yaml
agents:
  planner:
    provider: gemini
    model: gemini-2.5-flash
    options:
      role: planner
      timeoutMs: 120000
      maxOutputTokens: 8192
      # vision: true
  reviewer:
    provider: gemini
    model: gemini-2.5-flash
    options:
      role: reviewer
```

Set `GEMINI_API_KEY` in the environment, or configure `options.apiKeyEnv` to name another existing environment variable. A complete [development configuration](../examples/providers/gemini.yaml) uses Gemini reasoning with the Codex executor. No key belongs in YAML. `describe()` advertises reasoning and structured-output, plus vision only when explicitly enabled for a supported model. `checkReadiness()` and `ve doctor` inspect only credential presence; they do not validate credentials, model access or remote availability.

## Request and result contracts

The adapter makes one HTTPS POST to `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`. Authentication uses `x-goog-api-key`, outside the URL and task envelope. Redirects are rejected. Native Google CLI login, Vertex credentials, ambient base URLs and other key variables do not select a different service implicitly. Request logging is disabled with `store: false`; no cached context or session is created. The request uses one candidate, a role-specific system instruction, `responseMimeType: application/json` and `responseJsonSchema`. It supplies no tools and leaves provider safety settings at their defaults. The official [generateContent contract](https://ai.google.dev/api/generate-content) defines these fields.

Planner JSON must contain exactly `summary`, `instructions`, a non-empty `acceptanceCriteria` list and `artifactIds`. Reviewer JSON contains exactly `summary`, `outcome` (`pass`/`fail`), `requiredFixes` and `evidenceArtifactIds`. Pass requires no fixes; fail requires at least one concrete fix. Only artifact IDs supplied in the input can be cited. A review's pass/fail outcome remains separate from technical success. All output is validated locally before becoming an `AgentResult`; missing fields, invented evidence, invalid JSON and contradictory review results fail.

A completed response requires one candidate with finish reason `STOP` and valid text parts. Prompt/content refusals become `needs_input`; token limits and other incomplete finishes become failures. Function calls and other non-text output cannot execute anything or satisfy a step. Thought parts and signatures are discarded. HTTP/authentication/model/quota/network failures use stable error codes and safe messages; raw provider error bodies, headers and native exceptions are not persisted. There are no internal retries or silent model/format fallbacks; workflow policy owns retries.

Known configured credential values and bearer strings are masked in task/output text, and credential-shaped fields and environment objects are removed from the task envelope. Unknown secrets are outside this adapter's detection guarantee. No filesystem or URL is read merely because an artifact reference or image-like string appears in context.

## Inline images

Vision is opt-in through `options.vision: true`. Its current allowlist contains these exact model IDs (an optional `models/` prefix is normalized):

- [`gemini-2.5-flash`](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash)
- [`gemini-2.5-pro`](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro)
- [`gemini-2.5-flash-lite`](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite)

Each model's documentation lists image input and structured text output. Unknown model IDs remain usable for the text request path but cannot enable or advertise vision; add a model only after checking its contract and tests. Capability metadata is not proof of account access or live smoke success. No audio, video, PDF, image generation, web research or tool capability is advertised.

Programmatic callers supply images explicitly in the protocol's JSON context:

```ts
const context = {
  images: [{ mimeType: "image/png", data: "<canonical base64 image bytes>" }],
};
```

The adapter accepts at most four PNG, JPEG or WebP images, with only `mimeType` and `data` fields. Each base64 string is capped at 192 KiB and the entire original task, including images, at 256 KiB. It checks canonical encoding and declared MIME type; the provider validates actual image contents. Paths, remote URLs and implicit uploads are rejected. Image bytes become `inlineData` parts, while the text envelope contains only image indices/types, avoiding duplicate base64 in text. Other context and the caller's input are preserved. The CLI has no image-file attachment flag yet; ordinary Veyra state/context limits also apply to programmatic image inputs.

## Limits and accounting

`model` is required and accepts a normal model ID or `models/<id>`. Supported options are `id`, `role`, `apiKeyEnv`, `timeoutMs`, `maxOutputTokens` and `vision`; unknown fields fail. Roles are planner/reviewer, with an optional fixed role overriding the incoming binding role. Default output limit is 8192 tokens (configurable 1–65536); models may impose tighter limits. The default deadline is 120 seconds (1–86400000 ms). Per-run timeout and cancellation use Runtime's shared deadline and cover both the HTTP request and response consumption. Cancelling stops the client operation; it does not guarantee cancellation of server work or billing.

Response bodies are streamed into a 512 KiB bound and cancelled on excess or abort; assembled structured text is capped at 256 KiB. Reader locks and deadline listeners are released. Responses carry Veyra's run/step/attempt/parent identity and wall-clock timing, with no native response/session objects persisted.

Usage preserves reported fields: effective prompt count (already including cached content) becomes `inputTokens`; candidate response count becomes `outputTokens`; cache and thought counts are separate `cachedInputTokens` and `reasoningTokens`. The provider's total includes prompt, thoughts and response candidates; it is not reconstructed from partial counts. Unknown or invalid counts and costs stay absent. There is no price table or invented zero.

## Verification

Default tests use injected HTTP transport and real streamed `Response` bodies. They cover request headers/schema/service selection, role and evidence validation, capability gating/images, cancellation before headers and during a stalled body, response limits, refusals, accounting and safe errors. They require no network or live credentials. The guarded smoke command is excluded from normal tests:

```bash
pnpm --filter @veyra/gemini... build
VEYRA_LIVE_SMOKE=1 pnpm --filter @veyra/gemini smoke -- gemini-2.5-flash
```

Both `VEYRA_LIVE_SMOKE=1` and `GEMINI_API_KEY` are required before any request. The smoke makes a text planner request and a reviewer request that must pass. With an allowlisted vision model it also requests a plan based on a checksum-verified white pixel PNG and checks the observed color. It consumes the configured API account's usage. Current live verification is blocked by the unavailable key; see [M4.5](TODO.md#m45--gemini-api-provider).
