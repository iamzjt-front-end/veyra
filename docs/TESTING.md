# Testing

Run `pnpm check` for strict TypeScript checks on production code, tests, and test helpers. Run `pnpm test` for the workspace suites followed by the shared helper and integration suites. Default tests must not call live provider APIs, require API keys, or depend on a logged-in agent CLI.

## Test placement

- Unit tests belong in the owning package's `test/` directory as `*.test.ts`. Keep pure logic and adapter normalization tests here; inject fakes for external providers.
- Package integration tests use `*.integration.test.ts` in the same directory and exercise real local boundaries such as subprocesses or persistence.
- Tests spanning packages belong in `test/integration/` or `test/e2e/`, using `*.test.ts`. E2E tests exercise public surfaces with fake providers by default.
- Shared test utilities live in `test/helpers/`. They are development code and must never be imported by production sources.
- Live provider smoke tests must use an explicit opt-in entry point outside default test discovery when their TODO is implemented.

Every workspace already has a Vitest test script. The shared `vitest.config.ts` discovers `test/**/*.test.ts` relative to each invocation's working directory: package scripts find their owned tests, and the root invocation finds shared tests while excluding fixture projects. `tsconfig.test.json` checks tests without emitting files into package builds. Turbo invalidates cached tasks when shared helpers or fixtures change. Default tests do not generate coverage reports.

## Deterministic agents

`FakeAgent` implements `@veyra/protocol`'s `AgentAdapter`. Construct it with the exact `AgentResult` a scenario needs. Each run returns a copy of that result and records a copy of its input in `calls`, so mutation in one assertion cannot change a later response. No provider SDK or credentials are involved.

## Disposable workspaces

`test/fixtures/minimal-project` is a dependency-free Node.js project with a greeting function and a built-in Node test. It can run `node --test` and `node --check src/message.js` without installing dependencies.

Use `withFixtureWorkspace(async (workspace) => { ... })` from `test/helpers/workspace.ts` to copy this project to a unique directory under the OS temporary directory. It removes the copy on both success and failure. Tests needing explicit lifetime control can call `createFixtureWorkspace()` and invoke `cleanup()` in `finally` or `afterEach`; cleanup is safe to call more than once.

Only mutate the temporary copy. Do not run agents or mutating tests against the committed fixture or the developer's repository. Give subprocesses explicit working directories and timeouts, and check their exit status. Never write secrets into fixtures or test output.
