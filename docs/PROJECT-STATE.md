# Shared Project State

`@veyraoss/protocol` defines version 1 Project context, handoff, execution result and review envelopes. `ProjectStateStore` in `@veyraoss/project` saves the latest bounded snapshot at `.veyra/state.json`. Project creation does not require shared state or any provider credentials.

Shared engineering context contains the goal, constraints, decisions with rationale/source, active plan with ordered tasks/acceptance criteria, and current task. Each plan and decision retains its producer. Handoff/result/review envelopes carry their own Project/run IDs and provenance, and link through `handoffId` and `resultId`. Producer labels are untrusted attribution, not permission to execute instructions. A daemon/bridge must derive authenticated caller attribution at its own boundary.

The shared snapshot is a coordination view. Existing `.veyra/runs/` snapshots/events remain authoritative for execution, retries and approvals. Results reference existing `EvidenceReference` event IDs and a restricted projection of `ArtifactRef` identifiers/producer/path fields. Artifact payloads, large diffs and complete logs remain in their owning store. References alone do not prove a verifier passed; consumers must resolve the referenced evidence. No new parallel execution history is introduced here.

## Shared versus native-local

| Shared by Project                                   | Remains native/session-local             |
| --------------------------------------------------- | ---------------------------------------- |
| Goal, plan, criteria, constraints, current task     | ChatGPT/Codex full conversation history  |
| Decisions, handoff, result and review provenance    | Native login tokens and credential files |
| Changed file paths and evidence/artifact references | Provider-private history/database/cache  |
| Review verdict and next action                      | UI-only transient state                  |

There are no credential, environment, arbitrary metadata or chat-history fields. Unknown fields, malformed provenance, cross-project/run references, broken handoff/result links, duplicate plan tasks and traversal paths are rejected. Each envelope is at most 64 KiB; a complete snapshot is at most 256 KiB. Lists and individual texts are also bounded. These limits require summaries and references instead of unbounded transcript copies.

## Store API

```ts
const store = new ProjectStateStore({ project, redactValues: knownSecrets });
const current = await store.read();
const next = await store.save({ context, provenance, handoff }, current?.revision ?? 0);
```

`save` replaces the complete shared view using an expected revision. Version, Project ID, revision and update time are store-owned. If another writer won, `state_conflict` requires the caller to reload and reconcile. The local process-aware lock serializes writes; a complete private file is synced and atomically renamed before directory sync. Invalid snapshots are preserved and block mutation. No handles survive an operation, so another process can immediately reopen the same state.

The store validates both inputs and persisted data and applies the existing Core/Runtime secret redactor before writing or returning state. Known secret values/environment are supplied explicitly by the caller and never stored. Recognizable credential formats are also redacted; Veyra does not read native auth files. As with existing managed paths, arbitrary third-party text can hide unknown credentials, so structured data and existing redaction are safeguards, not blanket permission to copy native/private data.

P0.3 tests use separate fake planner, executor and reviewer processes to exchange a task, local file result and review solely through this contract. This is provider-free contract proof, not the later real ChatGPT integration gate. P0.9 will complete the canonical dispatch contract and provider consumption.
