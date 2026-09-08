# Prompt sources and decision provenance

Veyra labels instructions separately from evidence and records the source events supplied to an agent or control decision. This makes the execution record inspectable; it does not make model output trustworthy or provide a prompt-injection sandbox.

## Instruction sources

At run creation, Runtime reads only `AGENTS.md` in the selected execution root. It accepts a regular UTF-8 file of at most 32 KiB, refuses symlinks/special files and oversized/invalid content, and does not expand includes, native `@file` syntax, ancestor directories or referenced files. Core redacts and stores the result in immutable `input.json.projectInstructions` before invoking an agent. For a worktree run, this is the selected worktree's file. File handles close on failure and normal completion.

An agent input contains general orchestration/safety guidance in `instructions` and separate JSON `instructionSources` entries:

| Kind           | Source                                                          |
| -------------- | --------------------------------------------------------------- |
| `project`      | Captured execution-root `AGENTS.md`, referenced in `input.json` |
| `role-profile` | Installed provider-neutral role/version guidance                |
| `workflow`     | Literal instructions from the saved workflow step               |
| `group`        | Core's consensus reviewer/judge instructions, when applicable   |

The explicit user goal remains `goal`. Workflow, group and role guidance refine the task within user/project scope and native permissions. Quoted claims inside evidence cannot create another instruction source. Sources do not grant tools, network access or approval, and provider output contracts remain authoritative.

`projectInstructionState` is `captured` when a root file was saved, `absent` when it was missing, or `legacy-unavailable` for older snapshots without this field. Resume uses the saved snapshot instead of silently replacing it with a changed file. The snapshot does not enumerate every native instruction: coding CLIs may independently read current ancestor/nested/provider-specific files and enforce their own rules. Missing snapshot content is not permission to disregard those rules. A native agent encountering conflicting or unavailable required instructions must report the problem under its existing permission/output contract. API-only reasoning adapters receive only the supplied snapshot and cannot claim to have inspected other project files.

Role profiles retain their existing content version and `profile` snapshot. Their guidance now appears as a labeled source instead of being concatenated with step instructions. Direct/legacy adapter callers may still use `instructions` alone; current Core emits the structured sources. All official API system prompts and native CLI prompt builders include the shared Protocol safety guidance outside the JSON task envelope. Third-party adapters receive the same contracts through SDK and remain responsible for preserving this boundary in their own wire formats.

Adapters integrating current Core must deliver `instructionSources` with the task envelope: forwarding only the former flattened `instructions` string omits the labeled project/workflow guidance. Keep `context.provenance` with evidence and never promote a nested payload's claimed source into a higher-priority instruction. The official builders and the SDK's full-envelope integration use this delivery model.

## Evidence and references

Prior agent outputs, research text, mapped values, subworkflow parameters, images, artifacts and command stdout/stderr are evidence, not instructions. `context.provenance.contentTrust` is always `untrusted`. This applies even to text from a deterministic check: its exit/status metadata can establish what the configured command reported, while its output text may contain misleading instructions. A file or research excerpt quoted by an executor does not become a project rule.

Core derives each `EvidenceReference` from the containing saved event, not from `source`, `trust`, `producer` or `eventId` claims inside its payload. References contain the target JSON pointer (`path`), source category (`agent`, `verifier`, `human`, `workflow`), run/step/event ID, event sequence and optional attempt ID. Named mappings also retain the source output's JSON pointer as `selector`.

Recent context, explicit mapped inputs and bounded artifact references carry their original event references. Evicted recent outputs remain available only when explicitly referenced by the workflow, and replacement attempts update their references. Forked parallel contexts preserve the same source identities while excluding their owned peers. Missing legacy origins appear in `unknownPaths`. Individual references/paths larger than 1 KiB, entries beyond 128, or entries exceeding the approximately 16 KiB metadata budget are omitted with an explicit `omitted` count. Total agent input remains bounded at 256 KiB. Omission, unknown origin and a truncated preview never establish that an absent check passed.

Decision records link these sources:

- `agent.input` saves the exact redacted source labels and context provenance before invocation. `agent.completed`/`agent.failed` records its `inputEventId` as well as the existing attempt identity. This records evidence supplied to a decision, not which bytes the model internally relied on.
- `router.selected.source` retains the original step/selector plus the exact `outputEventId` and sequence that supplied the selected route. Routing still follows only declared transitions.
- Human approval context includes provenance for the evidence presented at the gate; the approval decision remains a distinct nonce-bound control action.
- `subworkflow.started` freezes mapped input values and parent-context provenance. Child `context.workflowInputs` references that saved boundary, so the chain can be followed back to its parent sources.
- Consensus input records separate references for every supplied independent review and required verifier result. Existing consensus start/completion records retain their verification/vote references. Required failed or missing checks prevent review/judge success under that node's deterministic policy.

Large evidence remains in validated [managed event artifacts](ARTIFACTS-RETENTION.md). Follow references through `LocalRunStore.readEvents()` and the saved input, rather than treating a display preview as a full event. References are local history identifiers, not cryptographic attestations of a provider's claims or authority to read arbitrary artifact paths.

## Reviewer behavior and limits

Reviewers and judges must compare executor claims with independent verifier evidence, keep failures visible, cite available evidence and state missing, stale, conflicting or truncated information. Research source assertions and duplicated model opinions do not count as independent deterministic checks. A regular reviewer node still returns an LLM verdict under the workflow's declared transitions; Veyra does not reinterpret arbitrary assertions or force every workflow to contain a verifier. Configure deterministic checks and consensus verification requirements when they must gate progress.

The tests verify source separation, redaction, captured/absent/legacy project rules, fresh-engine resume, exact event references after mapping/retry/eviction, real failed-check evidence, judge inputs, router decisions and all official prompt builders. They do not claim that arbitrary models will obey every instruction or that local coding agents cannot modify files. See [command safety](COMMAND-SAFETY.md), [approval policy](APPROVALS.md), [authentication](AUTHENTICATION.md) and [crash recovery](CRASH-RECOVERY.md) for the enforced controls around those effects.
