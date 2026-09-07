# Provider-neutral protocol

`@veyra/protocol` defines the contracts shared by adapters, runtime, verifier, Core, and interfaces. `@veyra/sdk` re-exports these public contracts and the JSON guard. No provider SDK types appear in them.

## Persisted data and execution controls

`AgentInput` contains the goal, role, instructions, context, artifacts, and execution identity. `ExecutionMetadata` identifies a run and step, with optional attempt ID and one-based attempt number for retries, and `parentStepId` for an owned parallel child. The coordinating engine owns these identities. Adapters can echo the same identity in `AgentResult.execution`; persistence must associate every result with its authoritative run/step/attempt.

`AgentRunOptions` is the separate, ephemeral second argument to `AgentAdapter.run`: working directory, abort signal, and timeout. These controls must never be serialized into an agent input or event. This task defines the control contract; runtime and provider tasks implement its behavior.

Context, result data, artifact metadata, and structured error details use `JsonObject`/`JsonValue`. Omit unknown optional fields. `isJsonValue(value)` checks runtime data for finite numbers, plain objects, dense arrays, and serializable nested values; it rejects functions, undefined, native errors, dates, maps, cycles, accessors, and custom serialization methods. Shared references are allowed when they are not cyclic. This guard validates shape, not content redaction or output size.

`StepOutput` describes the normalized agent, command, human or parallel output used by workflow references. Parallel output contains a declaration-ordered array of `ParallelChildResult`: child ID, status, optional attempt identity, outcome, evidence event ID and normalized error. Full agent and deterministic verifier evidence remains in its own event. `AgentInput.context.inputs` contains the named JSON values selected by the saved workflow, while `context.steps` is bounded recent context. [Workflow inputs](WORKFLOWS.md#named-inputs-and-step-outputs) define their selection, size limits and missing-value behavior.

## Results, artifacts, and usage

`AgentResult` keeps execution status (`success`, `failure`, `needs_input`) separate from a workflow `outcome` such as `pass`/`fail`. Optional timing uses ISO 8601 timestamp strings and milliseconds. Artifacts carry an ID, kind, optional path/media type/byte size, creation time, and producer execution identity.

`UsageMetadata` has optional input/output/total/cached-input/reasoning token counts and an optional cost amount with an explicit currency. Unknown usage or cost is omitted, never treated as zero. Producers validate non-negative counts and costs; this package does not calculate prices or assume a currency.

Use small normalized result data and summaries. Large process output and provider diagnostics belong in artifacts, with references in results/events. Never put raw SDK objects, credentials, or unrestricted provider responses into persisted state.

`VerificationResult` describes deterministic evidence: command, success, exit code, retained output, optional truncation flags, duration, and optional execution identity/error/artifacts. An unavailable exit code is `null`, such as when a process cannot start. A review remains an agent result and must not be presented as deterministic verification.

## Errors and events

`SerializedError` is a plain record containing a stable machine-readable `code`, a safe human-readable `message`, and optional `retryable`/JSON `details`. Producers normalize and redact errors at their boundary. Native `Error` instances and stack traces are not the persistence contract.

All events carry a run ID and ISO timestamp. Persistence can add an event ID and monotonic sequence; step/agent events also carry the step ID and optional attempt identity. The event union covers:

- Run started/completed/failed/paused/resumed.
- Step started/completed/failed and `step.retrying`, including its used count, maximum, and attempt identity.
- Router selection through `router.selected`: route label, target, static/input selection kind, and source step/pointer for an input reference. The normalized `StepOutput` uses type `router`, outcome equal to that label, target and selection kind.
- Subworkflow started/paused/completed: workflow name, qualified child start, and mapped inputs at entry; current child step/reason at pause; mapped outputs or normalized error at completion. All records use the containing run ID. The call's normalized `StepOutput` has type `subworkflow`, outcome `success/failure` and outputs/error; child agents receive mapped parameters in `context.workflowInputs`.
- Parallel started/paused/completed and independently persisted `parallel.child.completed`. Start records child IDs, concurrency and failure policy; joins record ordered child states. Child events include `parentStepId` so surfaces can track active children while the run's current step stays the group.
- Consensus started/paused/completed records reviewer IDs, mode, threshold or judge, required verifier evidence, pause phase, and final `pass`/`fail` decision. `ReviewVote` references a separately persisted agent event and carries an explicit `pass`, `fail`, or technical `error` verdict. `VerificationEvidence` independently references a command result and its success; it is never a vote. Consensus `StepOutput` exposes the ordered votes, optional judge vote, mode/threshold, verification references and failure reason. Reviewer collection also emits the existing parallel scheduling events; reviewer/judge agent events carry `parentStepId`.
- Agent input/started/completed/failed. `agent.input` records the resolved redacted `AgentInput` before invocation, with matching run/step/attempt identity and no ephemeral execution controls. Result/error events retain their existing meaning.
- Verification started/completed, with deterministic command results.
- Approval required/resolved, with explicit `approved`/`rejected` decisions.
- Process output, referencing a stdout/stderr artifact and an optional bounded preview.

`EventSink` receives this same union for CLI, TUI, and Dashboard consumers. Declaring an event does not mean its producing runtime feature is implemented; the canonical [TODO](TODO.md) records that status.
