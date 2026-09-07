# Deterministic verification

`@veyra/verifier` implements `ShellVerifier` using the local process runner. It checks command exit status; LLM review is a separate agent step.

```ts
import { ShellVerifier } from "@veyra/verifier";

const verifier = new ShellVerifier({ emit: (event) => console.log(event) });
const report = await verifier.verify({
  commands: ["pnpm check", "pnpm test", "pnpm build"],
  cwd: "/path/to/project",
  execution: { runId: "run-1", stepId: "verify", attempt: 1 },
});
```

Commands run sequentially and stop at the first failure. The report contains aggregate `success`, total duration, and one `VerificationResult` per attempted command. Skipped commands have no invented results. An empty list succeeds without starting a process; blank individual commands are rejected. The default timeout is five minutes per command and may be overridden with `timeoutMs`. Requests also accept an abort signal, environment overrides, and the runtime's per-stream `maxOutputBytes` limit (default 1 MiB).

Each command result records exit code (or `null` when unavailable), optional termination signal, duration, bounded stdout/stderr, truncation flags, and optional normalized failure details. Timeout or cancellation always fails verification, including when a shutdown handler returns zero. Unexpected runner exceptions become a safe structured failure rather than exposing raw exception text.

An injected `EventSink` receives `verification.started` and `verification.completed` from the shared protocol. Event emission requires execution metadata, so events always identify their run and step. A verifier used without an event sink may omit metadata. Event-sink failures propagate: verification must not silently continue when its event/persistence consumer fails.

Shell command text is intentional here: POSIX uses `/bin/sh -c`, and Windows uses `cmd.exe /d /s /c`. Commands come from trusted workflow configuration. Never interpolate an untrusted goal, agent response, or credential into a command. Environment values are passed to the runtime and are not included in results/events. Command text and output are evidence, so callers must also avoid secrets there and apply redaction where needed. See [runtime limits and cancellation behavior](RUNTIME.md).

Core integration and workflow scheduling remain separate TODO items. Loading the `verify` step's `run` array and passing it to `ShellVerifier.verify` is already supported.
