# OpenAI planner and reviewer

`@veyra/openai` implements `AgentAdapter` with the official OpenAI SDK and the Responses API. The SDK is pinned to 6.49.0 to retain the repository's Node 20 minimum; SDK 7.x requires Node 22. Models remain caller-configurable. Use a model with Responses and strict JSON Schema output support; unsupported requests fail explicitly.

```ts
import { OpenAIAdapter } from "@veyra/openai";

const planner = new OpenAIAdapter({ model: "your-model", role: "planner" });
const result = await planner.run({
  runId: "run-1",
  stepId: "plan",
  role: "planner",
  goal: "Fix the failing fixture test",
});
```

## Configuration and execution

Options are `model` (required), optional `id`, `role` (`planner` or `reviewer`), `apiKeyEnv`, `timeoutMs`, and `maxOutputTokens`. By default the role comes from `AgentInput.role`; set a fixed role when an agent has another configured name. The default credential variable is `OPENAI_API_KEY`; `apiKeyEnv` names an alternative environment variable and never contains the key itself.

The adapter uses the official API endpoint. It does not inherit `OPENAI_BASE_URL`; OpenAI-compatible provider support is separate roadmap work. Requests use `store: false`, disable SDK logging and automatic retries, and default to a 120-second timeout and 8192 output tokens. The ephemeral `AgentRunOptions` signal and timeout override are forwarded to the SDK. Input and returned text are each capped at 256 KiB. Include relevant excerpts and artifact references; this adapter does not read artifact files or execute tools.

The developer message defines the role and output contract. Goal, instructions, previous context, and artifact references remain in a separate user JSON message. Prior model output cannot redefine that developer contract. The request uses strict `text.format` JSON Schema, then validates returned JSON again, including known artifact references and consistent review outcomes. See the official [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs) and [Responses reference](https://developers.openai.com/api/reference/typescript/resources/responses/methods/create).

## Normalized results

A planner returns `status: success`, a summary, `data.instructions`, non-empty `data.acceptanceCriteria`, and referenced input artifacts when applicable. A reviewer returns `status: success` with a distinct workflow `outcome: pass | fail`, summary, `data.requiredFixes`, and `data.evidenceArtifactIds`. A failed review must name at least one fix; a pass must have none. Referenced artifacts must already exist in the input. A reviewer `fail` is a completed review, not an API execution failure.

Every result carries execution identity and timing. Available input/output/total/cached/reasoning token counts are normalized; unknown usage and cost are omitted. Refusals return `needs_input`. Incomplete responses, invalid JSON, invalid schemas, unsupported roles, missing credentials, cancellation, timeout, and API failures return safe structured errors. Raw SDK messages, response bodies, and stack traces are not logged or returned. Known API-key text and credential-shaped input/output fields are redacted.

Core still receives adapters by injection. This implementation does not instantiate providers inside Core or advance the orchestration TODO.

## Verification

Normal tests inject a client or mock the SDK's HTTP transport and never require credentials. The optional live smoke makes two small API requests, planning and reviewing a supplied spelling correction, with no filesystem edits:

```bash
# Set OPENAI_API_KEY in your shell without putting it in a tracked file.
pnpm --filter @veyra/openai smoke -- <model>
```

The command requires an explicit model and key, and exits nonzero on a missing credential or unsuccessful planner/reviewer result. It is excluded from `pnpm test` and CI. Live access depends on the account and selected model; mocked test results do not establish live provider availability.
