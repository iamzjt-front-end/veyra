# Testing

Run `pnpm check` for strict TypeScript checks on production code, tests, and test helpers. Run `pnpm test` for the workspace suites followed by the shared helper and integration suites. Default tests must not call live provider APIs, require API keys, or depend on a logged-in agent CLI.

## Test placement

- Unit tests belong in the owning package's `test/` directory as `*.test.ts`. Keep pure logic and adapter normalization tests here; inject fakes for external providers.
- Package integration tests use `*.integration.test.ts` in the same directory and exercise real local boundaries such as subprocesses or persistence.
- Tests spanning packages belong in `test/integration/` or `test/e2e/`, using `*.test.ts`. E2E tests exercise public surfaces with fake providers by default.
- Shared test utilities live in `test/helpers/`. They are development code and must never be imported by production sources.
- Live provider smoke tests must use an explicit opt-in entry point outside default test discovery when their TODO is implemented.

Every workspace already has a Vitest test script. The shared `vitest.config.ts` discovers `test/**/*.test.ts` relative to each invocation's working directory: package scripts find their owned tests, and the root invocation finds shared tests while excluding fixture projects. `tsconfig.test.json` checks tests without emitting files into package builds. Turbo invalidates cached tasks when shared helpers or fixtures change. Default tests do not generate coverage reports.

Core's package test script limits Vitest to four workers because its integration suites exercise synced filesystem writes and process-death recovery. The real-Git workspace suites use a 30-second per-test bound to accommodate multiple subprocesses under concurrent load. These limits leave behavioral assertions intact; time-sensitive Runtime tests retain their explicit execution deadlines.

The [platform matrix](PLATFORMS.md) runs the complete default suite on macOS arm64 and Linux x64 with Node.js 22. Runtime/Verifier integration tests cover literal arguments, spaces/Unicode in working directories and script paths, Git worktree subdirectory mapping, POSIX quoting/pipelines/redirection, and command failure ordering. Platform unit tests check Windows shell selection and taskkill orchestration without claiming native Windows support.

## Deterministic agents

`FakeAgent` implements `@veyra/protocol`'s `AgentAdapter`. Construct it with the exact `AgentResult` a scenario needs. Each run returns a copy of that result and records a copy of its input in `calls`, so mutation in one assertion cannot change a later response. No provider SDK or credentials are involved.

## Disposable workspaces

`test/fixtures/minimal-project` is a dependency-free Node.js project with a greeting function and a built-in Node test. It can run `node --test` and `node --check src/message.js` without installing dependencies.

Use `withFixtureWorkspace(async (workspace) => { ... })` from `test/helpers/workspace.ts` to copy this project to a unique directory under the OS temporary directory. It removes the copy on both success and failure. Tests needing explicit lifetime control can call `createFixtureWorkspace()` and invoke `cleanup()` in `finally` or `afterEach`; cleanup is safe to call more than once.

Only mutate the temporary copy. Do not run agents or mutating tests against the committed fixture or the developer's repository. Give subprocesses explicit working directories and timeouts, and check their exit status. Never write secrets into fixtures or test output.

Core's crash suites use disposable child processes and real `SIGKILL` at completed/uncertain attempts, during recovery reconciliation, and immediately before/after the store's actual rename. They verify persisted attempt identity and single filesystem mutations, preserve torn history, and refuse live/unknown owners. POSIX signal-specific cases are skipped on Windows; Windows-specific verification remains tracked separately. See [the recovery contract](CRASH-RECOVERY.md).

Concurrency suites exercise independent Node processes contending for tickets, including simultaneous recovery of a killed owner, cross-process event sequences and state revisions, readers waiting through a deliberately split append, duplicate approvals, stale resumes, and two active isolated worktrees. Additional process-death tests cover approval and terminal worktree cleanup with explicit recovery. See [the locking contract](LOCKING.md).

Cancellation suites cover adapters/verifiers that throw on abort, first-cause deadline ordering, cancellation at persisted event boundaries, nested parallel child draining, terminal error validation/redaction, and real CLI repeated SIGINT/SIGTERM against a process tree that ignores SIGTERM. The CLI checks inspect saved state from a new process and confirm successor commands did not execute.

Artifact/retention suites verify bounded inline and CLI records, complete redacted payload restoration in a fresh process, preserved named inputs across pause/resume, producer/digest metadata, corrupt/missing/symlinked payload refusal, and a real crash between payload publication and log append. Cleanup uses disposable histories and Git worktrees: preview/default protection, explicit deletion, concurrent control/selection, external-path preservation and failure after moving history to trash are covered. No cleanup test targets developer run history.

Prompt provenance tests inspect separate captured project/workflow/role/group sources, forged trust claims inside agent/research output, actual failed command evidence, mapping/retry/eviction references, human gate/resume snapshots, router source events and judge inputs. Runtime fixtures cover missing, oversized, invalid UTF-8 and linked project rules. Root tests exercise source-boundary guidance in every official API/native prompt builder without live model calls.

## End-to-end CLI scenarios

`test/e2e/vertical-slice.test.ts` exercises the complete built-in dev workflow through the CLI application in real, separate Node.js processes. `cli-harness.ts` supplies deterministic adapters through the existing service interface; it is test code and adds no production fake-provider switch. The fixture executor edits actual source files, while the real shell verifier runs `pnpm check`, `pnpm test`, and `pnpm build`. The disposable copy adds a dependency-free build script and expects the new greeting; the committed fixture stays unchanged.

The suite covers success, one verifier repair, one reviewer repair, exhausted retries, explicit human approval, recovery after an owner exits at a completed checkpoint, invalid configuration, a missing real Codex executable, and persisted provider failure. Status/review/resume run in new processes; assertions inspect saved state/events and the fixture's actual build output. Known provider key variables are removed from child environments, and no live provider or Codex login is used. Fixtures are removed in `finally`, including failed tests.

After dependencies and workspace builds are available, run just these scenarios with:

```bash
pnpm exec vitest run test/e2e/vertical-slice.test.ts --config vitest.config.ts
```

They also run in the default `pnpm test` suite and CI. Each scenario has a 60-second test deadline and each CLI process has a 45-second execution timeout; these are bounds, not sleeps.

The separate [real closed-loop smoke](LIVE_SMOKE.md) uses `VEYRA_LIVE_SMOKE=1 pnpm smoke:live` and existing credentials. Its manual entry point is excluded from default test discovery. Tests of that smoke's setup, guards, and cleanup inject fake providers and remain safe in normal CI.
