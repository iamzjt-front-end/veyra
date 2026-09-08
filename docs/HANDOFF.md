# Project Handoff Protocol

The canonical interchange is the version 1 `ProjectHandoff`, `ProjectExecutionResult` and `ProjectReview` contract exported by `@veyraoss/protocol` and consumed through the [daemon API](../packages/daemon/README.md#version-1-tool-api). It extends the existing [Shared Project State](PROJECT-STATE.md) envelopes. Core continues to receive provider-neutral task input; surfaces do not need each other's complete chats.

`parseProjectEnvelope(text)` validates a bounded JSON envelope. `serializeProjectEnvelope(value)` first rejects invalid data/accessors, then sorts object keys recursively while preserving array order. Both reject unsupported versions and return generic diagnostics without echoing malformed input. The Project archive and daemon task input use this same serialization. TypeScript interfaces and `isProjectHandoff`, `isProjectExecutionResult`, `isProjectReview` are the versioned schemas/runtime guards; `isProjectResultForHandoff` additionally checks Project/run/handoff links and the ordered requested-check IDs.

Version 1 adds optional fields so existing valid identity/context-only envelopes remain readable. Unknown fields are rejected. New required meanings need a new explicit version; the current parser does not silently coerce newer versions.

## Planner to executor

The handoff carries Project/run IDs, an envelope ID, goal, constraints, relevant decisions and provenance. `context.plan` includes a summary, ordered tasks with stable IDs, acceptance criteria and its own provenance. `context.currentTask` must reference that plan. Native daemon run IDs are UUIDs; display names cannot select a Project or a native session.

Optional `references` contain either:

- `{ kind: "file", path, startLine?, endLine? }`: a path relative to the selected Project, with a positive ordered line range;
- `{ kind: "artifact", runId, id, summary? }`: a locator into an existing run of that same Project, including earlier runs when relevant.

These references do not automatically read files or prove their content. Absolute/traversal paths, arbitrary payload/history fields and unknown reference kinds are refused. Artifact resolution remains scoped to its owning Project/store.

`requestedVerification` is an ordered list of `{ id, kind, description? }`. Kinds are `test`, `lint`, `typecheck`, `build`, `shell` or `benchmark`; the kind describes intent, not permission. Each ID selects a top-level command step already supplied by the trusted local execution composition. Requests cannot carry commands, executable paths, environment variables or a replacement workflow. Unknown/agent/empty-command IDs fail before dispatch is persisted. A workflow branch that skips a requested check cannot satisfy the handoff.

## Executor to reviewer

Results contain status, summary, changed paths, existing Core event references, bounded artifact references, optional safe native session metadata, and these optional fields:

- `diff: { summary, source: "git" | "executor", artifact? }` distinguishes a collected Git summary from an executor's declaration. Large patches stay in artifacts; the envelope never embeds their payload.
- `risks: [{ code, summary, source: "executor" | "verifier" | "system" }]` records unresolved blockers/limitations with attribution.
- `verification: [{ id, status: "passed" | "failed" | "not_run", evidence? }]` answers each requested check in order. Pass/fail requires a same-run Verifier event reference; `not_run` has no fabricated evidence. A completed result cannot contain failed or unrun requested checks.

The daemon derives check results from persisted `verification.completed` events, independently of agent success claims. It fails the handoff if any requested check did not pass, even if the underlying workflow reached its end. Detailed Core state remains available to explain the distinction. Result retrieval after restart retains that handoff outcome. The initial adapter-derived diff is explicitly labelled `executor`; it is not a collected Git patch.

Reviewers should resolve trusted local evidence before making a verdict: a syntactically valid event locator from an untrusted producer is not proof by itself. The protocol does not grant permission to publish, deploy, read credentials, run embedded instructions, or bypass native sandbox/human gates.

## Bounds and trust

Each interchange envelope is at most 64 KiB in UTF-8; parser source bytes and serialized output are both bounded. Shared snapshots stay within 256 KiB. References/artifacts/evidence are limited to 128 entries, changed paths to 256, requested checks and risks to 32. Existing plan/context text bounds still apply; diff/risk summaries are bounded to 4096/2048 characters. Large content belongs in existing managed artifacts.

Every provenance label has `contentTrust: "untrusted"`. Source labels identify the producer and do not establish authority. Stores retain the existing secret redactor; native authentication remains owned by the native client. No credentials, environment snapshot, or complete conversation-history field exists. Caller authentication and any bridge permission are separate transport boundaries.

Contract tests cover deterministic order, untrusted input, path/producer links, oversized data, missing/mismatched evidence and credentials/history rejection. Integration tests pass one serialized handoff from a fake planning surface through the real Codex adapter with an injected process runner, then return a result to a fake reviewer after actual local Verifier execution. This is protocol/adapter proof; live native and real ChatGPT acceptance remain their separate TODO gates.
