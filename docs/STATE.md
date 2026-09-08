# Local run state

`LocalRunStore` is the persistence boundary owned by `@veyra/core`. It stores versioned JSON and structured events; it does not schedule steps or construct providers.

```text
.veyra/
  state/
    active.json
  worktrees/
    <UUID>/        # optional detached Git execution workspace
  runs/
    <UUID>/
      input.json
      state.json
      events.jsonl
      artifacts/
```

## API and snapshots

```ts
import { LocalRunStore } from "@veyra/core";

const store = new LocalRunStore({ stateDir: ".veyra" });
const run = await store.createRun({ goal, workflow, cwd: process.cwd() });
await store.updateRun(run.state.runId, {
  status: "paused",
  currentStep: "verify",
  retryCounts: { execute: 1 },
  lastOutcome: "success",
});
const reloaded = await store.loadRun(run.state.runId);
```

The directory defaults to `.veyra` relative to the caller's working directory. Creation generates a UUID, snapshots the original goal, validated workflow, working directory, optional workspace metadata, and creation time, and sets the active pointer. Inputs are immutable through this API. State records status (`running`, `paused`, `completed`, `failed`), the current/next step, retry counts, timestamps, optional last outcome and optional execution `owner` (`pid`, `host`, `startedAt`). Core records ownership before execution; direct store creation does not claim an execution owner. Step IDs and retry keys must exist in the workflow. Updates replace the supplied retry map; use `currentStep: null` to remove the step for a terminal run. Omit optional fields instead of supplying `undefined`.

`loadRun(id)` reads an input/state pair. `listRuns()` returns states ordered by update time, and `getActiveRun()` loads the selected run or returns null. `setActiveRun(id)` selects an existing run; null clears the pointer without deleting history. Completing a run does not implicitly clear that selection.

`appendEvent(id, event)` validates the shared event contract, assigns a UUID event ID and a one-based sequence, redacts it, and appends one JSON line. `readEvents(id)` validates and returns the recorded events. Appends validate the existing log before adding a record. These APIs read the local history into memory; large-history streaming and retention are later work. A single JSON snapshot/event is limited to 16 MiB on write; use artifacts for large output. Artifact directories are created now; artifact collection and rendering belong to later tasks.

## Interruption and errors

Subworkflow snapshots embed every resolved child definition before the run starts. Qualified child step IDs and retry keys are validated against the complete execution graph. Child work uses the same run directory and event log; `subworkflow.started/paused/completed` records scope boundaries, frozen mapped inputs and mapped outputs/errors. Resume does not reopen referenced YAML files. Credential-shaped execution map keys remain structural even inside nested definitions; runtime parameter/result values still pass through redaction.

`consensus.started` freezes the mode, reviewers, threshold/judge and required verifier evidence references. Each review remains in its own agent result event; the ordered aggregate contains references rather than copies. Fully persisted reviewer/judge pauses resume from those boundaries without repeating completed reviews. Unknown interruption during reviewer/judge work remains subject to the same conservative recovery rules as other agent work.

Workflow snapshots retain declarative policies and materialized leaf timeout/retry/concurrency defaults. Generated policy approval gates are rebuilt deterministically from that snapshot and validated as current-step IDs. Budget hook code is never persisted; only declarations, provider usage and `budget.checked` decisions are stored. Lifetime root/child step limits are reconstructed from `step.started` events, so pause/resume does not replenish them. An interruption during retry backoff is conservatively refused under the existing incomplete-attempt recovery rule.

Mutable snapshots and the active pointer use exclusive temporary files, file sync, atomic rename and parent-directory sync on POSIX. A new run syncs its files/staging directory before publication and then syncs the runs directory. Incomplete `.tmp-*` run directories and leftover temporary snapshots are ignored by readers. A process interruption therefore cannot expose a half-written replacement JSON snapshot. Windows omits directory sync; filesystem/power-loss guarantees vary. This is not a transactional database.

Run publication, event append, state update, and active-pointer update are separate operations. If a process exits between them, the last complete snapshot remains readable and event history supplies additional evidence. If pointer publication failed after run creation, `listRuns()` can still discover the run. Core's [crash recovery](CRASH-RECOVERY.md) combines owner liveness with matched attempt/completion boundaries, records the recovery event reference before updating state, and refuses uncertain effects. Read-only inspection distinguishes stored `running` from observed `interrupted`/`unknown` without rewriting history.

Malformed JSON, unsupported schemas, missing files, invalid step references, and malformed events raise `StateStoreError` with a path and corrective guidance. A partial final JSONL line is reported as corrupt, and further appends are refused. No damaged history is silently skipped or repaired: preserve it and restore a valid copy before resuming. API calls reject path-like run IDs and symlinked state files/directories.

Mutations are serialized within one store instance. Use one writer per state directory; cross-process locking is not yet implemented. The store does not claim protection against a separate process racing filesystem changes. These limitations are tracked by the canonical [TODO](TODO.md).

## Secret boundary

The input API accepts a goal, workflow, optional cwd and validated workspace metadata. An optional second `createRun` argument reserves the UUID already used by Runtime workspace preparation; existing IDs are refused. Provider configuration, native errors, abort signals, API clients, and raw execution environments are not input snapshots. Credential-shaped fields and environment objects in JSON payloads are replaced with `[REDACTED]`. Recognizable token formats and secrets embedded in payload keys are also filtered; structural workflow/state keys cannot be renamed. Truncated stream flags enable removal of known credential prefixes at the retained boundary. Applications must pass known secret values through the ephemeral `redactValues` constructor option to remove them from free-form text as well. The store does not discover credentials or read the ambient environment into state.

Secret filtering is checked before publication. If redaction would invalidate workflow/state/event identifiers, the write is rejected. Never use credentials as execution identifiers or embed them into command strings. Callers remain responsible for supplying known secrets and for avoiding unrecognized sensitive content in goals, output, and artifact files. Newly created directories/files use restrictive POSIX modes where supported.

The immutable `workspace` field and `run.started.workspace` record the execution location selected by Core. Resume validates worktree ownership through Runtime. `workspace.removed` records explicit terminal-run cleanup; removing a worktree retains run history and artifacts. The [workspace lease](WORKSPACES.md) covers execution in one workspace, while the state-store transaction/locking limitations above remain applicable.

`store.redactText(text)` exposes the same configured text filter for Core diagnostics that must be redacted before truncation. It does not persist the input or expose the configured secret values.
