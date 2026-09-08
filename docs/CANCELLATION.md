# Cancellation semantics

Cancellation stops the current coordinator's scheduling, signals active work, waits for invoked operations to settle, and saves the terminal reason. It preserves existing edits and evidence. Cancelling a run does not undo an agent's filesystem changes or an operation already accepted by a remote service.

## User controls and deadlines

The CLI handles Ctrl-C (`SIGINT`) and `SIGTERM` during live execution. Its handlers remain installed for the process lifetime, including cleanup, persistence, output draining and repeated signals. The first handled signal sets its exit code: 130 for SIGINT, 143 for SIGTERM. There is no second-interrupt shortcut that abandons cleanup. Signals arriving after Node disposes its native handlers during final teardown are outside the JavaScript handler boundary.

Embedded callers pass an `AbortSignal` to `engine.run()` or `engine.resume()` and abort its controller. Signals are also accepted directly by Runtime and Verifier. An already-aborted process request never spawns a child; an already-aborted Core run records a failed run without invoking a provider. Arbitrary caller `signal.reason` values remain ephemeral and are not copied into state or errors.

A saved leaf `timeoutMs`, inherited workflow `stepTimeoutMs`, or request timeout bounds one agent invocation or the entire command list in a command step. The smallest applicable cap wins. This is a leaf deadline, not a total elapsed-time limit for the entire workflow. Retry backoff precedes that deadline but remains cancellable. A deadline signals work; it cannot forcibly interrupt in-process JavaScript that ignores the signal.

`createDeadline()` preserves the first cause for its operation. Parent cancellation clears its pending timer; later time passage cannot relabel it as a timeout. A deadline that fires first remains a timeout if the user subsequently cancels while that invocation is settling. Listeners/timers are disposed after the invocation.

## Scheduling and persisted reasons

Core checks cancellation before scheduling/invocation and before committing a paused or completed run. An abort observed from a start/input/approval/completion subscriber cannot cause another operation to start or commit a successful final boundary. A terminal boundary already committed remains terminal; signals do not roll it back. An adapter or verifier that rejects on abort is classified as cancellation rather than an unrelated execution exception.

Cancelled runs retain the existing `failed` status. New terminal snapshots include the shared serialized `error` contract; `run.failed` and the returned result carry the same redacted reason. Status displays it in text and JSON. Legacy states without an error remain readable.

| Reason                       | Meaning                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `run_cancelled`              | The live coordinator received user/parent cancellation                                   |
| `step_timeout`               | A Core leaf deadline expired                                                             |
| `process_termination_failed` | Runtime or Verifier explicitly reported failed process cleanup; inspect before more work |

Provider/verifier result events retain their own diagnostics, including provider-native cancellation/timeout/error codes. A handled child timeout remains evidence in that child's failure event; ordinary workflow failure policy may take an explicit recovery branch. User cancellation and known Runtime cleanup failure stop the whole run regardless of such branches. Failed runs cannot restart through `resume`; review partial work and start a new run with an explicit remaining goal when appropriate.

## Child propagation and process cleanup

Subworkflows share the parent's cancellation control. Parallel/consensus groups signal all active children, await their settlement, and skip queued work. Results identify cancelled and skipped children; completed children retain their evidence. A fail-fast group can also cancel peers without cancelling the user's root signal. Its declared failure transition still applies.

On POSIX, Runtime creates a separate process group, sends SIGTERM to that group, then escalates to SIGKILL after the configured grace period (500 ms by default). Escalation remains scheduled even if the leader exits first, so descendants that ignore SIGTERM are still targeted. The process call settles after leader/stream closure and the termination attempt. Windows uses a bounded PID-scoped `taskkill /T /F`; failures are reported and direct-child cleanup is attempted. See [Runtime](RUNTIME.md) for platform verification and result details.

Core waits for the invoked runtime/adapter/verifier promise before releasing normal run/workspace leases. It cannot prove cleanup for an arbitrary third-party adapter, a daemon that escapes the managed process group, or remote work already accepted by a service. Native provider result events preserve cleanup diagnostics; a timeout message does not assert that every external effect stopped. Do not force-release ownership while an invocation is still active.

The tests use fake cooperative adapters, real nested execution, real CLI SIGINT/SIGTERM, and disposable child/grandchild processes that ignore SIGTERM. They verify preserved state reasons, skipped successor commands, repeated-signal handling, process termination and released workspace ownership. Signal-specific cases run on POSIX; native Windows support is tracked separately.
