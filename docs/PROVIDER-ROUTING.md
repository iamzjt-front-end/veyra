# Explicit provider routing

M4.11 adds optional deterministic selection before an agent invocation. The `agent` binding remains pinned when `routing` is absent. When present, Core considers the primary followed by explicitly ordered fallback bindings. It never ranks model quality, queries model catalogs, changes a model, or introduces an LLM router. Each binding still maps to a configured adapter/provider/model.

```yaml
plan:
  type: agent
  agent: preferred
  requires:
    role: planner
    capabilities: [reasoning, structured-output]
  routing:
    fallbacks: [backup, local]
    fallbackOn: [requirements, unavailable, budget]
    readinessTimeoutMs: 5000
    allowUnknownReadiness: false
    budget:
      currency: USD
      maxEstimatedCost: 0.02
      estimates:
        - { agent: preferred, amount: 0.03 }
        - { agent: backup, amount: 0.02 }
        - { agent: local, amount: 0 }
```

These amounts illustrate user-supplied estimates; they are not provider prices. Omitting `budget` disables cost filtering. A zero estimate is an explicit assertion by the workflow author. Configure real models and suitable estimates before using this policy.

## Rules and boundaries

The primary plus at most 15 unique fallback names establishes preference order. `fallbackOn` is required and lists only the categories that authorize advancing to the next candidate. An empty list stops at the first ineligible candidate. Empty `fallbacks` allows readiness/cost filtering of one pinned binding. Binding names have at most 128 characters, and the primary cannot also be a fallback. Every candidate must be configured and constructible, including candidates that are not ultimately used. Missing bindings, untrusted modules, factory failures, invalid metadata and role conflicts stop execution; they are configuration/contract errors, not fallback reasons.

Routing requires `requires.role` so a fallback alias cannot change the input's semantic role. Consensus still imposes reviewer/judge roles and rejects conflicts. Required capabilities match exactly. The same shared leaf implementation serves sequential, parallel, consensus and nested workflow steps.

For each candidate, Core checks:

1. Its descriptor, role and required capabilities. Missing discovery metadata, unsupported roles and missing capabilities fall under `requirements`.
2. The optional cost estimate. Missing estimates are unknown, never zero. Missing or excessive estimates fall under `budget`. Every estimate names a declared candidate once, and all use the policy's uppercase three-letter currency code. Amounts must be finite and nonnegative. The first eligible candidate within the ceiling wins; a cheaper later candidate does not override configured preference.
3. Readiness, only after the previous filters pass. An unavailable status, failed probe or probe timeout falls under `unavailable`. Missing probes and `unknown` statuses are also ineligible unless `allowUnknownReadiness: true` is explicit. That flag does not admit failed/timed-out probes. Ready results retain their scope: `configuration` means configuration presence, `local` means the documented native check, and `remote` means the adapter's documented remote check. None guarantees future inference success.

Probes receive cwd, cancellation and a deadline, defaulting to 5000 ms and configurable from 1 to 60000 ms. An enclosing step deadline may be shorter. Probes must honor their controls and drain native work before returning; Core waits for this cleanup before selecting another candidate. A third-party hook that ignores cancellation can still block its host; this API is not a sandbox. Cancellation stops selection without trying another provider. Only evaluated candidates are probed, once per invocation; there is no live benchmark, background discovery or probe cache in execution.

Cost filtering is per-invocation estimation. It neither reserves funds nor enforces aggregate run/account spending. Retries and concurrent calls can exceed such an estimate. The separate [Core budget hook](CORE.md) continues to enforce declared workflow spending policies; a hook denial cannot trigger fallback or be bypassed by a workflow failure branch. Reported usage/cost remains separate from routing estimates.

## Failure and persistence

Fallback happens only before invocation. Once an agent starts, a failed result, exception, timeout, cancellation, invalid output or `needs_input` follows existing workflow behavior. Core does not replay the work through a different provider automatically. Use explicit failure transitions, bounded retries and human gates for subsequent work.

`agent.routed` precedes `agent.selected` and `agent.input`. Its version 1 decision records the primary, exact policy/requirements, ordered evaluated attempts, selected/skipped/blocked reasons, available descriptor/model, scoped readiness and configured estimate. It records exhaustion too; no eligible provider produces a step failure, with ordinary explicit `on.failure` recovery available. Without that transition the run stops with `unhandled_step_failure`. Readiness message/version and raw exceptions are excluded from routing decisions. Normal persistence redaction still applies. Cancellation and malformed configuration/metadata are reported through the existing failed-step/run events.

The saved workflow retains the routing policy and estimates. A new invocation or resumed paused agent reevaluates current adapters/readiness under that saved policy and records a new decision. Completed steps are not rerun just to select providers. There is no guarantee of the same provider across new attempts when fallback is enabled. To pin a provider/model, omit `routing` and set the binding's `provider` and `model` explicitly in `veyra.yaml`. Keep that configuration consistent when resuming; provider configuration is supplied by the caller, not persisted with secrets.

## CLI, SDK and diagnostics

See the [workflow example](../examples/workflows/v1/provider-routing.yaml) and [provider configuration](../examples/providers/routing.yaml). Replace placeholder models, start/configure the desired providers, then from the repository root:

```bash
pnpm ve -- workflow validate ../workflows/v1/provider-routing.yaml --config examples/providers/routing.yaml --json
pnpm ve -- doctor --config examples/providers/routing.yaml --json
pnpm ve -- run "Plan the requested change" --config examples/providers/routing.yaml
```

The example permits an unavailable preferred credential/configuration readiness check to select a local endpoint. Its local adapter checks configuration only; it does not prove that a server/model is running. If the selected local invocation fails, the workflow stops. Inspect the planner result in `.veyra/runs/<run-id>/events.jsonl` at `agent.completed` and the human gate before continuing.

`ve workflow validate` checks all declared candidate bindings without importing or probing providers. `ve doctor` lists candidate readiness and a per-step `routing` decision using those previously collected snapshots and Core's selector. A route-only unavailable primary does not make doctor fail when its policy permits an eligible fallback. Invalid candidate configuration, a blocked route or an unavailable independently pinned binding does make doctor fail. Doctor's snapshots do not predict future access or probe timing and do not reserve a provider or write run state. Ordinary text output shows fallback reasons; `--json` and persisted events retain the structured evidence.

Programmatic consumers can call `selectAgentRoute({ primary, policy, requirements, agents, controls?, role? })` from `@veyraoss/core` for inspection. It returns a decision and optional validated selection; it never runs an agent or persists a run. `AgentCandidate` is the read-only descriptor/readiness surface of `AgentAdapter`, so a surface can use explicitly collected diagnostic snapshots. `AgentRoutingPolicy`/decision types and guards are exported through Protocol and SDK. A registry-created adapter exposes the configured plugin readiness hook when present, with the same precedence as `PluginRegistry.checkReadiness`; otherwise its original adapter probe remains available. Hooks must be safe, bounded readiness checks and must not execute the task.
