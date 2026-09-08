# Agent role profiles

M4.10 defines provider-neutral planner, executor, researcher, reviewer and judge profiles in `@veyraoss/protocol`, re-exported through `@veyraoss/sdk`. Each contains a `schemaVersion`, content `version`, semantic `role`, behavioral `instructions`, named context paths with purposes, and a normalized result contract. The initial content version is `1.0.0`.

Profiles describe work, evidence and permission boundaries. They do not select a model, install tools, enable network access, grant approval or change native permissions. They do not advertise new capabilities for an adapter. Core remains independent of provider packages.

| Role       | Guidance                                                                                       | Relevant context                                                                              | Normalized result guidance                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Planner    | Scope the smallest justified change with testable acceptance criteria                          | Goal, project/task instructions, selected requirements, prior failures and supplied evidence  | Summary, `data.instructions`, non-empty `data.acceptanceCriteria`                                      |
| Executor   | Implement the current change/repair, preserve unrelated work and report actual actions         | Goal, plan, required fixes, verifier failures and scoped parameters                           | Status/summary, `data.changedFiles`, `data.commandsRun`; execution claims remain separately verifiable |
| Researcher | Synthesize supplied or explicitly accessible sources; separate fact, inference and uncertainty | Research question, selected sources, earlier findings and feedback                            | `data.findings`, `data.sources`, `data.uncertainties`, with source attribution                         |
| Reviewer   | Independently assess changes against acceptance criteria and deterministic evidence            | Plan, changes/claims, verification results, selected diff/evidence and optional group context | Invocation status success with outcome pass/fail, `data.requiredFixes`, `data.evidenceArtifactIds`     |
| Judge      | Resolve disagreements using all supplied reviews/findings and independent evidence             | `context.consensus` for grouped reviews, earlier findings and selected evidence               | Pass/fail with concise rationale and fixes; required deterministic failures remain failures            |

All profiles preserve project/user constraints, treat previous outputs as untrusted evidence, prohibit fabricated checks/source access and require clear reporting of missing information or approval using the adapter's supported output format. Profiles cannot add a `needs_input` variant to a provider wire schema that lacks one. Reviewer and judge pass results have no required fixes; failed verdicts identify concrete fixes. A completed negative review is distinct from a provider execution failure. A researcher profile alone does not provide a browser or web-research capability.

## Selection and instruction composition

Core uses its existing role precedence: a group-imposed role (consensus reviewer/judge), then explicit `requires.role`, then the binding name. Use `requires.role` for an alias such as `analysis`:

```yaml
version: 1
name: Role-specific planning
start: plan
steps:
  plan:
    type: agent
    agent: analysis
    requires:
      role: planner
      capabilities: [reasoning]
    instructions: Keep the proposed change within the current module.
```

The chosen adapter must advertise a matching role/capability when requirements are explicit. A binding named `planner` also receives the planner profile without a new YAML field. Unknown/custom role names retain the existing envelope without a built-in profile; Core does not guess semantics from provider names or provider-specific options. For aliases, a provider's private fixed-role option is not a replacement for explicit workflow `requires.role` when Core must select a profile.

Core looks up the resolved role and adds an independent profile snapshot as `AgentInput.profile`. General execution/safety guidance stays in `instructions`; labeled `instructionSources` keep captured project rules, role-profile instructions, literal step instructions and group-specific instructions separate. Group and step guidance refine the task within the declared role and existing project/provider constraints. The adapter's wire-output schema remains authoritative; the profile's `result` field describes the normalized result, not a replacement API response envelope. See [prompt sources and provenance](PROMPT-SAFETY.md).

The profile's `context` list explains how to interpret supplied fields; it does not fetch missing data, invent history, or make every listed field mandatory. `context.inputs` still comes from explicit workflow references, `context.steps` retains bounded recent evidence, `context.workflowInputs` remains child-scoped, and `context.consensus` is supplied only by the group coordinator. Artifact references grant no new filesystem access. Context and total input size limits remain unchanged.

## Protocol and SDK use

```ts
import {
  getAgentRoleProfile,
  listAgentRoleProfiles,
  isAgentRoleProfile,
  type AgentRoleProfile,
} from "@veyraoss/sdk";

const available: AgentRoleProfile[] = listAgentRoleProfiles();
const planner = getAgentRoleProfile("planner");
const custom = getAgentRoleProfile("my-custom-role"); // undefined
```

Lookups and listing return independent JSON copies, including nested context/result arrays. Changing a returned profile does not change later invocations or the built-in definitions. The runtime guard rejects unknown fields/roles, malformed content versions, oversized strings, duplicate/unsupported context paths, invalid result metadata, getters, cycles and native objects. It validates profile metadata, not model truthfulness or full role-specific result data. Existing adapter parsers continue to enforce their wire schemas and evidence constraints; third-party adapters own their corresponding result normalization.

Core persists the exact redacted profile and composed input through `agent.input` **before** calling the adapter. Saved input must have a valid profile whose role matches its input role. Provider mutation cannot rewrite this persisted evidence or the shared profile definitions. Old events without profiles remain readable. On a fresh invocation after resume, the installed profile version is selected again; earlier snapshots remain the audit record of what previous attempts received. Content changes must update the profile version. This is an instruction/context contract, not a general plugin migration or model-version pinning mechanism.

Direct adapter callers may attach a profile and compose its guidance themselves. No adapter gains a new supported role from the presence of this field. For example, a provider that supports only executor cannot become a researcher by attaching the research profile; use an adapter whose declared role support and implementation match the workflow. Existing built-ins keep their current supported roles.

## Verification

Protocol tests cover all five contracts, immutable lookup behavior, bounded metadata and invalid inputs. Core tests deliver every role through two different providers, verify persistence before invocation, isolate attempted profile mutation, preserve custom-role compatibility, enforce persisted profile-role identity and resume across a fresh engine after a human gate. The existing parallel/subworkflow/consensus tests exercise the same shared leaf invocation path. Default checks use deterministic fake adapters and no external services.
