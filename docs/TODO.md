# Veyra Master TODO

> **One goal. Many agents. Verified execution.**
>
> This is the canonical implementation plan for Veyra. `docs/ROADMAP.md` describes milestones at a high level; this file defines the concrete execution order for Codex and other coding agents.

Read [AGENTS.md](../AGENTS.md) for coding rules and [ARCHITECTURE](ARCHITECTURE.md) for package boundaries before implementing a task. Use the [README](../README.md#development) for local setup and [ROADMAP](ROADMAP.md) for milestone summaries. The [Next task](#next-task) section below identifies the current entry point; each task's acceptance criteria define completion.

## How to use this file

### Execution rule

Work **top to bottom**. Unless the user explicitly changes priority, the next task is the first unchecked task whose dependencies are complete.

For each task:

1. Read `AGENTS.md`, `docs/ARCHITECTURE.md`, this file, and the files owned by the task.
2. Implement **only the current task and the minimum supporting changes required by it**.
3. Do not collapse package boundaries or move responsibilities between packages without explicit approval.
4. Add or update tests for the task.
5. Run the task-specific verification plus the repository baseline checks:
   ```bash
   pnpm check
   pnpm test
   pnpm build
   ```
6. If a check cannot run, report the exact blocker; do not silently skip it.
7. Update this TODO only after the acceptance criteria are satisfied.
8. Prefer one focused commit per TODO item. Suggested format: `feat(area): ...`, `fix(area): ...`, `test(area): ...`, `docs(area): ...`.
9. Stop after completing the requested TODO item unless the user explicitly asks to continue.

### Status markers

- `[ ]` not started
- `[-]` in progress / partially complete
- `[x]` complete and verified
- `[!]` blocked; add a short blocker note under the item

### Non-negotiable architecture rules

- The product name is **Veyra**; the public executable is **`ve`**.
- `veyra.yaml` and `.veyra/` remain brand-owned config/state names.
- `packages/core` is provider-neutral.
- Provider-specific code lives in `plugins/*`.
- Process lifecycle belongs in `packages/runtime`.
- Deterministic verification belongs in `packages/verifier`.
- LLM review and deterministic verification are separate concepts.
- CLI, TUI, and Dashboard consume the same state/event model.
- GPT + Codex is the first golden path, not a permanent architectural dependency.
- Do not introduce LangChain/LangGraph in the initial implementation unless a concrete need is demonstrated and approved.

---

# M0 — Repository baseline and engineering hygiene

Goal: make the scaffold reproducible, testable, and safe to evolve before connecting real agents.

## M0.1 — Establish a reproducible local baseline

**Status:** [x] Complete and verified.

**Depends on:** none

**Primary areas:** repository root, all current workspace packages

### Requirements

- [x] Run `corepack enable` and `pnpm install` locally.
- [x] Commit the generated `pnpm-lock.yaml`.
- [x] Confirm Node.js `>=20` and the declared pnpm version work.
- [x] Fix any existing TypeScript/build errors in the scaffold without changing architecture.
- [x] Confirm all workspace packages are detected by pnpm.
- [x] Confirm `pnpm ve -- doctor` runs from the repository root.
- [x] Confirm `ve` is the only public executable name in `apps/cli/package.json`.

### Acceptance criteria

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm ve -- doctor
```

All commands pass on a clean checkout after dependencies are installed.

Verified in a clean temporary Git worktree with Node.js 22.22.0, Corepack 0.34.7, and pnpm 10.15.1. All five commands passed; `check`, `test`, and `build` also passed with `TURBO_FORCE=true` after removing build outputs. pnpm detected all 11 workspace packages plus the root. Three CLI regression tests passed. Corepack 0.30.0 initially failed with `Cannot find matching keyid`; updating the local Corepack installation resolved it.

### Deliverables

- `pnpm-lock.yaml`
- any minimal scaffold fixes required for a clean build

---

## M0.2 — Add formatting and linting

**Status:** [x] Complete and verified.

**Depends on:** M0.1

**Primary areas:** root tooling/config

### Requirements

- [x] Choose one lightweight formatter/linter setup for TypeScript/JSON/Markdown; prefer a single tool where practical.
- [x] Add root scripts: `lint`, `format`, `format:check`.
- [x] Do not replace TypeScript type-checking with linting; both remain separate.
- [x] Ignore generated directories (`dist`, `coverage`, `.turbo`, `.veyra/runs`, etc.).
- [x] Format the existing repository once.

### Acceptance criteria

```bash
pnpm lint
pnpm format:check
pnpm check
```

All pass with no manual cleanup required.

Verified `pnpm lint`, `pnpm format:check`, `pnpm check`, `pnpm test`, and `pnpm build`. Biome 2.5.12 supplies lint rules; Prettier 3.9.6 supplies formatting including Markdown/YAML. Temporary negative probes confirmed unused code and unformatted TypeScript/JSON/Markdown fail, while generated directories are ignored by both tools. All probe files were removed.

---

## M0.3 — Add CI for pull requests and main

**Status:** [x] Complete and verified.

**Depends on:** M0.1, M0.2

**Primary areas:** `.github/workflows/`

### Requirements

- [x] Add a CI workflow for pushes to `main` and pull requests.
- [x] Use the Node version supported by the repository and Corepack/pnpm cache.
- [x] Run install with a frozen lockfile.
- [x] Run `lint`, `format:check`, `check`, `test`, `build`.
- [x] Avoid provider/API integration tests in normal CI.
- [x] Keep secrets out of the workflow.

### Acceptance criteria

A PR with valid code gets green CI; a deliberate type error or failing test makes CI fail.

Verified the full local baseline and hosted GitHub Actions on temporary validation PR #1: [valid code passed](https://github.com/iamzjt-front-end/veyra/actions/runs/34146701083), and [a deliberate type error failed](https://github.com/iamzjt-front-end/veyra/actions/runs/34146796260) at `Check types` with `TS2322: Type 'number' is not assignable to type 'string'`. The negative probe exists only on the temporary validation branch, never in the implementation branch. Actions are pinned to verified release commit SHAs; the workflow uses Node.js 22, Corepack 0.34.7, the declared pnpm version, and read-only repository permissions.

---

## M0.4 — Establish test conventions and fixtures

**Status:** [x] Complete and verified.

**Depends on:** M0.1

**Primary areas:** packages/apps tests, `examples/`, optional `test/fixtures/`

### Requirements

- [x] Define unit vs integration vs end-to-end test conventions.
- [x] Create at least one minimal fixture project that Veyra may safely modify during tests.
- [x] Create reusable fake/mock `AgentAdapter` implementations for deterministic tests.
- [x] Tests must never require an OpenAI key or a logged-in Codex CLI by default.
- [x] Temporary test state must be isolated and cleaned up.

### Acceptance criteria

- A mock agent can produce a deterministic `AgentResult`.
- A test can create and destroy an isolated fixture workspace.

Verified frozen install and the full five-command baseline; `pnpm test` passed with `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GEMINI_API_KEY` unset (eight Vitest tests plus the fixture's Node test). Tests cover deterministic response/input copies, a configured failure, independent mutable workspaces, and cleanup after success/failure. Root test helpers use ESM and strict TypeScript checks, and shared fixture changes invalidate Turbo caches. Conventions are documented in `docs/TESTING.md`.

---

## M0.5 — Make the docs hierarchy explicit

**Status:** [x] Complete and verified.

**Depends on:** M0.1

### Requirements

- [x] `README.md` = product overview and getting started.
- [x] `docs/ARCHITECTURE.md` = stable architectural boundaries.
- [x] `docs/ROADMAP.md` = milestone summary.
- [x] `docs/TODO.md` = canonical detailed execution plan.
- [x] `AGENTS.md` = coding-agent rules.
- [x] Cross-link these documents so contributors know where to look.

### Acceptance criteria

A new contributor can identify the next task and architectural constraints without reading commit history.

Verified all 27 relative links and anchors across the five source-of-truth documents. Each document identifies its purpose and directs contributors to setup, architectural rules, the canonical TODO, and milestone summaries. The full five-command repository baseline passed.

---

# M1 — v0.1 working vertical slice

Goal: make the first real end-to-end workflow work locally:

```text
Goal
  ↓
OpenAI Planner
  ↓
Codex Executor
  ↓
Deterministic Verifier
  ↓
OpenAI Reviewer
  ↓
PASS → complete
FAIL → Codex fix → verify → review
```

The v0.1 implementation should favor transparency and reliability over abstraction.

## M1.1 — Define and load `veyra.yaml`

**Status:** [x] Complete and verified.

**Depends on:** M0.1

**Primary area:** `packages/config`

### Requirements

- [x] Add YAML parsing dependency.
- [x] Add runtime validation for config data; do not trust parsed YAML types.
- [x] Define config schema version (`version: 1`).
- [x] Support at minimum:
  - project name
  - workflow preset/path
  - named agents (`planner`, `executor`, `reviewer`)
  - provider name
  - optional model
  - provider options
  - runtime max-fix-iterations
  - runtime state directory
  - approval policy
- [x] Add defaults for optional values.
- [x] Reject unknown/invalid critical fields with actionable messages.
- [x] Never store API secrets in generated config.
- [x] Expose `loadConfig(path)` and a pure `parseConfig(value)` for testing.

### Tests

- valid minimal config
- valid full config
- missing required field
- unsupported version
- malformed YAML
- incorrect field types
- default values

### Acceptance criteria

A fixture `veyra.yaml` can be loaded into a typed `VeyraConfig`, and invalid input produces human-readable errors with the config path/field.

Verified 48 config tests covering minimal/full inputs, defaults, invalid fields/types/versions, malformed YAML, file diagnostics, immutable copies, and invalid provider option data. Frozen install and all five baseline commands passed (56 Vitest tests total). The compiled package also loaded `veyra.example.yaml` directly with Node.js. `docs/CONFIGURATION.md` documents the schema; config loading performs no writes or provider calls, and diagnostics omit source values.

---

## M1.2 — Load and validate workflow YAML

**Status:** [x] Complete and verified.

**Depends on:** M1.1

**Primary area:** `packages/workflow`

### Requirements

- [x] Add a loader for built-in and user-supplied workflow YAML.
- [x] Keep workflow parsing separate from config parsing.
- [x] Validate `name`, `version`, `start`, and step map.
- [x] For v0.1, support these executable step types only:
  - `agent`
  - `command`
  - `human`
  - `end`
- [x] `parallel`, `router`, and `subworkflow` remain schema-reserved/planned; return a clear unsupported-in-v0.1 error if encountered.
- [x] Validate all transition destinations.
- [x] Detect an obviously invalid start node and missing transition targets.
- [x] Define how outcomes map to transitions (`success`, `failure`, `pass`, `fail`, `approved`, `rejected`, etc.).

### Tests

- load `workflows/dev.yaml`
- missing start step
- transition to missing step
- unsupported node type in v0.1
- invalid retry configuration

### Acceptance criteria

`workflows/dev.yaml` can be parsed and validated without Core needing to know YAML details.

Verified 53 workflow tests covering all four built-in presets, user paths, graph/node validation, reserved nodes, retry settings, exact outcome mapping, prototype-safe destination checks, independent copies, and file/YAML errors. Frozen install and all five baseline commands passed (109 Vitest tests total). The compiled package loaded all four presets with an unrelated working directory. `docs/WORKFLOWS.md` documents schema and transition semantics; no execution or retry enforcement was added in this task.

---

## M1.3 — Harden provider-neutral protocol contracts

**Status:** [x] Complete and verified.

**Depends on:** M1.1, M1.2

**Primary area:** `packages/protocol`

### Requirements

- [x] Review `AgentInput`, `AgentResult`, `ArtifactRef`, `VerificationResult`, `VeyraEvent` for the vertical slice.
- [x] Add run/step metadata needed for resumability and traceability without provider fields leaking into common contracts.
- [x] Add structured usage metadata support (tokens/cost fields optional and provider-neutral).
- [x] Add event types needed by real execution:
  - agent started/completed/failed
  - verification started/completed
  - run paused/resumed
  - approval required/resolved
  - process/log output reference if needed
- [x] Prefer serializable types; state/events must be JSON-compatible.
- [x] Define a stable error representation for persisted failures.
- [x] Avoid giant free-form provider payloads in persisted core state; provider-specific diagnostics may go under optional metadata/artifacts.

### Acceptance criteria

Mock OpenAI, Codex, Verifier, Core, CLI, and future TUI can communicate using these contracts without importing one another.

Verified 26 protocol tests covering provider-neutral adapters, normalized results, lifecycle events, JSON round trips, and rejection of non-JSON data. Compile-time negative checks reject functions, native errors, and persisted abort signals. All existing consumers compile; `pnpm lint`, `pnpm format:check`, `pnpm check`, `pnpm test` (135 tests), and `pnpm build` passed. Public contracts and serialization responsibilities are documented in `docs/PROTOCOL.md` and re-exported through the SDK.

---

## M1.4 — Implement local process runtime

**Status:** [x] Complete and verified.

**Depends on:** M1.3

**Primary area:** `packages/runtime`

### Requirements

- [x] Implement a reusable local process runner.
- [x] Input must support executable, argv array, cwd, environment overrides, timeout, abort signal.
- [x] Do not construct shell strings when argv execution is sufficient.
- [x] Capture exit code, signal, stdout, stderr, duration.
- [x] Support streaming stdout/stderr callbacks/events while still retaining final output.
- [x] Handle executable-not-found with a clear typed error.
- [x] Handle timeout and cancellation cleanly.
- [x] Ensure child processes do not remain orphaned after cancellation where platform APIs permit.
- [x] Add a maximum retained-output strategy or documented limit to avoid unbounded memory for long agent sessions.
- [x] Do not add provider-specific behavior here.

### Tests

- successful process
- non-zero exit
- stdout/stderr capture
- cwd behavior
- env override
- timeout
- cancellation
- executable missing

### Acceptance criteria

`packages/runtime` can execute a generic local command safely enough for Codex and verifier adapters to build on.

Verified 20 runtime tests with real generic Node processes: arguments, cwd/environment, both streams, UTF-8 boundaries, bounded retention, nonzero exits, missing executable, invalid limits, timeout/cancel, callback failure cleanup, and POSIX descendant termination after the leader exits. All five baseline commands passed (155 tests). `docs/RUNTIME.md` documents the 1 MiB per-stream default and platform behavior. M1.5 subsequently added Windows process-tree cleanup needed for shell commands; native Windows validation remains pending.

---

## M1.5 — Implement deterministic shell verifier

**Status:** [x] Complete and verified.

**Depends on:** M1.4

**Primary area:** `packages/verifier`

### Requirements

- [x] Replace scaffold with a real `ShellVerifier` built on the runtime process runner.
- [x] Run verification commands sequentially by default.
- [x] Stop on first failure by default; allow future policy extension without implementing parallel verification yet.
- [x] Return one structured result per command plus aggregate success/failure.
- [x] Record duration and bounded stdout/stderr.
- [x] Emit verification events through an injected event sink or callback, not by importing Core.
- [x] Treat verification as objective execution; no LLM judgment here.

### Tests

- all commands pass
- first command fails
- later command fails
- empty command list
- timeout behavior

### Acceptance criteria

The `verify` node in `workflows/dev.yaml` can execute `pnpm check`, `pnpm test`, and `pnpm build` and produce a machine-readable aggregate result.

Verified 16 verifier tests for ordering, first/later failures, empty commands, timeout/cancel, error normalization, bounded output, and injected events. Loaded the real `dev` preset and executed its three verification commands through the compiled `ShellVerifier`: all returned exit 0, no output truncation, and a JSON-compatible successful report with started/completed events. Frozen install and all five baseline commands passed (173 tests). Minimal supporting changes add protocol truncation flags and Windows PID-scoped `taskkill /T /F` cleanup for shell descendants, covered by two mocked runtime tests; native Windows validation remains pending. See `docs/VERIFICATION.md`.

---

## M1.6 — Implement persistent local run state

**Status:** [x] Complete and verified.

**Depends on:** M1.3

**Primary area:** preferably `packages/core` persistence boundary or a small internal module owned by Core; do not create a new top-level package without approval

### Required on-disk layout

```text
.veyra/
  state/
    active.json
  runs/
    <run-id>/
      input.json
      state.json
      events.jsonl
      artifacts/
```

### Requirements

- [x] Generate collision-resistant run IDs.
- [x] Persist original goal/input.
- [x] Persist current step, status, retry counts, timestamps, last outcome.
- [x] Append structured events to JSONL.
- [x] Use atomic write/rename strategy for mutable JSON state where practical.
- [x] Ensure parent directories are created automatically.
- [x] Provide read/list/load APIs needed by `status`, `review`, and `resume`.
- [x] Do not persist API keys or raw environment secrets.
- [x] Define behavior for corrupt/incomplete state files with actionable errors.
- [x] Make state directory configurable; default `.veyra`.

### Tests

- create run
- update run
- append/read events
- reload after process restart
- active run pointer
- corrupted state handling

### Acceptance criteria

A run can stop after one step, the Node process can exit, and a new process can load enough information to know the run status and next step.

Verified 41 Core persistence/event tests: complete layout, atomic snapshot visibility, unique IDs, active selection, ordered events, secret filtering, corrupt/incomplete files, malformed payloads, and path/symlink rejection. A writer Node process persisted one completed step and a paused next step, exited, and a second Node process recovered input, status, retries, next step, and events. All five baseline commands passed (214 tests). `docs/STATE.md` documents the Core-owned store, JSON record limit, explicit single-writer constraint, and non-transactional recovery boundaries. No orchestration behavior was advanced in this task.

---

## M1.7 — Implement OpenAI reasoning adapter

**Status:** [x] Complete and verified.

**Depends on:** M1.3

**Primary area:** `plugins/openai`

### Requirements

- [x] Use the official OpenAI SDK and the current Responses API.
- [x] API key is read from standard environment/config indirection; never stored in `.veyra` state.
- [x] Model is configurable; do not hard-code a single model as an architectural dependency.
- [x] Implement `AgentAdapter.run()` for planner/reviewer roles.
- [x] Build a role-aware system/developer instruction boundary that includes goal, current step, relevant prior artifacts/results, and explicit requested output shape.
- [x] Prefer structured output / JSON schema where supported so planner/reviewer outcomes are parseable.
- [x] Normalize provider output into `AgentResult`.
- [x] Capture optional token/usage metadata.
- [x] Add timeout/cancellation support where SDK allows.
- [x] Redact secrets from errors/logs.
- [x] Unit tests use a mocked SDK/client; no network in normal test suite.

### Planner output should minimally express

- summary
- concrete task/instructions for executor
- acceptance criteria
- optional artifacts/context

### Reviewer output should minimally express

- `pass` or `fail`
- summary/reasoning suitable for the executor
- required fixes when failed
- evidence references when available

### Acceptance criteria

With a mocked OpenAI client, planner and reviewer inputs produce validated, normalized `AgentResult` objects. A real integration smoke test can be run manually when credentials are present.

Verified 36 adapter tests, including the official SDK with mocked HTTP, planner/reviewer schemas and artifact references, refusal/incomplete handling, cancellation/timeout, usage, options validation, and redacted diagnostics. Frozen install and all five baseline commands passed (250 tests). SDK 6.49.0 preserves Node 20 compatibility while using the documented Responses API. The opt-in command `pnpm --filter @veyraoss/openai smoke -- <model>` is implemented and excluded from CI; its missing-key preflight returned exit 2 with setup guidance. `OPENAI_API_KEY` is unavailable in this environment, so no live API success is claimed; the task's required mocked acceptance passes. See `docs/OPENAI.md`.

---

## M1.8 — Implement Codex CLI executor adapter

**Status:** [x] Complete and verified.

**Depends on:** M1.4, M1.3

**Primary area:** `plugins/codex`

### Requirements

- [x] Implement **CLI mode first**; SDK mode may remain planned.
- [x] Detect whether the `codex` executable is available.
- [x] Before coding the final invocation, inspect the currently installed Codex CLI help/version rather than assuming stale flags.
- [x] Run Codex in the target repository working directory through `packages/runtime`.
- [x] Convert planner/fix instructions into a clear execution prompt.
- [x] Preserve user/project `AGENTS.md` instructions.
- [x] Capture Codex stdout/stderr and exit metadata.
- [x] Normalize completion into `AgentResult`.
- [x] Do not parse fragile human terminal formatting when a supported structured/non-interactive output mode is available.
- [x] Support cancellation and timeout.
- [x] Do not manage/store the user's Codex login token; rely on the installed Codex authentication mechanism.
- [x] Add a `doctor` capability check for executable/version/auth readiness where detectable without destructive actions.

### Tests

- mocked runtime success
- executable missing
- non-zero exit
- timeout/cancel
- prompt construction preserves goal/task/context

### Acceptance criteria

Given a deterministic mocked Codex process result, the adapter returns a valid `AgentResult`; when a real logged-in Codex CLI is available, a manual smoke test can modify a disposable fixture repository.

Verified 40 mocked adapter/JSONL tests plus three supporting runtime stdin tests. Installed `codex-cli 0.153.4` help/version and read-only login status were inspected before finalizing invocation. `pnpm --filter @veyraoss/codex smoke` passed with the real logged-in CLI: only `src/message.js` changed, project instructions remained unchanged, syntax/tests passed, and the disposable Git repository was removed. The runtime stdin primitive is necessary to pass prompts without shell interpolation or argument-length limits. Frozen install and all five baseline commands passed (293 tests). See `docs/CODEX.md`.

---

## M1.9 — Implement the v0.1 Core orchestration loop

**Status:** [x] Complete and verified.

**Depends on:** M1.2–M1.8

**Primary area:** `packages/core`

### Requirements

- [x] Core receives already-loaded config/workflow/providers; it does not parse YAML or instantiate vendor SDKs directly.
- [x] Execute `agent`, `command`, `human`, and `end` steps.
- [x] Resolve transitions through `packages/workflow`.
- [x] Persist state before/after meaningful transitions.
- [x] Emit structured events for run and step lifecycle.
- [x] Pass relevant previous outputs/artifacts to later steps without dumping unlimited historical text.
- [x] Convert verifier aggregate result into workflow outcome (`success`/`failure`).
- [x] Convert reviewer output into `pass`/`fail` outcome.
- [x] End with clear run status: completed, failed, paused.
- [x] Ensure thrown provider/runtime errors become persisted run failures with useful context.
- [x] No direct imports from `plugins/openai` or `plugins/codex`.

### Tests

Use mock adapters/verifier to test:

- happy path plan → execute → verify → review → done
- verification failure routes to fix
- reviewer failure routes to fix
- provider error fails run cleanly
- missing adapter produces actionable error

### Acceptance criteria

The whole default dev workflow executes deterministically using mocks and produces persisted state/events.

Verified 21 Core orchestration integration tests and three bounded-context tests: the unchanged default dev workflow, verifier/reviewer repair routes, missing adapters, thrown/invalid results, redacted persisted evidence, pauses, cancellation, subscriber isolation, and a real fixture shell check. Frozen install and all five baseline commands passed (317 tests). Core uses injected protocol adapters plus runtime/verifier/store and has no concrete provider imports. The fixed execution backstop is a minimal safety prerequisite; configurable repair limits and approval resolution remain M1.10/M1.11. See `docs/CORE.md`.

---

## M1.10 — Enforce repair-loop retry limits

**Status:** [x] Complete and verified.

**Depends on:** M1.9

**Primary areas:** `packages/core`, `packages/workflow`

### Requirements

- [x] Track retry count per relevant step/loop, not one ambiguous global counter.
- [x] Respect workflow retry max and/or runtime default according to documented precedence.
- [x] Avoid infinite loops even with malformed workflows.
- [x] When max retries are reached, fail or pause according to documented v0.1 policy; default should be fail with clear reason unless a human gate explicitly handles it.
- [x] Persist retry state across `resume`.
- [x] Emit retry-related event/metadata.

### Tests

- succeeds before max
- reaches max and stops
- retry count survives reload/resume

### Acceptance criteria

A workflow that repeatedly fails cannot run forever.

Verified seven workflow retry tests, nine Core retry/resume integration tests, and updated protocol event validation. Repeated failures and success cycles stop; default dev allows exactly three fix calls; explicit exhaustion gates pause; counters and effective limits survive a real writer-process exit and multiple new-engine resumes even with changed config. All five baseline commands passed (335 tests). The minimal paused-agent resume API is needed for this task’s persistence acceptance; human approval resolution remains M1.11. See `docs/WORKFLOWS.md` and `docs/CORE.md`.

---

## M1.11 — Implement human approval nodes

**Status:** [x] Complete and verified.

**Depends on:** M1.9, M1.6

**Primary areas:** `packages/core`, `packages/workflow`, `packages/protocol`

### Requirements

- [x] `human` step pauses the run and emits `approval.required`.
- [x] Persist approval message/context.
- [x] Support approved/rejected outcomes.
- [x] Approval resolution must be explicit and auditable in events.
- [x] A paused process may exit safely; later `resume` continues from persisted state.
- [x] Core API should expose a way for CLI/TUI/Dashboard to resolve approval without UI-specific logic inside Core.

### Tests

- pause at gate
- approve then resume
- reject branch
- restart process between pause and approval

### Acceptance criteria

A real workflow can stop before a risky step and continue only after explicit user approval.

Verified ten approval integration tests, including explicit approve/resume, rejected branches, rejection without a branch, stale/duplicate IDs, consecutive gates, competing submissions within one engine, comment redaction, and notification failure after a durable decision. A real writer process exited at a gate; a separate caller approved it, and a fresh engine created the disposable fixture marker only on resume. All five baseline commands passed (345 tests). Approval logic remains in Core; cross-process locking and partial-transition recovery remain later hardening tasks. See `docs/APPROVALS.md`.

---

## M1.12 — Implement CLI application commands

**Status:** [x] Complete and verified.

**Depends on:** M1.1–M1.11

**Primary area:** `apps/cli`

The public executable is **`ve`**.

### `ve init`

- [x] Detect existing `veyra.yaml` and avoid destructive overwrite without confirmation/flag.
- [x] Generate a minimal working `veyra.yaml`.
- [x] Ensure `.veyra/` runtime directories are ignored appropriately without blindly modifying unrelated ignore rules.
- [x] Print next-step instructions.

### `ve run <goal>`

- [x] Require or intelligently load a workflow.
- [x] Load config, workflow, providers, state store.
- [x] Start a new run.
- [x] Print concise live events in headless CLI mode.
- [x] Return meaningful process exit code.
- [x] Support at least `--workflow`, `--config`, and `--non-interactive` if needed by implementation.

### `ve status`

- [x] Show active/latest run ID, status, current step, retry count, start/update times.
- [x] Support a run ID argument/flag.

### `ve review`

- [x] Show the latest reviewer result and relevant verification summary/artifact references.
- [x] Do not require rerunning an agent.

### `ve resume`

- [x] Load a paused/interrupted run and continue from persisted state.
- [x] Handle no resumable run gracefully.

### `ve doctor`

- [x] Node/pnpm/platform information.
- [x] Config validity when inside a Veyra project.
- [x] provider readiness: OpenAI env presence (without printing key), Codex executable/version, working directory permissions.
- [x] Clearly distinguish required vs optional provider readiness.

### CLI UX rules

- [x] Human-readable output by default.
- [x] Reserve/plan a machine-readable `--json` mode; implement in v0.1 if low-cost.
- [x] No ANSI assumptions when stdout is non-TTY.
- [x] Good error messages and non-zero exit codes.

### Acceptance criteria

The complete mock vertical slice can be driven using only `ve` commands.

Verified 14 CLI tests: command-handler-only mocked plan/gate/execute/verify/review flow; explicit approval and saved inspection; guarded init; config/argument failures; required/optional readiness; and a real command-only fixture through the public CLI process. Root `pnpm ve` now preserves the project working directory. Two Core child-process tests prove explicit recovery after a completed checkpoint without repeating its mutation, and refusal to rerun an unknown interrupted attempt. This narrow Core primitive is required for CLI interrupted resume; general crash recovery and locking remain later hardening work. Frozen install and all five baseline commands passed (358 tests). See `docs/CLI.md`.

---

## M1.13 — Add deterministic end-to-end tests

**Status:** [x] Complete and verified.

**Depends on:** M1.12

**Primary areas:** integration/e2e tests and fixture projects

### Required scenarios

- [x] happy path completes in one attempt
- [x] verifier fails once, executor fixes, then passes
- [x] reviewer fails once, executor fixes, then passes
- [x] max retries reached
- [x] human gate pauses and resumes
- [x] process restart/resume from persisted state
- [x] invalid config fails before provider execution
- [x] missing Codex executable produces actionable error
- [x] provider failure is persisted

### Acceptance criteria

All scenarios run without real network/provider credentials by using fake adapters and fixture repositories.

Verified all nine scenarios through separate CLI application processes and disposable fixture projects. The built-in dev preset runs real `pnpm check`, `pnpm test`, and `pnpm build`; repair tests mutate real source and inspect saved evidence/build output. Approval and interrupted-checkpoint resumes use a different process and preserve previous work. The missing-executable case uses the real Codex adapter with a guaranteed absent path. No live API or Codex login is used. All five baseline commands passed (367 tests). See `test/e2e/vertical-slice.test.ts` and `docs/TESTING.md`.

---

## M1.14 — Add opt-in real GPT + Codex integration smoke test

**Status:** [!] Live acceptance blocked; implementation and deterministic tooling tests verified.

**Depends on:** M1.13

### Requirements

- [x] Never run in default CI.
- [x] Require explicit environment flag/command.
- [x] Use a disposable fixture repository/worktree.
- [ ] Planner asks for a tiny deterministic change.
- [ ] Codex makes the change.
- [ ] Verifier checks it.
- [ ] Reviewer evaluates evidence.
- [x] Test cleans up or prints the retained fixture location for debugging.
- [x] Document approximate API use/cost considerations.

### Acceptance criteria

On a developer machine with OpenAI credentials and logged-in Codex CLI, one command demonstrates the real closed loop.

**Blocker (September 8, 2026):** `OPENAI_API_KEY` is absent from this task's environment. Attempted `VEYRA_LIVE_SMOKE=1 pnpm smoke:live`: the workspace build passed, then the smoke exited `2` with `Set OPENAI_API_KEY in the environment before running the live closed-loop smoke test.` No live provider request was made. To unblock, make a valid API key available through the environment and rerun that command with the installed, logged-in Codex CLI; optionally select an accessible Responses/structured-output model with `VEYRA_SMOKE_MODEL`. Do not paste or commit credentials.

The opt-in entry point, one-repair limit, disposable Git fixture, check/test/build verification, protected-file checks, usage report, cancellation, cleanup and optional retention are implemented. Five deterministic tooling tests pass, including a forged passing test being rejected and secret redaction in retained failure evidence. Running without the opt-in flag also exits `2` before provider checks. All five baseline commands passed (372 tests). This does not establish live planner/executor/reviewer success, so those requirements and this item remain open. See `docs/LIVE_SMOKE.md`.

M1.15 and the M2 foundation remain dependent on live v0.1 completion. M3.1 can proceed independently against the implemented workflow loader; no TUI foundation or live provider access is needed to document and validate its existing schema.

---

## M1.15 — v0.1 docs and example project

**Depends on:** M1.14

### Requirements

- [ ] README quick start is actually runnable.
- [ ] Add `examples/basic` working config/workflow example.
- [ ] Document provider setup without exposing secrets.
- [ ] Document `.veyra/` state layout.
- [ ] Document retry and human-gate behavior.
- [ ] Document current limitations explicitly.
- [ ] Update ROADMAP and this TODO based on verified implementation, not intention.

### v0.1 exit criteria

- [ ] clean install/build/test/lint CI
- [ ] `ve init` works
- [ ] `ve run` works with mocks
- [ ] real GPT → Codex → verifier → GPT smoke test works manually
- [ ] failures retry with bounded loop
- [ ] state survives restart
- [ ] human approval can pause/resume
- [ ] no provider secrets written to state/logs

---

# M2 — v0.2 interactive TUI / Agent Mission Control

Goal: make `ve` without arguments the primary interactive developer experience while preserving headless CLI behavior.

## M2.1 — Choose and establish the TUI rendering foundation

**Depends on:** v0.1 complete

**Primary area:** `apps/tui`

- [ ] Choose a maintained Node/TypeScript TUI approach compatible with the event model.
- [ ] Keep orchestration out of the TUI; consume Core APIs/events only.
- [ ] Add an internal UI state reducer/store derived from events and persisted run state.
- [ ] Handle terminal resize and non-supported terminals gracefully.
- [ ] Add a clean shutdown path that does not kill active child processes incorrectly.

### Acceptance criteria

A static TUI opens with real project/run status loaded from Core/state.

---

## M2.2 — Build the main TUI layout

- [ ] header: project, workflow, run ID, status, duration
- [ ] workflow progress panel
- [ ] agent/provider status panel
- [ ] current task/step panel
- [ ] event timeline
- [ ] footer with key bindings
- [ ] loading/empty/error states

### Acceptance criteria

A developer can understand what Veyra is doing without reading raw logs.

---

## M2.3 — Workflow graph/status visualization

- [ ] render sequential workflow cleanly
- [ ] states: pending/running/success/failure/paused/skipped
- [ ] show retry iteration
- [ ] make current step visually obvious
- [ ] design data model so later branching/parallel nodes can render without rewrite

---

## M2.4 — Event timeline and logs

- [ ] chronological timeline
- [ ] filter by agent/step/event severity
- [ ] inspect full event payload safely
- [ ] view bounded stdout/stderr/log artifact
- [ ] avoid freezing UI on high-volume output

---

## M2.5 — Review, verification, and diff views

- [ ] verification command/result view
- [ ] reviewer pass/fail view
- [ ] changed-file list
- [ ] git diff viewer with scrolling
- [ ] artifact viewer for text/JSON where practical

---

## M2.6 — Human approval UX

- [ ] clearly surface pending approval
- [ ] show reason/context before action
- [ ] approve/reject keyboard actions
- [ ] require explicit confirmation for high-risk operations if policy requests it
- [ ] write decision through Core API so it is persisted/audited

---

## M2.7 — Pause, resume, cancel, and navigation

- [ ] pause current workflow at safe boundary
- [ ] resume
- [ ] cancel with explicit semantics
- [ ] switch between recent runs
- [ ] quit TUI without corrupting run state

---

## M2.8 — TUI quality and regression tests

- [ ] reducer/state tests from event fixtures
- [ ] rendering snapshots only where stable/useful
- [ ] keyboard navigation tests
- [ ] terminal resize tests
- [ ] long log handling
- [ ] interrupted run display

### v0.2 exit criteria

- [ ] `ve` opens TUI
- [ ] `ve run ...` remains headless-friendly
- [ ] all v0.1 functions are observable/control-able from TUI where appropriate
- [ ] TUI does not contain orchestration business logic

---

# M3 — v0.3 Workflow DSL and orchestration features

Goal: turn the initial fixed loop into a general, declarative agent workflow engine.

## M3.1 — Versioned Workflow DSL schema

**Status:** [x] Complete and verified.

- [x] publish/document version 1 schema
- [x] strict validation with actionable paths/errors
- [x] forward-version rejection behavior
- [x] define compatibility policy
- [x] add schema examples

Verified 35 schema tests against Ajv and the runtime parser: all four presets, three editor-linked examples, invalid fields/types/nodes/retry limits, future-version rejection, unchanged data, and the graph-validation boundary. The schema is available as a local file/package subpath export; no package was published. Compatibility policy documents strict readers, additive changes, versioned semantic changes and saved-run stability. Frozen install and all five baseline commands passed (407 tests).

---

## M3.2 — Typed context and step outputs

**Status:** [x] Complete and verified.

- [x] define how step outputs are named and referenced
- [x] support safe template/context references in later step inputs
- [x] prevent accidental dumping of unlimited prior context
- [x] define artifact references vs inline data
- [x] persist resolved inputs for audit/debugging where safe

Verified named RFC 6901 references preserve JSON types, select bounded fields from older/larger outputs, use the latest attempt, and reject unavailable/oversized values before invocation. Agent/human selections survive saved-state resume; artifact contents are not loaded. Core records the exact redacted adapter envelope in `agent.input`, excluding ephemeral controls. Tests cover pointer escaping, prototype/getter safety, Unicode limits, secret redaction, audit immutability, approval/verification outputs and schema parity. Frozen install and all five baseline commands passed (445 tests). No shell interpolation or expression evaluator was added. See `docs/WORKFLOWS.md` and `examples/workflows/v1/inputs.yaml`.

---

## M3.3 — Conditional branching

**Status:** [x] Complete and verified.

- [x] richer outcome conditions beyond simple `on` string lookup if required
- [x] deterministic branch resolution
- [x] validation for unreachable/missing paths where feasible
- [x] tests for branch combinations

The existing exact `on` outcome branches and `next` fallback cover current workflow requirements; no richer condition language was needed. Added `analyzeWorkflow` for deterministic reachability diagnostics and validation of every destination, including unreachable branches. Three graph-analysis tests cover branch/fallback edges, cycles, prototype-shaped IDs and invalid dead branches. Five Core integration cases create a marker for exactly the selected branch and verify persisted status, failure-status precedence and needs-input pausing. All five baseline commands passed (453 tests). See `docs/WORKFLOWS.md`.

---

## M3.4 — Parallel steps

**Status:** [x] Complete and verified.

- [x] execute independent child steps concurrently
- [x] define fail-fast vs wait-all policy
- [x] cancellation propagation
- [x] deterministic result aggregation order
- [x] concurrency limit
- [x] persist child states independently
- [x] TUI-compatible events

Verified 22 parallel graph tests, the schema-backed parallel example, nine Core integration scenarios, and new event validation cases. Tests demonstrate real overlap with a two-child limit, stable joins/context after reversed completion and replay, independent command evidence, wait-all and fail-fast behavior, cancellation and actual subprocess exit, retained successful children across a new-process resume, child retry exhaustion, and cleanup after subscriber/store failure. All five baseline commands passed (502 tests). Parallel groups accept 1–32 independent agent/command leaves, preserve their initial input context, and publish child identities/states to the shared event model. Nested groups/human children, unknown interrupted-attempt recovery, and per-child worktree isolation remain outside this implementation; documented gates can surround a group.

---

## M3.5 — Router nodes

**Status:** [x] Complete and verified.

- [x] deterministic/static router rules first
- [x] optional agent-powered router later in the same abstraction
- [x] route decision persisted as evidence
- [x] invalid target protection

Implemented static labels and bounded output-reference selection through a declared `on` map with optional `next` fallback. An ordinary preceding agent can propose a label through the same contract as deterministic evidence; the router itself remains deterministic and provider-neutral. `router.selected` persists the chosen label, target and optional source before scheduling. Verified 25 router unit cases, 13 Core integration cases, schema/example validation and event contract cases, including declared-target protection, invalid/missing input, full-output references after approval, completed-checkpoint recovery in a new process, and bounded router cycles. All five baseline commands passed (547 tests). See `docs/WORKFLOWS.md` and `examples/workflows/v1/router.yaml`.

---

## M3.6 — Subworkflows

**Status:** [x] Complete and verified.

- [x] reference built-in or user workflow
- [x] namespace child step IDs/run context
- [x] input/output mapping
- [x] error propagation policy
- [x] recursion/depth guard

Verified all five baseline commands (589 tests total). Thirteen workflow tests cover reference resolution, scoped IDs and mappings, collisions, recursion, and depth limits. Seventeen Core integration cases cover context isolation, persisted mappings, failure propagation, cancellation, child approvals, parallel children, and fresh-process recovery without repeating completed effects. Schema/event tests and a CLI child-provider approval/resume case also pass. Resolved child definitions are stored with the run; references do not need to remain on disk to resume. Child scopes share the run's working directory; workspace isolation remains M6.1.

---

## M3.7 — Consensus / Judge nodes

**Status:** [x] Complete and verified.

- [x] support multiple independent reviewers
- [x] aggregation modes such as all-pass, quorum, explicit judge
- [x] deterministic verifier evidence remains separate and may be mandatory
- [x] cross-model review is supported but not required
- [x] persist each review independently

Verified all five baseline commands (673 tests total). Thirty-seven workflow tests plus schema/example checks cover policy validation, ownership, namespacing and pure aggregation. Twenty-five Core integration cases cover all modes, independent inputs across providers/retries, explicit verdicts, required verifier evidence, bounded/redacted judge context, reviewer/judge pause-resume, fresh-process child recovery, retry limits and cancellation/storage/subscriber failures. CLI discovery/rendering, event validation and OpenAI judge normalization also pass without live credentials. A hosted CI run for the preceding commit exposed the existing four-process CLI test's 5-second outer timeout; its assertions and process limits are preserved with a 60-second test timeout in a separate supporting commit.

---

## M3.8 — Workflow-level execution policies

**Status:** [x] Complete and verified.

- [x] step timeout
- [x] retry/backoff policy
- [x] concurrency limit
- [x] human approval policy
- [x] failure strategy
- [x] optional cost/token budget hooks
- [x] loop/cycle safety guards

Verified `pnpm lint`, `pnpm format:check`, `pnpm check`, `pnpm test`, and `pnpm build` (736 tests). Policies are validated against the version 1 DSL, materialized into the saved workflow, and enforced through inherited deadline/concurrency caps, cancellable exponential backoff, generated human gates, stop/branch failure handling and lifetime scope limits. Tests cover real command cancellation/drain, cooperative agent deadlines, no invocation after an expired input-persistence deadline, parallel fail-fast cancellation during backoff, approval/reapproval across fresh engines, preservation of repair limits through gates, child limits across resume, schema rejection and the CLI's existing approval controls. Optional token/cost hooks receive persisted usage and declared scope ceilings before/after agent calls; missing hooks, invalid decisions and denials stop execution and drain peers. Pricing, reservations and unknown-usage accounting remain the application's hook responsibility; the CLI has no built-in budget accounting. Example and public policy/runtime/state/approval documentation are aligned. Arbitrary adapters must honor cancellation; filesystem isolation and general crash reconciliation remain their later TODOs.

---

## M3.9 — Harden built-in presets

**Status:** [x] Complete and verified.

### `dev.yaml`

- planner → executor → verify → reviewer → fix loop

### `bugfix.yaml`

- reproduce/diagnose → fix → targeted verify → broader verify → review

### `review.yaml`

- inspect/diff → deterministic checks → one or more reviewers → report; no mutation by default

### `research.yaml`

- research/planning agents → synthesis/judge → human output; execution tools optional

For each preset:

- [x] documented purpose
- [x] declared required roles/capabilities
- [x] tests with fake adapters
- [x] sane bounded retries
- [x] no surprising destructive behavior

Verified all five repository baseline commands (752 tests). Eleven Core preset tests execute the actual YAML with fake adapters, checking dev repair limits, bug reproduction/targeted/broader ordering, failed-check evidence alongside both review verdicts, explicit report approval, bounded research refinement and no research commands. A real Git/pnpm review in a disposable fixture passed both verification stages without changing project sources. Four workflow tests validate reachable graphs, declared capabilities/mutation expectations and limits; schema tests cover literal per-agent instructions and invalid fields/lengths. The minimal `instructions` DSL field is necessary to deliver each preset's task guidance through the existing persisted AgentInput; it does not add role profiles or automatic capability selection. Capability metadata remains advisory until M4.1. `docs/PRESETS.md` documents role bindings, required scripts (including bugfix's project-specific `test:targeted`), mutation expectations, bounded evidence and report acknowledgment. Review/research use human reports without coding executors, installs, commits or deployment commands. Project scripts and native provider permissions remain the execution boundary.

---

## M3.10 — User-defined workflow UX

**Status:** [x] Complete and verified.

- [x] `ve run --workflow path/to/workflow.yaml`
- [x] workflow validation command, e.g. `ve workflow validate ...`
- [x] list built-in workflows
- [x] explain missing required agents/providers before execution
- [x] examples for simple, branching, parallel, and approval workflows

Verified all five baseline commands (769 tests), plus `pnpm ve -- workflow list --json` and `pnpm ve -- workflow validate examples/workflows/v1/parallel.yaml --json` through the repository entry point. Sixteen CLI tests cover read-only validation without ambient config/provider/state work, combined missing nested bindings/unsupported providers, preflight before any adapter constructor, unreachable-node warnings, file overrides relative to an explicit config, malformed definitions, bounded cycle execution and argument/help behavior. A Workflow registry test confirms every listed built-in loads and callers cannot mutate the registry. The example gallery links the complete simple, branching, parallel, approval, router, child, consensus and policy definitions with execution prerequisites. Configuration validation checks bindings/provider support only; credentials/readiness remain doctor checks. User workflows are loaded, snapshotted and executed by the shared Workflow/Core model, with the already-tested persisted transition, group, scope, judge and approval semantics.

### v0.3 exit criteria

- [x] users can author workflows without changing TypeScript
- [x] sequential/branching/parallel/subworkflow/judge concepts are persisted and resumable
- [x] malformed/cyclic workflows cannot create uncontrolled execution

---

# M4 — v0.4 Provider and plugin ecosystem

Goal: make Veyra genuinely heterogeneous instead of an OpenAI/Codex wrapper.

## M4.1 — Provider capability model

**Status:** [x] Complete and verified.

**Primary areas:** `packages/protocol`, `packages/sdk`, `packages/core`

- [x] define provider/agent capabilities (reasoning, code execution, vision, web/research if supported, structured output, tool use, local CLI, etc.)
- [x] capability discovery API
- [x] provider metadata/version/readiness
- [x] Core routes by role/capability, not hard-coded provider names

Verified all five baseline commands (811 tests) and the capability example through `pnpm ve -- workflow validate examples/workflows/v1/capabilities.yaml --json`. Twenty-one protocol tests validate bounded JSON metadata, namespaced capabilities, requirements and scoped readiness. Eleven Core cases cover discovery without execution, opt-in probes, safe errors, identical requirements across two custom providers, recorded selection, incompatible/missing metadata, no silent fallback and saved requirements on resume. SDK, workflow schema/example, state-event and native adapter tests plus CLI doctor assertions pass without live credentials. Optional `requires` constraints are enforced against the explicitly configured binding before each invocation; unconstrained legacy adapters remain compatible. Built-in preset metadata annotations remain advisory. OpenAI advertises only its implemented text/structured path and checks credential presence; Codex advertises its CLI executor path and wraps native readiness checks. `docs/CAPABILITIES.md` documents the public contracts, limits and actual support. Plugin loading and automatic selection remain their own TODOs.

---

## M4.2 — Plugin registry and loading

**Status:** [x] Complete and verified.

- [x] define official plugin contract in `@veyraoss/sdk`
- [x] explicit registration for built-ins
- [x] safe third-party plugin loading strategy
- [x] plugin config namespace
- [x] plugin version compatibility checks
- [x] plugin doctor/readiness hook
- [x] clear error when plugin missing

Verified frozen install, all five baseline commands (856 tests), and `pnpm ve -- doctor --json` through the repository entry point. Twenty-seven SDK plugin tests cover explicit registration, copied configuration, hook controls, API/version/identity validation, normalized errors, missing modules, and trust-before-import with real local ESM modules. Eleven config tests cover namespace copying, exact versions, bounded options and invalid module declarations. Seven CLI cases prove no import during validation/inspection or without exact trust, required/unused plugin preflight, built-in override protection and option precedence, readiness diagnosis/redaction, and a third-party workflow's fresh-process approval/resume. Built-ins register through the same per-application SDK registry. Local modules require explicit `--allow-plugin <provider>` each run/resume/doctor invocation; imports have full host privileges and exact versions are declared compatibility checks, not integrity hashes. No packages are downloaded or installed by the loader. Core remains unchanged and provider-neutral. Public contracts, examples, option precedence and limitations are documented in `docs/PLUGINS.md`.

---

## M4.3 — Claude API provider

**Status:** [!] Implementation and deterministic checks verified; live smoke blocked.

**Primary area:** `plugins/claude`

- [x] reasoning/reviewer adapter
- [x] structured result normalization
- [x] usage metadata
- [x] cancellation/timeouts
- [x] mocked tests
- [!] opt-in smoke test — command implemented; live verification requires an Anthropic API credential

Verified frozen installation, all five baseline commands (920 tests), and `pnpm ve -- workflow validate dev --config examples/providers/claude.yaml --json`. Sixty-three adapter tests cover planner/reviewer/judge normalization, evidence and verdict guards, missing/invalid usage, safe errors, credential redaction, configured endpoint/auth isolation, cancellation and real SDK transports with mocked fetch, including a stalled response body. CLI coverage confirms built-in registration, read-only validation, scoped credential-presence readiness and actionable missing-key execution. The official SDK is pinned at 0.124.0; protocol/Core stay provider-neutral. Runtime's cooperative deadline covers the complete SDK call, since the SDK's own transport timer ends after headers. No live API call is required by default tests. See `docs/CLAUDE.md` and the provider example.

Live blocker: `ANTHROPIC_API_KEY` is absent (presence only was inspected). Attempted `VEYRA_LIVE_SMOKE=1 pnpm --filter @veyraoss/claude smoke -- claude-opus-4-6`; it exited 2 with `Set VEYRA_LIVE_SMOKE=1 and ANTHROPIC_API_KEY, then run: pnpm --filter @veyraoss/claude smoke -- <model>`. Supply the key in the environment and an accessible structured-output model, then rerun the two-request planner/reviewer smoke. Mocked success is not live verification. M4.4 is independent and can proceed.

---

## M4.4 — Claude Code executor

**Status:** [!] Implementation and deterministic verification passed; live smoke blocked by native request timeouts.

**Primary area:** `plugins/claude-code`

- [x] runtime-based CLI invocation
- [x] executable/readiness detection
- [x] non-interactive/structured mode when available
- [x] cwd/cancellation/timeout/log capture
- [!] mocked and opt-in real smoke tests (mocked tests and guarded tooling pass; real success remains unverified)

Implemented the `claude-code` built-in with literal stdin, native JSON/schema print mode, bounded turns/results/logs, explicit native permission rules, permission-denial pause handling, normalized process/provider errors, execution identity, usage/cost and redaction. Readiness checks version, required flags and native authentication under one deadline. The public CLI and example config use the same registry/runtime boundaries. Frozen install, example workflow validation, `pnpm ve -- doctor --json` and all five baseline commands passed (1002 tests, including 81 adapter tests and CLI composition coverage). The smoke guard exits 2 before provider work unless explicitly enabled.

Live blocker: Claude Code 2.1.159 reports authenticated access, but `VEYRA_LIVE_SMOKE=1 pnpm --filter @veyraoss/claude-code smoke` exited 1 with `claude_code_timeout` after 180513 ms. Native stdout/stderr were empty; Runtime terminated the process group and the disposable fixture was removed. A separate native print request without tools, hooks, MCP or the structured schema, preserving configured authentication/model settings, also timed out after 60 seconds with empty stdout/stderr. A diagnostic with user/project setting sources omitted returned an error envelope immediately, so it does not verify the configured provider. Settings metadata confirms a configured provider URL/token/model and hooks; credential values were not printed or changed. Restore working native provider/model access, confirm a minimal `claude --print` request completes, then rerun the guarded fixture smoke (optionally with an accessible model). M4.5 is independent and can proceed.

---

## M4.5 — Gemini API provider

**Status:** [!] Implementation and deterministic verification passed; live smoke blocked by unavailable API credential.

**Primary area:** `plugins/gemini`

- [x] planner/reviewer adapter
- [x] multimodal/vision capability surfaced only if actually supported by configured model
- [x] structured results and usage normalization
- [!] tests/smoke test (87 adapter tests and guarded smoke tooling pass; live requests remain unverified)

Implemented the Gemini Developer API adapter using built-in HTTP transport, role-specific constrained JSON and local evidence validation, bounded streamed bodies, complete request/body deadlines, explicit refusal/error normalization, redaction and provider-reported token accounting. Vision requires explicit opt-in and a documented exact model ID; bounded PNG/JPEG/WebP base64 images become separate request parts without file/URL access. CLI registration, readiness and examples use the existing provider-neutral interfaces. Frozen install, example workflow validation, root doctor and all five baseline commands passed (1090 tests including 87 adapter tests and CLI integration). The white-pixel smoke fixture's dimensions, decoded pixel and PNG checksums were verified locally.

Live blocker: neither `GEMINI_API_KEY` nor `GOOGLE_API_KEY` is present (presence only was inspected). Attempted `VEYRA_LIVE_SMOKE=1 pnpm --filter @veyraoss/gemini smoke -- gemini-2.5-flash`; it exited 2 with `Set VEYRA_LIVE_SMOKE=1 and GEMINI_API_KEY, then run: pnpm --filter @veyraoss/gemini smoke -- <model>`. Supply a valid key in the environment and accessible model, then rerun the planner/reviewer smoke; an allowlisted vision model additionally runs the image check. No native CLI credential was extracted or substituted. M4.6 is independent and can proceed.

---

## M4.6 — Gemini CLI executor

**Status:** [x] Complete and verified with deterministic process tests; live execution unverified.

Implementation decision (before coding): keep `GeminiCliAdapter` alongside the API adapter in the existing `plugins/gemini` package, with separate implementation modules and provider names (`gemini-cli` versus `gemini`). This follows the scaffold's stated API/later-CLI ownership, avoids adding a top-level package boundary, and keeps every process operation in Runtime. The API adapter and its credentials remain separate from native CLI execution/authentication.

- [x] decide whether it shares `plugins/gemini` or needs a separate package; do not silently change top-level architecture—document decision first
- [x] runtime-based invocation
- [x] readiness and auth detection
- [x] structured/non-interactive output
- [x] tests

Verified all five baseline commands (1171 tests), example workflow validation and root doctor. Eighty Gemini CLI tests cover strict executor results, native errors and permission/warning handling, reported usage, prompt file-inclusion escaping, bounded output, cancellation/timeouts, secret masking and scoped offline readiness; a real disposable Node child verifies Runtime stdin/output transport. CLI integration verifies provider registration, read-only validation, doctor and persisted execution through the existing contracts. No package dependency or architecture boundary changed. `docs/GEMINI-CLI.md` documents native policy/authentication ownership and the pinned 0.58.0 contract. The actual readiness probe returned `unavailable` with `Gemini CLI executable was not found; install it or configure its executable path.` No live inference was attempted or claimed; this item requires deterministic tests, not a live smoke acceptance check.

---

## M4.7 — OpenCode executor

**Status:** [!] Implementation and deterministic verification passed; live smoke blocked by rejected native provider credentials.

**Primary area:** `plugins/opencode`

- [x] runtime-based invocation
- [x] readiness detection
- [x] normalize result
- [x] cancellation/timeouts
- [!] tests/smoke test (84 adapter tests, CLI integration and guarded tooling pass; live success remains blocked)

Verified frozen install, all five baseline commands (1257 tests), example workflow validation and root doctor. The native adapter uses version preflight, literal stdin, fixed cwd, headless JSONL, sharing disabled, native permissions, one deadline and bounded diagnostics. Tests cover final-step/session correlation, malformed output, replay accounting, credential/access pauses, tool/process errors, cancellation and real Runtime stdin/output. CLI coverage includes execution plus the unconfigured-model doctor regression. `docs/OPENCODE.md` documents the supported 1.18.29 contract, native defaults and limitations.

Live blocker: the initial system-path smoke returned `OpenCode executable was not found; install it or configure its executable path.` A pinned temporary install through `pnpm dlx opencode-ai@1.18.29 --version` succeeded. Native help is on stderr; readiness was corrected and verified against that binary. Attempted `VEYRA_LIVE_SMOKE=1 pnpm --package=opencode-ai@1.18.29 dlx node --import tsx plugins/opencode/test/manual-smoke.ts`; the configured native provider returned HTTP 401 with `Invalid API Key` after 8486 ms and the command exited 1. Runtime exited and the disposable workspace was removed. The captured API error shape now maps to `needs_input` in deterministic tests. Configure valid native provider credentials/access, then rerun the guarded smoke with an accessible `provider/model` if needed. No native credentials/settings were changed and no alternate provider was selected to hide the failure. M4.8 is independent and can proceed.

---

## M4.8 — OpenAI-compatible/local-model adapter

**Status:** [x] Complete and verified.

Implementation decision: add a separate `OpenAICompatibleAdapter` and `openai-compatible` registration inside the existing `plugins/openai` package. It will use explicitly configured Chat Completions endpoints and response-format support, with separate credential selection and no change to the official OpenAI Responses adapter. This keeps provider-specific compatibility behavior within the scaffold's existing package boundary.

- [x] support configurable base URL where appropriate
- [x] do not assume every OpenAI-compatible server supports every Responses feature
- [x] capability flags/fallback behavior
- [x] examples for local models
- [x] ensure local provider failures are actionable

Verified frozen install and all five baseline commands (1334 tests total). The 75 compatible-adapter tests cover explicit/custom API prefixes, optional credential selection, three output modes, conservative capability declarations, strict role/evidence validation, safe HTTP errors, bounded bodies, deadline/cancellation and real loopback HTTP/redirect behavior. Two additional CLI integration cases cover missing-endpoint diagnostics and configuration/doctor/run/approval/resume with a real local test server. Both Ollama and LM Studio example workflows validate and their doctor checks pass with explicitly configuration-only readiness. No external model inference or model installation was performed or required for this item. The official OpenAI Responses behavior is unchanged.

---

## M4.9 — Authentication and secret-handling policy

**Status:** [x] Complete and verified.

Implementation decision: put the shared, explicitly configured text/JSON redactor in Runtime and use it at existing adapter/CLI/state boundaries. This is the minimum common primitive needed for this policy; Core retains schema-aware persistence handling and never reads global credentials. M6.3 remains open for broader pattern and surface hardening. Native provider login/configuration files are neither read nor changed by Veyra.

- [x] environment/standard provider auth first
- [x] never echo secrets
- [x] never persist provider keys in run state
- [x] redaction utility for logs/errors
- [x] `ve doctor` reports presence/readiness without exposing values
- [x] document precedence of env/config/provider native login

Verified all five baseline commands (1373 tests total) and root `pnpm ve -- doctor --json`. Added 19 Runtime redaction cases, 16 credential-free config cases and four adapter/CLI regressions; strengthened existing SDK/state checks. Tests cover generic token variables, explicit custom variable names, overlap/idempotence, raw/escaped/URL-encoded diagnostics, unchanged usage/structural fields, no implicit ambient auth fallback, and no fixture credentials in CLI output or saved input/state/events. The OpenAI factory now uses one supplied environment for readiness and execution. Native CLI environment/login behavior is preserved. `docs/AUTHENTICATION.md` records precedence, programmatic store obligations, safe readiness claims and limits for unknown secrets/native files/third-party output; no native credentials were read or changed.

---

## M4.10 — Agent role profiles

**Status:** [x] Complete and verified.

Implementation decision: define versioned provider-neutral profiles/contracts in Protocol, re-export them through SDK, and attach a profile when Core resolves a standard role. Core composes role guidance into the existing instruction envelope and persists the exact profile before invocation. Adapter wire formats and permissions remain adapter-owned; extension roles and legacy inputs remain valid without a built-in profile.

- [x] planner profile
- [x] executor profile
- [x] researcher profile
- [x] reviewer profile
- [x] judge profile
- [x] role-specific prompt/context contracts without hard-coding one provider

Verified all five baseline commands (1395 tests total). Seventeen Protocol tests cover the five versioned role/context/result contracts, independent snapshots and strict metadata guards. Five Core cases cover delivery through two different providers, persistence before invocation, mutation isolation, custom-role compatibility, profile-role identity and fresh-engine approval/resume. Existing parallel/subworkflow/consensus and CLI E2E checks also pass through the shared leaf path. Profiles are behavioral/context guidance; they do not add provider roles/tools or replace adapter output schemas. Older inputs without profiles remain readable. `docs/ROLE-PROFILES.md` documents explicit alias roles, composition order, versioned audit evidence and limits.

---

## M4.11 — Optional automatic provider routing

**Status:** [x] Complete and verified.

Implementation decision: extend agent nodes with explicit ordered fallbacks and permitted pre-invocation failure categories. Core owns capability/readiness/optional user-estimate filtering and audited decisions; CLI diagnostics reuse that selector. No fallback replays an agent after execution starts. Existing bindings remain pinned by default, and the independent run budget hook is unchanged.

- [x] begin with explicit deterministic rules, not an opaque autonomous router
- [x] route by required capability, configured preference, availability, optional budget
- [x] record why a provider was selected
- [x] allow users to pin a provider/model
- [x] graceful fallback policy is explicit, never silent

Verified all five baseline commands (1453 tests total), the routing example workflow/configuration, its scoped doctor decision and root doctor. Added 26 Protocol cases, 24 Core routing cases, five CLI integration cases, one SDK receiver/snapshot regression and two workflow schema/example cases. Coverage includes ordered preferences, capability/role checks, explicit estimates, unknown readiness, cooperative timeout/drain and cancellation, fail-closed configuration errors, audited selection/exhaustion, failure gates, resume, nested/parallel/consensus leaves, secret-free evidence, and no fallback after invocation or budget-hook denial. CLI diagnostics use the same selector and registered readiness hook. `docs/PROVIDER-ROUTING.md` records configuration, pinning, estimates and readiness limits. No live inference was required or claimed.

### v0.4 exit criteria

- [ ] at least two reasoning providers and two coding-agent executors work
- [x] workflows are provider-agnostic
- [x] third-party adapter path is documented/tested
- [x] provider choice can differ by workflow role

---

# M5 — v0.5 Web Dashboard / Agent Control Center

Goal: provide a visual management surface for multiple projects/runs while reusing the same Core/event/state contracts.

## M5.1 — Dashboard technical foundation

**Status:** [!] Blocked by the requested TUI-stability prerequisite.

The Autopilot request, section 25, says: “Do not prematurely build a large Web application before the core and TUI are stable.” Treating Dashboard implementation as dependent on that prerequisite preserves the requested milestone order. Inspected `apps/tui/src/index.ts` (still prints `TUI scaffold`), M2.1 (depends on v0.1 completion), and M1.14 (live closed loop remains blocked by the absent OpenAI API credential). No Dashboard implementation or new dependency was started. Unblock M1.14, finish the dependent v0.1/TUI acceptance checks, then start this foundation; M5.2–M5.9 depend on it. M5.10 is an independent design-only document, and M6 hardening may proceed independently.

**Primary area:** `apps/dashboard`

- [ ] choose a lightweight web stack suitable for a local control center
- [ ] keep backend bridge and UI within `apps/dashboard` unless a reusable package is clearly justified and approved
- [ ] no orchestration logic duplicated from Core
- [ ] define local HTTP/API + streaming event mechanism (WebSocket/SSE or equivalent)
- [ ] bind safely to localhost by default

---

## M5.2 — Local project/run bridge

- [ ] discover/select Veyra project directories explicitly
- [ ] list runs and states
- [ ] stream events from active runs
- [ ] expose safe commands: start/pause/resume/cancel/approve/reject
- [ ] validate all input server-side

---

## M5.3 — Projects page

- [ ] project name/path
- [ ] active run/status
- [ ] recent run summary
- [ ] configured workflow/providers
- [ ] quick start action

---

## M5.4 — Run detail page

- [ ] goal
- [ ] status/duration
- [ ] workflow graph
- [ ] current step
- [ ] agent/provider assignments
- [ ] timeline
- [ ] verification results
- [ ] reviews
- [ ] artifacts/diff
- [ ] retry history

---

## M5.5 — Workflow visualization and management

- [ ] render sequential, branching, parallel, subworkflow nodes
- [ ] inspect node configuration
- [ ] validation errors
- [ ] initial version may be read-only; visual editing is a later optional feature

---

## M5.6 — Agent/provider settings page

- [ ] provider readiness
- [ ] configured roles/models
- [ ] capabilities
- [ ] no secret values rendered
- [ ] `doctor`-style diagnostics

---

## M5.7 — Human approval inbox

- [ ] pending approvals across projects
- [ ] context/evidence before action
- [ ] approve/reject with audit event
- [ ] prevent stale/double approval

---

## M5.8 — Usage, cost, and duration metrics

- [ ] per run/provider/role usage where providers expose it
- [ ] optional cost calculation with clearly sourced/configurable pricing data; do not pretend unknown costs are exact
- [ ] duration and retry metrics
- [ ] no telemetry sent externally by default

---

## M5.9 — Multi-project management

- [ ] multiple registered local projects
- [ ] concurrent run visibility
- [ ] project-scoped config/state
- [ ] avoid accidental commands running in wrong project

---

## M5.10 — Remote worker/control-plane design

**Status:** [x] Design complete and verified; remote implementation remains deferred.

- [x] write design doc before implementation
- [x] authentication
- [x] secure transport
- [x] worker identity/capabilities
- [x] no arbitrary unauthenticated remote command execution
- [x] local-only mode remains first-class

`docs/REMOTE-CONTROL-DESIGN.md` defines the proposed topology/package ownership, mutual worker authentication and enrollment/revocation, encrypted transport, per-project/action authorization, explicit capabilities, bounded assignments/artifacts, durable deduplication and conservative interrupted-work recovery. It preserves local-only execution and lists the future approval and verification gates. The design references current primary TLS/HTTP/OWASP guidance; no remote protocol, daemon, credential or deployment was created. Reviewed each requirement against the document, validated 42 local link targets across the changed documents, and ran all five baseline commands successfully (1453 tests). Remote integration tests are specified for future implementation and are not claimed as executed.

### v0.5 exit criteria

- [ ] dashboard can observe and control local Veyra runs
- [ ] multi-project view works
- [ ] approvals, workflow state, reviews, verification and metrics are visual
- [ ] Core remains the single orchestration source of truth

---

# M6 — Reliability, security, and engineering hardening

These tasks may begin earlier when required, but must all be complete before claiming production-grade reliability.

## M6.1 — Workspace isolation strategy

**Status:** [x] Complete and verified.

- [x] support optional git worktree isolation per run/task
- [x] define default behavior for dirty working trees
- [x] prevent one concurrent run from silently overwriting another
- [x] preserve/clean worktrees predictably
- [x] show working directory/worktree in status/UI

Verified all five baseline commands (1,494 tests), including real temporary Git worktrees, cross-process shared-workspace contention, independent active worktrees, dirty/staged/untracked source policies, saved-worktree resume after source/config changes, and CLI status/cleanup. Cleanup preserves ignored files, index-hidden edits and additional commits; ownership/path mismatches and active/paused worktrees are refused. Execution location is persisted before invocation, and redaction cannot redirect it. Sixty-six local documentation links passed validation. [Workspace documentation](WORKSPACES.md) defines preservation, failure handling and the cooperative lease boundary; the minimal lease supports this item and does not complete the general M6.5 run/state locking task.

---

## M6.2 — Command execution safety model

**Status:** [x] Complete and verified.

- [x] distinguish provider-generated commands from configured verifier commands
- [x] define approval policy for high-risk operations
- [x] avoid implicit shell interpolation
- [x] document that local coding agents may still execute commands according to their own permission model
- [x] surface effective permission mode to user where detectable

Verified all five baseline commands (1,519 tests). New cases cover trusted verifier source tagging/rejection before spawn, non-execution of provider command claims and goal shell syntax, explicit approval/rejection before a real fixture effect, bounded protected-operation previews, permission metadata validation, and CLI rendering. Official CLI adapter metadata matches their existing native flags; unknown native policy remains explicit. Sixty-five local documentation links passed. The [command safety model](COMMAND-SAFETY.md) defines high-risk authoring policy using existing enforced workflow gates, intentional shell semantics and native/host permission limits; it does not claim automatic shell-risk classification.
Root `pnpm ve -- doctor` passed. The Claude Code example doctor displayed `default` mode and six explicit allow rules; its exit 1 correctly reports the existing missing `OPENAI_API_KEY` for planner/reviewer, not a permission-metadata failure.

---

## M6.3 — Secret redaction

**Status:** [!] Current execution paths verified; TUI/Dashboard log-renderer checks are blocked by their unimplemented milestones.

- [x] centralized redaction helper
- [x] redact common API key/token patterns and configured secret env names
- [!] apply to events, stderr excerpts, persisted errors, Dashboard/TUI logs
- [x] test that known fixture secrets never reach `.veyra/runs`

Implemented recognizable token/private-key/header patterns, credential-shaped fields and payload keys, explicit custom environment names, and bounded-output prefix filtering in the shared Runtime helper. Core sanitizes full exceptions before clipping and refuses credential-bearing structural identifiers. Native CLI adapters pass truncation flags; Verifier filters returned/emitted evidence while preserving the authorized process input. Scope and limits are documented in [AUTHENTICATION](AUTHENTICATION.md).

Verified all five baseline commands; `pnpm test` passed 1,546 tests, including 27 new cases for unknown recognizable formats, configured secrets, encoded/truncated values, emitted events, persisted errors/files, subsequent agent context and CLI diagnostics. The initial full test run timed out in an existing worktree-resume test at 5 seconds; that file passed independently in 1.70 seconds and the full suite rerun passed without code changes.

Blocker evidence: `apps/tui/src/index.ts` still prints only `TUI scaffold`; `apps/dashboard/README.md` reports `planned for v0.5` and no Dashboard log renderer exists. Current Core/CLI/provider/Verifier paths pass, but renderer-specific tests cannot execute until the dependent M2 and M5 surfaces are implemented. Revisit their logs and integration tests when those milestones become eligible; do not mark this item complete in advance. Independent M6.4 can proceed.

---

## M6.4 — Crash recovery and idempotency

**Status:** [x] Complete and verified.

- [x] atomic state updates
- [x] distinguish `running` from stale/interrupted after process death
- [x] recovery policy for an agent step that may have partially mutated files
- [x] `resume` must not blindly repeat destructive completed work
- [x] persist step attempt IDs and completion boundaries

Implemented coordinator ownership snapshots and read-only Core/CLI liveness inspection, validated attempt/completion matching, terminal checkpoint finalization, and durable recovery references that survive a second crash during reconciliation. Live/unknown owners, unmatched attempts, unfinished peers and torn history remain refused. Completed nested steps retain their existing success/failure semantics without replay. POSIX state publication now syncs directory entries as well as file content; snapshots remain individually atomic. [CRASH-RECOVERY](CRASH-RECOVERY.md) documents partial-mutation policy, explicit recovery, legacy/foreign owners and filesystem limits. General state locking remains M6.5.

Verified all five baseline commands and 1,588 tests, including 42 new cases covering real process death, atomic rename boundaries, single file mutations, interrupted reconciliation, owner probes, malformed evidence and CLI status. Existing nested-workflow and E2E recovery tests also passed. The full suite exposed a child unmatched-outcome regression, which was fixed and reverified. Core tests now use four workers and real-Git workspace tests have a 30-second bound after concurrent synced filesystem tests exceeded the previous 5-second limits. POSIX-specific SIGKILL tests ran on this macOS host; Windows-specific verification remains separately tracked.

---

## M6.5 — Concurrency and locking

**Status:** [x] Complete and verified.

- [x] project/run lock design
- [x] allow safe multiple runs when workspaces are isolated
- [x] prevent duplicate resume of the same run
- [x] stale lock recovery

Verified `pnpm lint`, `pnpm format:check`, `pnpm check`, `pnpm test` (1,607 tests), and `pnpm build`. Independent Node processes contend without lost event sequences/state revisions, readers wait through a split append, duplicate approvals consume a nonce once, and a delayed resume cannot advance a newer pause. Two isolated worktrees execute concurrently against one readable store. Real process-death tests cover choosing/acquired tickets, simultaneous stale recovery, paused approval/resume through the CLI, and terminal worktree cleanup; the existing crash-reconciliation suites also pass. Live, foreign, malformed and mismatched owners are preserved, with no age-based stealing. POSIX signal/symlink cases are explicitly skipped on Windows; its support verification remains M6.9. [Locking](LOCKING.md) documents run/workspace/store scopes, revisions, local-filesystem assumptions, explicit recovery and the conservative manual policy for an unowned legacy workspace guard.

---

## M6.6 — Cancellation semantics

**Status:** [x] Complete and verified.

- [x] user cancel
- [x] timeout cancel
- [x] parent cancel propagates to parallel/subworkflow children
- [x] process tree cleanup
- [x] state records cancellation reason

Verified `pnpm lint`, `pnpm format:check`, `pnpm check`, `pnpm test` (1,623 tests), and `pnpm build`. Tests cover abort-rejecting adapters/verifiers, cancellation at persisted scheduling/approval/completion boundaries, first-cause deadline ordering while cleanup settles, nested parallel children with skipped queued work, terminal reason validation/redaction, and explicit process cleanup failures. Public CLI tests repeatedly send SIGINT, SIGTERM, and mixed signals while a disposable process tree ignores SIGTERM: descendants stop, successor commands never run, the first signal determines exit 130/143, and a new status process reads the saved `run_cancelled` reason. Existing timeout, fail-fast, retry-backoff and POSIX descendant cleanup tests also pass. POSIX signal tests are explicitly skipped on Windows; its process-tree control has mocked tests and native support remains M6.9. [Cancellation semantics](CANCELLATION.md) documents terminal `failed` state/errors, child propagation, cleanup limits and preserved partial work.

---

## M6.7 — Log/artifact retention

**Status:** [x] Complete and verified.

- [x] bounded inline logs
- [x] large outputs stored as artifacts/files
- [x] retention/cleanup command or policy
- [x] artifact metadata includes producer/step/timestamp
- [x] avoid repo bloat by default

Verified all five baseline commands and 1,649 tests. Large events are redacted before atomic payload publication, with bounded timeline/CLI previews, producer identity, timestamps, byte sizes and SHA-256 references. Core restores complete retained evidence for mappings, resume and subscribers. Tests cover fresh-process restoration, large run/agent/verifier payloads, corruption/path/symlink refusal and a real crash before reference append. `ve prune` previews by default and explicitly applies age/count retention under run/store coordination; tests preserve active/paused histories, worktrees, busy leases and external files, recheck concurrent selection, and report retained trash after injected deletion failure. State/history/worktree ignore rules prevent accidental repository bloat. Fifty-three documentation links passed validation. [Artifact and retention documentation](ARTIFACTS-RETENTION.md) records capture limits, legacy compatibility, cooperative locking and partial-cleanup recovery. No developer run history was deleted.

---

## M6.8 — Prompt/context safety and provenance

**Status:** [x] Complete and verified.

- [x] clearly separate project instructions, workflow instructions, previous-agent outputs, tool evidence
- [x] mark untrusted external/research content where possible
- [x] Reviewer should rely on verifier evidence rather than blindly trusting Executor claims
- [x] persist evidence references used for important decisions

Verified `pnpm lint`, `pnpm format:check`, `pnpm check`, `pnpm test` (1,670 tests), and `pnpm build`. New runs capture a bounded, redacted execution-root `AGENTS.md`; agent envelopes label project/role/workflow/group sources separately from untrusted context and artifacts. Core-derived event/attempt references survive mapping, eviction, retries, forks, nested calls and resume; agent outcomes reference their saved input, router decisions reference their exact source, and approvals/consensus preserve supplied evidence provenance. Tests include forged trust claims, actual failed verifier evidence despite executor success claims, missing/invalid/linked rule files, captured/absent/legacy snapshots, nested parameter chains and all official prompt builders. Existing consensus checks still prevent a judge from overriding required failed verification. [Prompt safety](PROMPT-SAFETY.md) documents the full-envelope adapter integration, native-rule scope, metadata bounds and the distinction between supplied evidence and model truthfulness. Local documentation link targets were verified.

---

## M6.9 — Cross-platform support

**Status:** [x] Complete and verified.

- [x] macOS support verified
- [x] Linux support verified
- [x] Windows support policy explicitly decided/tested before claiming support
- [x] path, signals, process termination, shell behavior covered by tests where practical

Local frozen install and all five baseline commands passed on macOS arm64 with Node.js 22.22.0 and pnpm 10.15.1 (1,677 tests). The [hosted matrix passed on both macOS 15 and Ubuntu 24.04](https://github.com/iamzjt-front-end/veyra/actions/runs/34203473354) at commit `bf9c9d7`, including the frozen install and all five checks. Seven added cases cover literal paths/arguments, Unicode Git worktrees, real POSIX shell semantics and mocked platform shell selection; the existing real process-group, signal, cancellation and recovery suites also passed. The [platform policy](PLATFORMS.md) explicitly leaves native Windows unsupported pending full native verification. Local documentation targets and formatting were checked.

Follow-up: the documentation commit's [macOS CI run](https://github.com/iamzjt-front-end/veyra/actions/runs/34203906068) exposed a real reaping race: graceful group signaling returned `EPERM`, followed by final `ESRCH`. Commit `44d63e4` uses the final escalation result and keeps persistent failures fatal. Three regression cases passed; a real delayed-event-loop reproduction returned the same `EPERM` but completed correctly in all 12 runs after the fix. Commit `d802b13` also gives one repeated consensus persistence fixture a 15-second test limit after a concurrent-I/O timeout, preserving its assertions. All five local checks subsequently passed with 1,681 tests.

---

# M7 — Open-source productization and releases

Goal: turn a working internal tool into a credible public developer project.

## M7.1 — Public package strategy

**Status:** [x] Complete and verified.

- [x] decide which packages are published (`@veyraoss/core`, `@veyraoss/sdk`, official plugins, CLI package)
- [x] executable remains `ve`
- [x] verify npm package/scope ownership and naming before first release
- [x] remove `private: true` only from packages intentionally published
- [x] exports/types/files fields are correct

Prepared the fourteen candidates in the [package strategy](PACKAGES.md), with explicit ESM/type exports, runtime-only file allowlists, MIT licenses and repository metadata. Workflow builds and includes its own preset assets instead of resolving outside the installed package. `pnpm packages:check` packed and inspected every candidate, then imported modules, compiled SDK consumer types, loaded presets/schema and invoked `ve` from an isolated consumer. A frozen install and all five baseline checks passed (1,681 tests). Third-party dependencies reuse the frozen install; no registry install or public publication is claimed.

The original ownership check for the previous scope returned `E401 Unauthorized`; anonymous package lookups were insufficient. The maintainer created the official `@veyraoss` organization and authorized repository-wide migration. On 2026-09-08, `npm whoami --registry=https://registry.npmjs.org` returned `zjex`, and `npm org ls veyraoss --json --registry=https://registry.npmjs.org` returned `{"zjex":"owner"}`. All fourteen new package metadata requests returned HTTP 404. Public publishing remains an explicit human-approval boundary. Historical provider smoke commands in this document use the new scope so they remain runnable; their previously recorded live results are unchanged.

Verified the completed scope migration with `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm format:check`, `pnpm check`, `pnpm test` (1,681 tests), `pnpm build`, `pnpm packages:check` and `pnpm ve -- doctor --json`. All sixteen workspace projects are detected, no previous scope references remain in tracked files, and 184 relative documentation links resolve. Packed-manifest tests enforce public metadata on exactly the fourteen candidates while root/TUI remain private. The product name Veyra, executable `ve`, provider identifiers, `veyra.yaml` and `.veyra/` are preserved. No package was published.

---

## M7.2 — Versioning and changelog

**Status:** [x] Complete and verified.

- [x] semantic versioning policy
- [x] changeset/release-note workflow
- [x] changelog generation
- [x] plugin/core compatibility version policy

The [versioning policy](VERSIONING.md) defines pre/post-1.0 compatibility, independent schema/API identifiers and exact plugin pins. Pinned Changesets CLI 2.31.1 versions the fourteen official packages together, generates local Git changelogs and excludes private scaffolds. `pnpm changeset`, `pnpm release:status` and `pnpm release:version` provide note creation, preview and local preparation; none automatically commits, tags or publishes. The CLI and all eight official adapter variants now report installed manifest versions. Generated package changelogs are included in tarballs when present.

Verified frozen installation, `pnpm release:status`, `pnpm versioning:check`, `pnpm packages:check` and all five baseline commands (1,686 tests). Five disposable-monorepo tests run real patch/minor/major preparation, invalid-target rejection, fixed-group propagation, dependency/changelog updates, private exclusions and idempotent repeated versioning; the full preparation script passes offline with its frozen lockfile and formatter configuration. The tarball consumer verifies future prerelease versions in fresh processes without a rebuild. Ninety-two relative documentation links resolve. Repository package versions remain `0.1.0`, with a pending release note; no public release or publication occurred.

---

## M7.3 — Release CI

**Status:** [x] Complete and verified.

- [x] GitHub release workflow
- [x] npm provenance/signing where supported
- [x] build/test before publish
- [x] tag/version consistency checks
- [x] no secret leakage in logs

Implemented the manual [release workflow](RELEASING.md): verification runs before a separately approved publication job, all Actions/tool versions are pinned, artifacts retain source/version metadata and hashes, and the publisher validates all tarballs before using npm OIDC/provenance and checking registry integrity. The GitHub `npm-release` environment was configured and read back with required reviewer `iamzjt-front-end` and a `main` branch restriction. No npm token was uploaded, trusted-publisher registration performed or package published.

Local frozen installation, actionlint 1.7.12, all five baseline commands (1,696 tests), `pnpm release-ci:check` and actual `pnpm release:pack --tag v0.1.0 --dist-tag latest --out <temporary-directory>` passed. Ten new cases exercise real Git/pnpm packing and substitute npm only inside disposable fixtures for publication arguments, integrity failures and diagnostic redaction. The checkout's fourteen real tarballs were correctly marked as a non-publishable preview. Seventy-one local documentation targets resolve.

At `bf7189e`, [macOS/Linux CI passed](https://github.com/iamzjt-front-end/veyra/actions/runs/34212237260), and [hosted release validation passed](https://github.com/iamzjt-front-end/veyra/actions/runs/34212290491) with the publication job skipped. Downloaded and independently checked all fourteen artifact tarballs against SHA-256/SHA-512, source SHA and package versions. A [deliberately mismatched v0.1.1 request](https://github.com/iamzjt-front-end/veyra/actions/runs/34212611857) failed at preflight with `Release tag and official package versions must match.` and also skipped publication. Both dispatches used `publish=false`. Live public publication, npm trusted-publisher authentication and generated provenance attestations remain unverified and require explicit human approval plus registry setup; this item verifies the workflow implementation without claiming an actual release.

---

## M7.4 — Installation experience

**Status:** [x] Complete and verified.

- [x] npm installation documented
- [x] verify global install exposes `ve`
- [x] optional Homebrew distribution evaluated; deferred until the public npm path is stable
- [x] upgrade/uninstall docs
- [x] `ve doctor` useful immediately after install

Verified `pnpm installation:check` with real npm in a disposable global prefix: all fourteen candidate tarballs installed, `ve version` matched 0.1.0, all four presets loaded, missing pnpm/config produced setup guidance, installing pnpm 10.15.1 made doctor ready, and uninstall removed the executable link. No project config/state or user-global installation was changed. The script removes its temporary prefix/cache/configs on failure too and does not use npm credentials or publish. Registry-only installation remains documented for after the first approved public release. The full five-command baseline passed (1,697 tests), including the new fresh-install doctor regression, and 82 local documentation links resolved. See [installation](INSTALLATION.md).

---

## M7.5 — Contributor documentation

**Status:** [x] Complete and verified.

- [x] `CONTRIBUTING.md`
- [x] local development guide
- [x] architecture decision process
- [x] provider/plugin author tutorial
- [x] workflow author tutorial
- [x] test strategy
- [x] release process

[Contributing](../CONTRIBUTING.md) connects local setup, package ownership, test strategy, the ADR process and the existing version/release approval process. Both tutorial code blocks were extracted into disposable projects and exercised through the built CLI: strict SDK checking of the local plugin, measured character output, missing trust/version refusal, real Node command evidence, approval pause/resume, failing command and invalid transition. All temporary files were removed. Verified 38 new contributor documentation links and the full five-command baseline (1,697 tests). No public packages or releases were published.

---

## M7.6 — Community/security files

**Status:** [x] Complete and verified.

- [x] `SECURITY.md`
- [x] Code of Conduct if project wants community contributions
- [x] issue templates
- [x] PR template with verification checklist
- [x] Discussions decision/setup
- [x] dependency update policy

Added security/community policies, three issue templates, a PR verification checklist and a manual dependency update policy. GitHub private vulnerability reporting was enabled and read back as `enabled: true`; Discussions remains disabled with a documented single-queue decision. No report, issue or advisory was submitted. Verified all template frontmatter/chooser YAML, 31 local links and the full five-command baseline (1,697 tests).

---

## M7.7 — Example gallery

**Status:** [x] Complete and verified.

- [x] GPT Planner + Codex Executor
- [x] Claude Planner + Codex Executor
- [x] GPT Planner + Claude Code Executor
- [x] cross-model reviewer example
- [x] parallel reviewers
- [x] human approval gate
- [x] bugfix workflow
- [x] research workflow
- [x] CI/non-interactive workflow

The [gallery](../examples/gallery/README.md) contains nine complete configurations with prerequisites, model placeholders, validation/run/inspection commands and explicit live-provider limits. Eleven new tests load every config through the CLI, use test-only injected providers with real fixture commands, resume all three gated flows, preserve a negative parallel verdict and stop headless checks before build on failure. Verified the targeted gallery suite, 16 local links and the full five-command baseline (1,708 tests). No live provider or publication was invoked.

---

## M7.8 — Documentation site / polished README

- [ ] concise value proposition
- [ ] architecture diagram
- [ ] 60-second quick start
- [ ] animated/static TUI demo once stable
- [ ] provider support matrix
- [ ] workflow examples
- [ ] security model/limitations
- [ ] roadmap link
- [ ] badges only when meaningful

---

## M7.9 — Benchmark/evaluation harness

- [ ] define reproducible tasks for orchestration quality
- [ ] measure completion rate, retries, time, provider cost where known
- [ ] compare single-agent vs orchestrated workflows carefully
- [ ] keep evaluation fixtures versioned
- [ ] avoid marketing claims unsupported by evaluation data

---

## M7.10 — Telemetry policy

- [ ] default to no external telemetry unless explicitly designed otherwise
- [ ] if telemetry is ever added, make collection transparent, minimal, opt-in/clearly controllable, and documented
- [ ] local metrics remain useful without cloud dependency

---

# Deferred ideas — do not implement before core milestones without explicit approval

These are plausible future features, not current requirements:

- [ ] Veyra Cloud hosted control plane
- [ ] remote workers across machines
- [ ] visual drag-and-drop workflow editor
- [ ] marketplace/registry for third-party plugins/workflows
- [ ] mobile monitoring app
- [ ] autonomous model benchmarking/router that changes providers dynamically based on live performance
- [ ] organization/RBAC/team features
- [ ] enterprise audit/export features
- [ ] persistent database replacing local JSON for local-only use

The existence of a deferred idea is **not permission to expand scope** during an earlier TODO item.

---

# Definition of Done for any implementation task

A task is not complete merely because code exists. Before checking it off:

- [ ] acceptance criteria are satisfied
- [ ] unit/integration tests appropriate to the change exist
- [ ] no architecture rule in `AGENTS.md` is violated
- [ ] error paths are handled intentionally
- [ ] secrets are not logged/persisted
- [ ] docs/config examples are updated if behavior changed
- [ ] `pnpm lint` passes once M0.2 exists
- [ ] `pnpm format:check` passes once M0.2 exists
- [ ] `pnpm check` passes
- [ ] `pnpm test` passes
- [ ] `pnpm build` passes
- [ ] TODO checkbox/status is updated truthfully

---

# Recommended Codex prompt for one-task-at-a-time execution

Use this pattern when handing work to Codex:

```text
Read AGENTS.md, docs/ARCHITECTURE.md, and docs/TODO.md first.

Implement exactly TODO <TASK-ID/TITLE> and the minimum supporting changes needed for it.
Do not start later TODO items.
Preserve the repository architecture and the Veyra/ve naming rules.
Add/update tests and run every verification command required by that TODO plus the repository baseline checks.

When finished:
1. update only the completed TODO checkbox/status if all acceptance criteria pass;
2. summarize files changed and architectural decisions;
3. report the exact verification commands and results;
4. report any remaining risks/blockers;
5. stop and wait for the next task.
```

## Next task

**Next eligible: M7.8 — Documentation site / polished README.** M1.14, M4.3 and M4.5 have live checks blocked by missing API credentials; M4.4's live Claude Code smoke is blocked by native provider request timeouts; M4.7's OpenCode smoke is blocked by rejected native provider credentials. The dependent v0.1 exit/TUI tasks remain open, Dashboard implementation waits for TUI stability, and M6.3 awaits those log renderers. npm ownership, scope migration, version/changelog tooling, release CI validation and isolated global installation are verified. Public publication remains gated; independent productization work can proceed.
