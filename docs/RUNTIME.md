# Local process runtime

`@veyra/runtime` owns generic local execution. Adapters and verifiers use `runProcess`; Core does not spawn provider executables.

```ts
import { runProcess } from "@veyra/runtime";

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

On macOS/Linux, every command starts in its own process group. Timeout or `AbortSignal` sends SIGTERM to that group, then SIGKILL after `terminationGraceMs` (default 500 ms). The runner waits for the command's streams to close and for escalation to finish, including when the group leader exits before its descendants. Descendants that deliberately create a separate session escape this group; this is process lifecycle management, not a security sandbox.

On Windows, the runtime invokes the system `taskkill.exe /PID <pid> /T /F` to force termination of the process and its descendants. There is no SIGTERM grace period on that platform. If tree termination fails, the runner attempts direct-child cleanup and rejects with `termination_failed`; it does not claim descendant cleanup succeeded. The taskkill helper has a five-second timeout. Windows tree termination has mocked orchestration tests but still needs native Windows validation. The POSIX descendant and signal-escalation tests are explicitly platform-specific. See Node's [process-group semantics](https://nodejs.org/api/child_process.html#optionsdetached) and Microsoft's [taskkill reference](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill).

`LocalAgentRuntime.runAgent` forwards the separate `AgentRunOptions` to adapters. Each adapter must implement its process/API cancellation using those controls; this wrapper does not claim that an arbitrary adapter can be forcibly interrupted.
