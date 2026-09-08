# Local process runtime

`readProjectInstructions(cwd)` reads only the selected execution root's regular UTF-8 `AGENTS.md` (32 KiB maximum), refuses symlinks/special files and oversized content, and closes its bounded read handle. It does not expand includes or discover ancestor/native rule files. Core snapshots and redacts the returned data before invocation. See [prompt source capture](PROMPT-SAFETY.md).

`createDeadline(timeoutMs?, signal?)` creates an abort signal for a bounded operation and exposes `timedOut()` plus `dispose()`. Core uses it for workflow agent/command deadlines spanning an entire invocation, including multi-command verification. Cancellation signals active work; the caller must await its cleanup and dispose the timer/listener. The first cause wins: parent cancellation clears the timer, and a later parent abort does not replace an already-fired deadline. Parent reasons propagate only through the ephemeral signal. It does not forcibly interrupt arbitrary JavaScript or replace provider process cancellation. See [cancellation semantics](CANCELLATION.md).

`@veyraoss/runtime` owns generic local execution. Adapters and verifiers use `runProcess`; Core does not spawn provider executables.

```ts
import { runProcess } from "@veyraoss/runtime";

const result = await runProcess({
  executable: process.execPath,
  args: ["--test"],
  cwd: "/path/to/project",
  timeoutMs: 60_000,
  maxOutputBytes: 1024 * 1024,
  onStdout: (chunk) => process.stdout.write(chunk),
});
```

## Input and output

The runner passes an executable and argument array directly to Node's `spawn` with `shell: false`. Shell punctuation in an argument stays literal. Optional `stdin` supplies up to 1 MiB of UTF-8 text and is then closed; otherwise the child immediately receives EOF. This supports prompts without command-line quoting or argument-length limits. Use a non-interactive command. The runner does not create a workspace or change the caller's working directory. `env` inherits the current environment with explicit overrides; an `undefined` override removes a variable from the child only. Do not persist this execution request or its environment.

`ProcessResult` includes exit code, termination signal, duration in milliseconds, stdout/stderr, and truncation flags. A nonzero exit is a result, not an exception. Timeout/cancellation add `terminationReason`; callers must treat that as interrupted even if the process's shutdown handler exits zero. A request already aborted returns a cancelled result without starting a process. Without `timeoutMs`, no timeout is imposed; integrations should choose a finite limit appropriate to their work.

Output callbacks receive decoded UTF-8 chunks as they arrive. They are synchronous and should return promptly. Each stream retains its first 1 MiB of raw output by default; `maxOutputBytes` changes this per-stream limit, and zero disables retention. Streams continue to drain and callbacks continue after truncation. An incomplete UTF-8 character at a truncated boundary is omitted. A callback that throws triggers process cleanup and a typed failure. Consumers are responsible for any additional buffering, artifact storage, and secret redaction of command output.

Missing executables reject with `ProcessExecutionError.code === "executable_not_found"`; unavailable working directories have `invalid_cwd`. Other startup, callback, and termination failures have stable codes. Errors after startup carry a final `result` with retained output. Error messages exclude argument values, environment values, and callback exception details.

## Cancellation and platform behavior

The [platform policy](PLATFORMS.md) defines verified macOS/Linux targets and the currently unsupported native Windows boundary.

On macOS/Linux, every command starts in its own process group. Timeout or `AbortSignal` sends SIGTERM to that group, then SIGKILL after `terminationGraceMs` (default 500 ms). The runner waits for the command's streams to close and for escalation to finish, including when the group leader exits before its descendants. Descendants that deliberately create a separate session escape this group; this is process lifecycle management, not a security sandbox.

The final escalation determines whether group signaling succeeded. A failed graceful signal does not become a permanent cleanup error if SIGKILL later succeeds or reports `ESRCH` (the group is gone). This handles a macOS reaping race: [XNU's group-signal implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c) can return `EPERM` for a group containing only exited processes. An unexpected error from the final SIGKILL still produces `termination_failed`; the original timeout/cancellation reason is retained.

On Windows, the runtime invokes the system `taskkill.exe /PID <pid> /T /F` to force termination of the process and its descendants. There is no SIGTERM grace period on that platform. If tree termination fails, the runner attempts direct-child cleanup and rejects with `termination_failed`; it does not claim descendant cleanup succeeded. The taskkill helper has a five-second timeout. Windows tree termination has mocked orchestration tests but still needs native Windows validation. The POSIX descendant and signal-escalation tests are explicitly platform-specific. See Node's [process-group semantics](https://nodejs.org/api/child_process.html#optionsdetached) and Microsoft's [taskkill reference](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill).

`LocalAgentRuntime.runAgent` forwards the separate `AgentRunOptions` to adapters. Each adapter must implement its process/API cancellation using those controls; this wrapper does not claim that an arbitrary adapter can be forcibly interrupted.

## Secret-safe execution boundaries

`collectSecretValues(env, extraNames?)` and `createSecretRedactor({ values?, env?, envNames? })` provide the shared provider-neutral redaction utility used by adapters and Veyra-managed output/state. The returned `text` and `json` functions return sanitized copies; they never read environment variables or credential files implicitly. `json(value, false)` skips credential-shaped field masking while still filtering known/recognizable secret strings, including payload keys, for callers that already own field-level validation. `text(value, { truncated: true })` additionally removes an incomplete known credential at a retained-output boundary. Core's store retains its workflow-specific structural handling. See [the authentication policy](AUTHENTICATION.md) for credential precedence, examples and limits. Raw `runProcess` remains a low-level process API whose streams must be sanitized before external display or persistence.

## Workspace lifecycle

`currentProcessOwner()` returns local coordinator PID, hostname and approximate process start time. `isProcessOwner()` validates the small metadata contract; `inspectProcessOwner()` probes only signal zero and returns `alive`, `dead` (only local `ESRCH`) or `unknown`. Foreign owners and denied probes stay unknown; PID reuse is conservatively alive. These helpers do not acquire locks, stop processes or prove effects completed. Core uses them for [crash inspection and recovery](CRASH-RECOVERY.md).

`acquireLocalLock({ directory, holder, waitMs?, recoverStale? })` provides bounded local ticket coordination with explicit ownership and an idempotent `release()`. It retires only matching holders whose local PID is proven absent, rejects unknown/unsafe metadata, and never steals by age. Core uses it for run control and short store operations. See [locking](LOCKING.md) for the protocol, recovery and filesystem assumptions.

`LocalWorkspaceManager(stateDir)` prepares and leases shared directories or detached Git worktrees, validates ownership on resume, and removes only an eligible unchanged worktree. Core supplies the run ID and saves the returned `WorkspaceInfo` before invoking any agent. Callers of the Runtime API must release each returned lease in `finally`; Core handles that lifecycle for normal runs. See [workspaces](WORKSPACES.md) for configuration, dirty-tree defaults, concurrency scope, preservation and cleanup.
