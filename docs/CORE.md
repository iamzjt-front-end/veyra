# Core orchestration

`VeyraEngine` coordinates a validated workflow, injected adapters, the agent runtime, deterministic verifier, and local run store. It does not load YAML, construct vendor clients, or spawn provider processes.

```ts
import { VeyraEngine, LocalRunStore } from "@veyra/core";

// config/workflow are already loaded, and adapters are already constructed by the caller.
const store = new LocalRunStore({ stateDir: "/project/.veyra" });
const engine = new VeyraEngine({ store, emit: (event) => console.log(event.type) });
const result = await engine.run({
  config,
  workflow,
  agents,
  goal: "Repair the test",
  cwd: "/project",
});
const saved = await store.loadRun(result.runId);
```

`agents` is keyed by workflow agent references. Custom names and providers work through the same protocol. The default runtime is `LocalAgentRuntime`; the default verifier is `ShellVerifier`. Both can be injected for deterministic tests or alternate implementations. When no store is supplied, Core resolves `config.runtime.stateDir` relative to the run's `cwd`. Callers loading config from another directory should resolve its paths first. Config and provider objects are never persisted.

## Execution and outcomes

Core saves the goal, working directory, and workflow snapshot before starting. Each step has an attempt ID/number on its events and execution input. The current step and `step.started` event are persisted before invoking an adapter or verifier. Results, outcomes, and the next step are saved as execution proceeds.

- `agent`: invoke the registered adapter through the runtime. Successful provider completion uses `result.outcome` when present (including reviewer `pass`/`fail`); otherwise it uses `success`. A provider `failure` cannot be overridden by a claimed successful outcome. `needs_input` pauses at the current step.
- `command`: call the deterministic verifier with the configured command list and convert its aggregate result into `success`/`failure`. Core emits verification events; an injected verifier should not independently append duplicate events to the same run.
- `human`: persist `approval.required` with its message/context and pause at the gate. Approval resolution and resume are the following TODOs.
- `end`: complete the step, save terminal state, and emit `run.completed`.

Transitions are resolved by `@veyra/workflow`. Failures require an explicit matching `on.failure` or `on.fail` recovery transition; they cannot silently fall through `next` to completion. A branch with no matching outcome and no fallback fails with an actionable error. A successful leaf with no transitions completes the run. Results report `completed`, `failed`, or `paused` plus the run ID and last step.

Provider/runtime/verifier exceptions become persisted step/run failures with bounded diagnostic messages. Missing adapters identify the workflow key that needs registration. Invalid, non-JSON, or oversized provider results and inconsistent verifier reports fail instead of masquerading as success. Raw native errors are not serialized. A broken store throws to the caller because persistence cannot be claimed. Subscriber events are independent copies of the already-persisted, redacted record; a throwing subscriber stops active execution and its failure is recorded without repeatedly calling the broken subscriber.

## Context and controls

Later agents receive `context.steps` containing the latest result for at most eight recent steps. Results include type, outcome, summary, and relevant provider data or verifier evidence. Large entries are explicit truncated previews. The serialized step map is capped at 48 KiB, including JSON escaping and keys. Up to sixteen deduplicated artifact references of at most 1 KiB each are carried separately. Omitted counts make missing history visible; complete evidence remains in the event log. Core never reads an arbitrary artifact path into the prompt.

Agent/verification result events are capped at 1 MiB each. Verifier command output retention is 64 KiB per stream. Larger evidence should eventually use the artifact system tracked separately in the TODO. Known secret values can be supplied via `redactValues` when Core creates the store, or configured on an injected store. Persisted redacted results are also the source of subsequent prompt context. The application must supply its known credentials; Core does not inspect vendor authentication files or load environment secrets itself.

`cwd`, optional per-step `timeoutMs`, and `AbortSignal` are forwarded to runtime/verifier and remain outside persisted input. Cancellation ends the run as failed with `run_cancelled`; adapters and the runtime own active execution cancellation. At this stage a fixed 1000-step backstop prevents unbounded scheduling. Workflow-specific repair limits, persisted retry policy, approval resolution, and resume are subsequent tasks.

State and event writes are individually durable, not a single transaction across a provider's filesystem edits. Automatic recovery of an interrupted running attempt, process locking, and worktree isolation remain later hardening tasks. Do not treat a saved `running` state as permission to replay an interrupted mutating step blindly.
