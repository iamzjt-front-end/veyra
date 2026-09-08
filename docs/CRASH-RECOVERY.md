# Crash recovery and idempotency

Veyra resumes only from evidence that a scheduling boundary completed. A dead process does not prove that its last agent or command finished, and an agent result alone does not authorize replay. Recovery never resets files, discards edits, or assumes an external operation is idempotent.

## Inspect before recovery

```bash
ve status <run-id>
ve status <run-id> --json
ve resume <run-id> --recover-interrupted
```

`engine.inspectRun({ config, runId, cwd? })` supplies the same inspection to every surface without constructing providers or changing saved run records. Reads coordinate through ephemeral store-lock metadata when the state directory exists. Its `status` is an observation; `storedStatus` is the original snapshot value. CLI JSON exposes both, `ownerStatus`, and `recovery.allowed/reason/checkpoint`. Ordinary paused and terminal runs retain their saved status.

| Saved status           | Owner observation                     | Reported status       | Interrupted recovery                                       |
| ---------------------- | ------------------------------------- | --------------------- | ---------------------------------------------------------- |
| `running`              | Local PID exists                      | `running`             | Refused                                                    |
| `running`              | Local PID is absent (`ESRCH`)         | `interrupted`         | Requires a proven completed boundary and the explicit flag |
| `running`              | Missing/foreign owner or probe denied | `unknown`             | Refused                                                    |
| `paused`               | Any                                   | `paused`              | Use normal resume and resolve any pending approval         |
| `completed` / `failed` | Any                                   | Saved terminal status | Refused; resume never restarts a terminal run              |

Core records an optional `state.owner` containing the execution coordinator's PID, hostname and approximate process start timestamp before emitting execution events. Runtime owns metadata collection and the signal-zero liveness probe. The timestamp is diagnostic, not proof of PID identity. PID reuse is conservatively treated as alive; denied probes and foreign-host metadata stay unknown. These are local-machine observations, not remote leases or a distributed identity system. Do not share active state directories between hosts.

Inspection is a point-in-time observation. Resume acquires a per-run control lease, refuses a changed revision/event boundary, and checks ownership/evidence again under the saved workspace lease. `--recover-interrupted` also asserts that the previous coordinator **and its child processes have stopped**. A missing coordinator PID does not prove orphaned children or external services stopped. A paused run with stale run/workspace leases may also need the flag, including during explicit approval; its normal completed pause and approval checks still apply.

## Completed boundaries

The supported recovery points are:

- The initial `run.started` event before any step begins, with the original starting step and empty retry counts.
- A successful `step.completed` event with exactly one matching `step.started` attempt ID, step ID and attempt number. The saved current step must match the completed step or its declared successor. Other unfinished leaf attempts prevent recovery; enclosing subworkflow scopes may remain open.
- The same boundary after a recovery decision was durably recorded but its state update was interrupted.

Core follows the snapshotted workflow's successor. If a root terminal agent, command or `end` step completed, recovery finalizes the run without invoking it again. A completed terminal child step closes its existing subworkflow scope, preserving a declared-but-unmatched outcome as a failure without replaying the child. Previous attempt IDs, retry counters, outputs and file mutations remain intact. A deliberate workflow loop still follows its declared transition and bounded retry policy; recovery does not invent an extra retry or replenish its budget.

`run.paused` (reason `recovered_completed_checkpoint`) or terminal `run.completed` records `recovery: { eventId, sequence }`, referring to the immediately preceding durable boundary. The decision is appended and synced before the state snapshot changes. If that reconciliation is interrupted, the next recovery validates the same reference and updates state without appending a duplicate decision or rerunning completed effects. A damaged or mismatched reference is refused.

Human approvals retain their separate explicit decision protocol. Failure/negative outcomes, a pause missing its final boundary, an interrupted retry wait, a lone provider/verifier result, and unknown in-flight parallel/agent/command effects are not automatically reconciled. No force-replay or assume-completed switch is provided. Legacy running snapshots without ownership metadata remain readable but cannot be automatically recovered; normal fully recorded paused runs remain supported.

## Partially mutated work

When recovery is refused, preserve the run directory and workspace. Confirm the old coordinator and relevant child processes stopped, then inspect the last attempt's events, Git diff, test results and any external operation receipts. Reconcile partial changes deliberately. If completion cannot be proven, begin a new run in a reviewed workspace with an explicit remaining-work goal, retaining the interrupted run as evidence. Do not edit a saved status to manufacture success or reset retry counters to bypass policy. Stale workspace ownership may require separate scoped cleanup; the [workspace rules](WORKSPACES.md) still apply.

An agent can change files or external systems before Veyra receives its result. Neither atomic JSON nor an attempt ID makes those effects exactly-once. Providers/tools needing stronger guarantees must use their own idempotency keys or reconciliation APIs. This policy intentionally favors preserving uncertain work over automatic replay.

## Durability and limits

State snapshots and the active pointer use exclusive temporary files, file sync, atomic rename, and parent-directory sync on POSIX. Run creation syncs its initial files/staging directory before publication and syncs the runs directory afterward. A process killed before rename leaves the previous complete snapshot; a process killed after rename leaves the new complete snapshot. Unpublished staging directories and leftover temporary files are never chosen as authoritative state or removed automatically.

On Windows, file sync and atomic rename still apply; Node cannot portably sync an open directory there. Filesystem and power-loss guarantees vary. The POSIX fault-injection tests exercise real `SIGKILL` before/after rename and during execution/reconciliation; Windows-specific process-death verification is tracked separately.

Event append, state replacement, active selection and provider side effects are separate operations. A partial JSONL tail, invalid JSON or invalid event contract stops inspection/recovery and is preserved for repair, never silently discarded. A crash can leave a terminal snapshot without its final event; terminal state never grants permission to execute that run again. This is a local file store, not a multi-file transaction or database. [Run/store locking](LOCKING.md) excludes cooperating concurrent controllers and partial reads, but does not turn these separate operations into a transaction.

See [state storage](STATE.md), [Core execution](CORE.md), [approval boundaries](APPROVALS.md), and [secret handling](AUTHENTICATION.md) for the related contracts.
