# Agent capabilities and readiness

M4.1 adds optional discovery to `AgentAdapter` and explicit capability requirements to version 1 workflows in this `0.1.0` development checkout. The contracts and runtime guards are exported by `@veyra/protocol` and `@veyra/sdk`. Core accepts adapters from any provider through these contracts.

`describe()` is synchronous and must have no side effects. It returns an `AgentDescriptor` containing `schemaVersion: 1`, the adapter's matching `id` and `provider`, `adapterVersion`, optional configured `model`, supported `roles`, and `capabilities`. Advertise only behavior the adapter implements for its configuration. Missing capabilities mean unadvertised support; Core does not infer capabilities from model names or call remote model catalogs.

Standard capability identifiers are `reasoning`, `code-execution`, `vision`, `web-research`, `structured-output`, `tool-use`, and `local-cli`. Extensions may declare identifiers such as `example:retrieval`; matching is exact and case sensitive. Role/capability arrays contain at most 64 unique entries. Identifiers are at most 128 characters; capability names use lowercase letters/digits separated by `.`, `_`, `:`, or `-`. Descriptors are plain JSON, with a 512-character model limit and a 16 KiB Core serialization limit. These limits count Unicode code points where expressed as characters.

## Discovery

```ts
import { discoverAgents } from "@veyra/core";

// The caller constructs and injects adapters; discovery never invokes run().
const metadata = await discoverAgents({ analysis: planner, coding: executor });
const readiness = await discoverAgents(
  { analysis: planner, coding: executor },
  { checkReadiness: true, cwd: "/project", timeoutMs: 5000, signal },
);
```

Results preserve binding order and contain independent descriptor/readiness copies or a normalized per-agent error. Ordinary discovery reads metadata only. Readiness probes are opt-in and may execute bounded local checks or contact a service as documented by the provider. Execution controls are forwarded to each probe; providers must honor cancellation/timeouts and clean up their work. A pre-aborted discovery signal skips probes. Missing probes report `unknown`, and invalid descriptors/readiness or thrown probes produce safe errors without raw provider exceptions.

`AgentReadiness` separates `status` (`ready`, `unavailable`, `unknown`) from `scope` (`configuration`, `local`, `remote`). Configuration presence does not prove remote access. Include a safe `message` (at most 4096 characters) and optional detected executable/service `version`; never return credentials or raw authentication output. Readiness is a point-in-time diagnostic, not a guarantee that a later invocation will succeed. Core does not run probes automatically while executing workflows.

| Adapter        | Advertised roles                                                              | Advertised capabilities                                | Readiness probe                                                                                                               |
| -------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| OpenAI         | planner, reviewer, judge; restricted to a configured fixed role when supplied | reasoning, structured-output                           | Environment variable presence only, scope `configuration`; no API request. An injected client reports unknown authentication. |
| Codex CLI      | executor                                                                      | code-execution, tool-use, local-cli, structured-output | Existing bounded version/login-status checks, scope `local`; no task execution.                                               |
| Codex SDK mode | none                                                                          | none                                                   | Unavailable: SDK mode remains planned.                                                                                        |

The Claude API adapter also advertises planner/reviewer/judge roles and reasoning/structured-output capabilities, with credential-presence readiness only; see [Claude configuration](CLAUDE.md). [Claude Code](CLAUDE-CODE.md) advertises executor and code-execution/tool-use/local-cli/structured-output with bounded native CLI/authentication readiness. These adapters currently advertise no vision or web research. Capability declarations describe available adapter paths, not measured model quality or verified account/model access. Native provider permissions still apply; declarations do not create a sandbox.

## Explicit workflow requirements

```yaml
plan:
  type: agent
  agent: analysis
  requires:
    role: planner
    capabilities: [reasoning, structured-output]
```

`agent` pins the configuration binding. Before each invocation, Core reads that adapter's descriptor, verifies the explicit role and every required capability, and supplies `requires.role` as `AgentInput.role`. Owned consensus children retain their mandatory reviewer/judge role; a conflicting explicit role fails. Unsupported requirements, missing required metadata, or mismatched descriptor identity fail the step before invocation. Ordinary workflow failure transitions still apply. Core never substitutes another binding silently; automatic provider selection remains M4.11.

When metadata or `requires` is present, `agent.selected` records the binding, resolved role, requirements and available descriptor before `agent.input`. The normal state redaction applies. Saved workflow requirements remain authoritative on resume, and newly supplied adapters are checked again. Selection history provides evidence of the configuration used by each attempt.

Adapters without `describe()` remain supported for existing workflows without explicit constraints. With no explicit role, the legacy binding name supplies the input role, except for consensus's imposed role. An empty requirements object adds no constraints. Built-in presets retain their earlier author-facing `metadata.requiredCapabilities` annotations; those annotations are advisory. Use the executable `requires` field in a user workflow to enforce matching. See the complete [capability example](../examples/workflows/v1/capabilities.yaml).

`ve doctor --json` includes validated adapter descriptors alongside readiness results. `ve workflow validate` validates the `requires` syntax and configured binding/provider names without constructing adapters or probing capabilities; execution performs the actual descriptor match. [Plugin registration and loading](PLUGINS.md) compose these adapters through the public SDK; third-party imports require explicit trust.
