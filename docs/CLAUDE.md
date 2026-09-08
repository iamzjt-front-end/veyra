# Claude API reasoning adapter

`@veyra/claude` implements planner, reviewer and judge roles through Anthropic's Messages API. The CLI registers it as built-in provider `claude`. Implementation and mocked transport tests are available; live smoke verification is blocked by the absent `ANTHROPIC_API_KEY`.

The adapter pins the official [`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript) at `0.124.0`. It requests JSON Schema through `output_config.format`, following the [structured-output API](https://platform.claude.com/docs/en/build-with-claude/structured-outputs). Configure a model supporting this feature; unsupported requests fail explicitly without fallback to unconstrained text.

```ts
import { ClaudeAdapter } from "@veyra/claude";

const planner = new ClaudeAdapter({ model: "your-claude-model", role: "planner" });
const result = await planner.run({
  runId: "example-run",
  stepId: "plan",
  role: "planner",
  goal: "Plan a fix using the supplied failing-test evidence",
});
```

## Configuration and controls

Options are required `model`, optional `id`, fixed `role` (`planner`, `reviewer`, `judge`), `apiKeyEnv`, `timeoutMs`, and `maxOutputTokens`. Unknown options are rejected. A fixed role supports custom binding names; otherwise `AgentInput.role` supplies it. Model and ID limits are 512 and 128 characters respectively.

`ANTHROPIC_API_KEY` is the default credential variable; `apiKeyEnv` names an alternative variable, never its value. The adapter pins `https://api.anthropic.com` and key authentication, disables SDK request logging/retries, and does not inherit ambient base URLs, bearer tokens or authentication profiles. It does not read Claude Code login state or execute commands. Clients/environments can be injected programmatically for tests, independently of YAML options.

Requests default to 8192 output tokens and 120 seconds. A per-call timeout overrides the adapter default; deadlines accept 1–86,400,000 milliseconds. The runtime's cooperative deadline covers the full SDK call, including response-body consumption. Its abort signal and timeout reach the SDK. External aborts report `claude_cancelled`; expiry reports `claude_timeout`. Calls drain before deadline disposal. Injected clients must honor cancellation; arbitrary in-process JavaScript cannot be forcibly terminated.

The [configuration example](../examples/providers/claude.yaml) combines Claude planner/reviewer bindings with the existing Codex executor and `dev` workflow. Copy it to a disposable project, select an accessible model, provide native credentials and review project verification scripts. Namespace defaults and per-agent overrides follow the [plugin contract](PLUGINS.md).

## Results and evidence

Planner JSON contains `summary`, executor `instructions`, non-empty `acceptanceCriteria`, and `artifactIds`. Reviewer/judge JSON contains `summary`, `outcome`, `requiredFixes`, and `evidenceArtifactIds`. Local validation rejects missing/extra fields, invalid types, invented artifact IDs and contradictory verdicts. `pass` requires no fixes; `fail` requires a concrete fix. Both are successful agent executions with separate workflow outcomes. Review cannot replace deterministic verification.

Only final JSON text enters `AgentResult`; thinking/redacted-thinking blocks and native envelopes are discarded. Input and combined final text each have a 256 KiB bound, with at most 64 content blocks. Artifact references do not cause filesystem reads. Known credential values and secret-shaped input fields are redacted before sending and during result normalization. Raw exceptions, authentication details and stack traces are not returned.

Refusals become `needs_input`. Token/context exhaustion, non-final stop reasons, unsupported tool/content blocks and malformed output fail explicitly. Stable `claude_*` errors distinguish authentication, permission, invalid requests, rate limits, connections and timeouts. Transient errors carry a retryable flag; workflow policy owns actual retries. Timing and authoritative execution identity accompany results.

Usage retains available output, cache-read and reasoning counts. Total input sums uncached input, cache creation and cache reads, per the [cache usage contract](https://platform.claude.com/docs/en/build-with-claude/prompt-caching). Aggregate input/total tokens are reported only when all required components are valid non-negative safe integers. Missing/null values, overflowed totals and inconsistent reasoning counts stay unknown. No cost is invented.

`describe()` advertises reasoning and structured-output for the implemented text path, restricted by any fixed role. It advertises no vision, web research or tools. `checkReadiness()` and doctor check credential presence only with scope `configuration`; injected-client authentication stays unknown. Neither metadata nor readiness proves model quality or live access.

## Verification and smoke

Default tests use injected clients and real SDK transports with mocked fetch, without credentials/network. They cover normalization, evidence, usage, errors, redaction, endpoint/auth isolation, cancellation and stalled response bodies. CLI tests exercise built-in registration and credential diagnostics.

With a valid key and available structured-output model, explicitly run:

```bash
VEYRA_LIVE_SMOKE=1 pnpm --filter @veyra/claude smoke -- <model>
```

The smoke makes two billable requests: a supplied-text planning task and a review that must pass. It prints normalized statuses and optional usage only. Missing opt-in/key/model exits 2; failed planning/review exits 1. It is excluded from default tests and CI. Mocked success does not satisfy live verification.
