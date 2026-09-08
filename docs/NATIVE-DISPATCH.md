# Native Project dispatch acceptance

P0.10 proves the local Project → daemon → native Codex → Verifier → separate result client path. Native Codex must already be installed and logged in through its normal client. Veyra probes readiness through supported commands and never reads or copies credentials. No API planner/reviewer or `OPENAI_API_KEY` is required.

```sh
pnpm build
env -u OPENAI_API_KEY pnpm --filter @veyraoss/cli smoke:native
# Optional exact executable:
env -u OPENAI_API_KEY pnpm --filter @veyraoss/cli smoke:native /absolute/path/to/codex
```

This command is explicit opt-in to real native model usage and is excluded from `pnpm test`. It always creates a disposable local Git fixture. It never accepts an existing project as an execution target. It registers and binds that Project through the actual CLI, starts a separate production CLI daemon, sends a canonical handoff over IPC, and waits with bounded non-busy polling. Another process fetches the result over IPC and resolves its Verifier references against persisted Core events.

The fixture starts with a failing greeting test. Codex may change only `src/message.js`. Veyra then runs the protected test, syntax/build commands, and `git diff --no-ext-diff --no-textconv`. The smoke requires matching test/build/diff evidence, a safe Project/run-bound native session reference, the expected changed-file set and build artifact, unchanged protected content, and regular unlinked fixture files. Model claims alone cannot make the smoke pass. The Git patch is retained as the actual diff command's Core Verifier output; the envelope's adapter-reported file summary remains labelled `executor`.

There are no automatic model retries. Native dispatch is bounded by the daemon's 120-second invocation timeout and the smoke's 180-second overall deadline. Interruption cancels the run, stops the owned daemon and removes the disposable fixture on success or failure. The terminal JSON report contains IDs and acceptance evidence, not credentials or chat history. Native-owned history stays native-owned. Publication, push and deployment are forbidden in the fixture instructions and are never called by the harness.

Default tests use the same harness with an explicit fake executable, covering success, verifier failure despite a success claim, protected-file tampering, symlink substitution and cancellation. Those tests establish harness behavior; only the opt-in command proves real native execution. This gate does not claim a ChatGPT bridge or the later review/fix loop.

## Project-owned checks for native dispatch

A bound executor without requested checks still needs only `.veyra/project.yaml`. When a handoff requests verification, the CLI loads that Project's local `veyra.yaml` and referenced workflow solely for trusted command definitions and its existing approval policy. It constructs a native executor followed by the requested command steps in order. It does not construct that config's planner/reviewer agents or require their API keys. Checks cannot introduce commands from a bridge payload.

For example, a local workflow with no API agents:

```yaml
# veyra.yaml
version: 1
agents: {}
workflow:
  use: ./checks.yaml
```

```yaml
# checks.yaml
version: 1
name: project-checks
start: test
steps:
  test:
    type: command
    run: [node --test]
    timeoutMs: 10000
    next: build
  build:
    type: command
    run: [node --check src/message.js, node scripts/build.mjs]
    timeoutMs: 10000
```

The handoff selects `requestedVerification: [{ id: "test", kind: "test" }, { id: "build", kind: "build" }]`. The host snapshots those commands before native execution and preserves their timeouts plus the local approval policy; it does not import their workflow branching or retry rules into the native slice. The step ID `execute` is reserved for the bound executor. Native sessions run in the bound canonical Project root; explicit worktree configurations are refused instead of silently weakening that isolation choice. Existing optional workflow execution remains available through `ve run --config ...`.
