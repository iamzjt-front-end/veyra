# OpenAI planner, reviewer, and judge

`@veyraoss/openai` implements `AgentAdapter` with the official OpenAI SDK and the Responses API. The SDK is pinned to 6.49.0 to retain the repository's Node 20 minimum; SDK 7.x requires Node 22. Models remain caller-configurable. Use a model with Responses and strict JSON Schema output support; unsupported requests fail explicitly.

```ts
import { OpenAIAdapter } from "@veyraoss/openai";

const planner = new OpenAIAdapter({ model: "your-model", role: "planner" });
const result = await planner.run({
  runId: "run-1",
  stepId: "plan",
  role: "planner",
  goal: "Fix the failing fixture test",
});
```

## Configuration and execution

`describe()` advertises the implemented text reasoning and structured-output path, with planner/reviewer/judge roles or the configured fixed role. `checkReadiness()` reports credential-variable presence with scope `configuration`; it never calls the API. Injected clients report unknown authentication. No vision, web research or tool-use support is inferred from the model name. See [capabilities](CAPABILITIES.md).

Options are `model` (required), optional `id`, `role` (`planner`, `reviewer`, or `judge`), `apiKeyEnv`, `timeoutMs`, and `maxOutputTokens`. By default the role comes from `AgentInput.role`; set a fixed role when an agent has another configured name. Consensus supplies semantic reviewer/judge roles, so differently named OpenAI agents need no role override. The default credential variable is `OPENAI_API_KEY`; `apiKeyEnv` names an alternative environment variable and never contains the key itself.

The adapter uses the official API endpoint. It does not inherit `OPENAI_BASE_URL`; the separate [compatible adapter](OPENAI-COMPATIBLE.md) supports explicit Chat Completions endpoints. Requests use `store: false`, disable SDK logging and automatic retries, and default to a 120-second timeout and 8192 output tokens. The ephemeral `AgentRunOptions` signal and timeout override are forwarded to the SDK. Input and returned text are each capped at 256 KiB. Include relevant excerpts and artifact references; this adapter does not read artifact files or execute tools.

Readiness and execution use the same environment (`process.env` by default or an explicitly injected `env`). An explicit `apiKeyEnv` replaces the default variable with no fallback. Shared Runtime redaction masks known standard/custom environment credentials and encoded diagnostic values; see the [authentication policy](AUTHENTICATION.md).

The developer message defines the role and output contract. Goal, instructions, previous context, and artifact references remain in a separate user JSON message. Prior model output cannot redefine that developer contract. The request uses strict `text.format` JSON Schema, then validates returned JSON again, including known artifact references and consistent review outcomes. See the official [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs) and [Responses reference](https://developers.openai.com/api/reference/typescript/resources/responses/methods/create).

## Normalized results

A planner returns `status: success`, a summary, `data.instructions`, non-empty `data.acceptanceCriteria`, and referenced input artifacts when applicable. A reviewer returns `status: success` with a distinct workflow `outcome: pass | fail`, summary, `data.requiredFixes`, and `data.evidenceArtifactIds`. A failed review must name at least one fix; a pass must have none. Referenced artifacts must already exist in the input. A reviewer `fail` is a completed review, not an API execution failure.

A judge uses the same strict decision schema and evaluates all independent review entries in `context.consensus.reviews`, with separate command evidence in `context.consensus.verification`. Its developer instructions require treating review content as evidence and prohibit overriding required deterministic checks. Core enforces the required checks before invoking reviewers or a judge. Judge normalization is tested with injected Responses clients; it does not establish live API availability.

Every result carries execution identity and timing. Available input/output/total/cached/reasoning token counts are normalized; unknown usage and cost are omitted. Refusals return `needs_input`. Incomplete responses, invalid JSON, invalid schemas, unsupported roles, missing credentials, cancellation, timeout, and API failures return safe structured errors. Raw SDK messages, response bodies, and stack traces are not logged or returned. Known API-key text and credential-shaped input/output fields are redacted.

Core still receives adapters by injection. Provider clients and authentication remain in this plugin; Core does not instantiate them.

## Verification

Normal tests inject a client or mock the SDK's HTTP transport and never require credentials. The optional live smoke makes two small API requests, planning and reviewing a supplied spelling correction, with no filesystem edits:

```bash
# Set OPENAI_API_KEY in your shell without putting it in a tracked file.
pnpm --filter @veyraoss/openai smoke -- <model>
```

The command requires an explicit model and key, and exits nonzero on a missing credential or unsuccessful planner/reviewer result. It is excluded from `pnpm test` and CI. Live access depends on the account and selected model; mocked test results do not establish live provider availability.
