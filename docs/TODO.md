# Veyra Master TODO

> **One goal. Many agents. Verified execution.**
>
> This is the canonical implementation plan for Veyra. `docs/ROADMAP.md` describes milestones at a high level; this file defines the concrete execution order for Codex and other coding agents.

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

**Depends on:** M0.1, M0.2

**Primary areas:** `.github/workflows/`

### Requirements

- [ ] Add a CI workflow for pushes to `main` and pull requests.
- [ ] Use the Node version supported by the repository and Corepack/pnpm cache.
- [ ] Run install with a frozen lockfile.
- [ ] Run `lint`, `format:check`, `check`, `test`, `build`.
- [ ] Avoid provider/API integration tests in normal CI.
- [ ] Keep secrets out of the workflow.

### Acceptance criteria

A PR with valid code gets green CI; a deliberate type error or failing test makes CI fail.

---

## M0.4 — Establish test conventions and fixtures

**Depends on:** M0.1

**Primary areas:** packages/apps tests, `examples/`, optional `test/fixtures/`

### Requirements

- [ ] Define unit vs integration vs end-to-end test conventions.
- [ ] Create at least one minimal fixture project that Veyra may safely modify during tests.
- [ ] Create reusable fake/mock `AgentAdapter` implementations for deterministic tests.
- [ ] Tests must never require an OpenAI key or a logged-in Codex CLI by default.
- [ ] Temporary test state must be isolated and cleaned up.

### Acceptance criteria

- A mock agent can produce a deterministic `AgentResult`.
- A test can create and destroy an isolated fixture workspace.

---

## M0.5 — Make the docs hierarchy explicit

**Depends on:** M0.1

### Requirements

- [ ] `README.md` = product overview and getting started.
- [ ] `docs/ARCHITECTURE.md` = stable architectural boundaries.
- [ ] `docs/ROADMAP.md` = milestone summary.
- [ ] `docs/TODO.md` = canonical detailed execution plan.
- [ ] `AGENTS.md` = coding-agent rules.
- [ ] Cross-link these documents so contributors know where to look.

### Acceptance criteria

A new contributor can identify the next task and architectural constraints without reading commit history.

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

**Depends on:** M0.1

**Primary area:** `packages/config`

### Requirements

- [ ] Add YAML parsing dependency.
- [ ] Add runtime validation for config data; do not trust parsed YAML types.
- [ ] Define config schema version (`version: 1`).
- [ ] Support at minimum:
  - project name
  - workflow preset/path
  - named agents (`planner`, `executor`, `reviewer`)
  - provider name
  - optional model
  - provider options
  - runtime max-fix-iterations
  - runtime state directory
  - approval policy
- [ ] Add defaults for optional values.
- [ ] Reject unknown/invalid critical fields with actionable messages.
- [ ] Never store API secrets in generated config.
- [ ] Expose `loadConfig(path)` and a pure `parseConfig(value)` for testing.

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

---

## M1.2 — Load and validate workflow YAML

**Depends on:** M1.1

**Primary area:** `packages/workflow`

### Requirements

- [ ] Add a loader for built-in and user-supplied workflow YAML.
- [ ] Keep workflow parsing separate from config parsing.
- [ ] Validate `name`, `version`, `start`, and step map.
- [ ] For v0.1, support these executable step types only:
  - `agent`
  - `command`
  - `human`
  - `end`
- [ ] `parallel`, `router`, and `subworkflow` remain schema-reserved/planned; return a clear unsupported-in-v0.1 error if encountered.
- [ ] Validate all transition destinations.
- [ ] Detect an obviously invalid start node and missing transition targets.
- [ ] Define how outcomes map to transitions (`success`, `failure`, `pass`, `fail`, `approved`, `rejected`, etc.).

### Tests

- load `workflows/dev.yaml`
- missing start step
- transition to missing step
- unsupported node type in v0.1
- invalid retry configuration

### Acceptance criteria

`workflows/dev.yaml` can be parsed and validated without Core needing to know YAML details.

---

## M1.3 — Harden provider-neutral protocol contracts

**Depends on:** M1.1, M1.2

**Primary area:** `packages/protocol`

### Requirements

- [ ] Review `AgentInput`, `AgentResult`, `ArtifactRef`, `VerificationResult`, `VeyraEvent` for the vertical slice.
- [ ] Add run/step metadata needed for resumability and traceability without provider fields leaking into common contracts.
- [ ] Add structured usage metadata support (tokens/cost fields optional and provider-neutral).
- [ ] Add event types needed by real execution:
  - agent started/completed/failed
  - verification started/completed
  - run paused/resumed
  - approval required/resolved
  - process/log output reference if needed
- [ ] Prefer serializable types; state/events must be JSON-compatible.
- [ ] Define a stable error representation for persisted failures.
- [ ] Avoid giant free-form provider payloads in persisted core state; provider-specific diagnostics may go under optional metadata/artifacts.

### Acceptance criteria

Mock OpenAI, Codex, Verifier, Core, CLI, and future TUI can communicate using these contracts without importing one another.

---

## M1.4 — Implement local process runtime

**Depends on:** M1.3

**Primary area:** `packages/runtime`

### Requirements

- [ ] Implement a reusable local process runner.
- [ ] Input must support executable, argv array, cwd, environment overrides, timeout, abort signal.
- [ ] Do not construct shell strings when argv execution is sufficient.
- [ ] Capture exit code, signal, stdout, stderr, duration.
- [ ] Support streaming stdout/stderr callbacks/events while still retaining final output.
- [ ] Handle executable-not-found with a clear typed error.
- [ ] Handle timeout and cancellation cleanly.
- [ ] Ensure child processes do not remain orphaned after cancellation where platform APIs permit.
- [ ] Add a maximum retained-output strategy or documented limit to avoid unbounded memory for long agent sessions.
- [ ] Do not add provider-specific behavior here.

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

---

## M1.5 — Implement deterministic shell verifier

**Depends on:** M1.4

**Primary area:** `packages/verifier`

### Requirements

- [ ] Replace scaffold with a real `ShellVerifier` built on the runtime process runner.
- [ ] Run verification commands sequentially by default.
- [ ] Stop on first failure by default; allow future policy extension without implementing parallel verification yet.
- [ ] Return one structured result per command plus aggregate success/failure.
- [ ] Record duration and bounded stdout/stderr.
- [ ] Emit verification events through an injected event sink or callback, not by importing Core.
- [ ] Treat verification as objective execution; no LLM judgment here.

### Tests

- all commands pass
- first command fails
- later command fails
- empty command list
- timeout behavior

### Acceptance criteria

The `verify` node in `workflows/dev.yaml` can execute `pnpm check`, `pnpm test`, and `pnpm build` and produce a machine-readable aggregate result.

---

## M1.6 — Implement persistent local run state

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

- [ ] Generate collision-resistant run IDs.
- [ ] Persist original goal/input.
- [ ] Persist current step, status, retry counts, timestamps, last outcome.
- [ ] Append structured events to JSONL.
- [ ] Use atomic write/rename strategy for mutable JSON state where practical.
- [ ] Ensure parent directories are created automatically.
- [ ] Provide read/list/load APIs needed by `status`, `review`, and `resume`.
- [ ] Do not persist API keys or raw environment secrets.
- [ ] Define behavior for corrupt/incomplete state files with actionable errors.
- [ ] Make state directory configurable; default `.veyra`.

### Tests

- create run
- update run
- append/read events
- reload after process restart
- active run pointer
- corrupted state handling

### Acceptance criteria

A run can stop after one step, the Node process can exit, and a new process can load enough information to know the run status and next step.

---

## M1.7 — Implement OpenAI reasoning adapter

**Depends on:** M1.3

**Primary area:** `plugins/openai`

### Requirements

- [ ] Use the official OpenAI SDK and the current Responses API.
- [ ] API key is read from standard environment/config indirection; never stored in `.veyra` state.
- [ ] Model is configurable; do not hard-code a single model as an architectural dependency.
- [ ] Implement `AgentAdapter.run()` for planner/reviewer roles.
- [ ] Build a role-aware system/developer instruction boundary that includes goal, current step, relevant prior artifacts/results, and explicit requested output shape.
- [ ] Prefer structured output / JSON schema where supported so planner/reviewer outcomes are parseable.
- [ ] Normalize provider output into `AgentResult`.
- [ ] Capture optional token/usage metadata.
- [ ] Add timeout/cancellation support where SDK allows.
- [ ] Redact secrets from errors/logs.
- [ ] Unit tests use a mocked SDK/client; no network in normal test suite.

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

---

## M1.8 — Implement Codex CLI executor adapter

**Depends on:** M1.4, M1.3

**Primary area:** `plugins/codex`

### Requirements

- [ ] Implement **CLI mode first**; SDK mode may remain planned.
- [ ] Detect whether the `codex` executable is available.
- [ ] Before coding the final invocation, inspect the currently installed Codex CLI help/version rather than assuming stale flags.
- [ ] Run Codex in the target repository working directory through `packages/runtime`.
- [ ] Convert planner/fix instructions into a clear execution prompt.
- [ ] Preserve user/project `AGENTS.md` instructions.
- [ ] Capture Codex stdout/stderr and exit metadata.
- [ ] Normalize completion into `AgentResult`.
- [ ] Do not parse fragile human terminal formatting when a supported structured/non-interactive output mode is available.
- [ ] Support cancellation and timeout.
- [ ] Do not manage/store the user's Codex login token; rely on the installed Codex authentication mechanism.
- [ ] Add a `doctor` capability check for executable/version/auth readiness where detectable without destructive actions.

### Tests

- mocked runtime success
- executable missing
- non-zero exit
- timeout/cancel
- prompt construction preserves goal/task/context

### Acceptance criteria

Given a deterministic mocked Codex process result, the adapter returns a valid `AgentResult`; when a real logged-in Codex CLI is available, a manual smoke test can modify a disposable fixture repository.

---

## M1.9 — Implement the v0.1 Core orchestration loop

**Depends on:** M1.2–M1.8

**Primary area:** `packages/core`

### Requirements

- [ ] Core receives already-loaded config/workflow/providers; it does not parse YAML or instantiate vendor SDKs directly.
- [ ] Execute `agent`, `command`, `human`, and `end` steps.
- [ ] Resolve transitions through `packages/workflow`.
- [ ] Persist state before/after meaningful transitions.
- [ ] Emit structured events for run and step lifecycle.
- [ ] Pass relevant previous outputs/artifacts to later steps without dumping unlimited historical text.
- [ ] Convert verifier aggregate result into workflow outcome (`success`/`failure`).
- [ ] Convert reviewer output into `pass`/`fail` outcome.
- [ ] End with clear run status: completed, failed, paused.
- [ ] Ensure thrown provider/runtime errors become persisted run failures with useful context.
- [ ] No direct imports from `plugins/openai` or `plugins/codex`.

### Tests

Use mock adapters/verifier to test:

- happy path plan → execute → verify → review → done
- verification failure routes to fix
- reviewer failure routes to fix
- provider error fails run cleanly
- missing adapter produces actionable error

### Acceptance criteria

The whole default dev workflow executes deterministically using mocks and produces persisted state/events.

---

## M1.10 — Enforce repair-loop retry limits

**Depends on:** M1.9

**Primary areas:** `packages/core`, `packages/workflow`

### Requirements

- [ ] Track retry count per relevant step/loop, not one ambiguous global counter.
- [ ] Respect workflow retry max and/or runtime default according to documented precedence.
- [ ] Avoid infinite loops even with malformed workflows.
- [ ] When max retries are reached, fail or pause according to documented v0.1 policy; default should be fail with clear reason unless a human gate explicitly handles it.
- [ ] Persist retry state across `resume`.
- [ ] Emit retry-related event/metadata.

### Tests

- succeeds before max
- reaches max and stops
- retry count survives reload/resume

### Acceptance criteria

A workflow that repeatedly fails cannot run forever.

---

## M1.11 — Implement human approval nodes

**Depends on:** M1.9, M1.6

**Primary areas:** `packages/core`, `packages/workflow`, `packages/protocol`

### Requirements

- [ ] `human` step pauses the run and emits `approval.required`.
- [ ] Persist approval message/context.
- [ ] Support approved/rejected outcomes.
- [ ] Approval resolution must be explicit and auditable in events.
- [ ] A paused process may exit safely; later `resume` continues from persisted state.
- [ ] Core API should expose a way for CLI/TUI/Dashboard to resolve approval without UI-specific logic inside Core.

### Tests

- pause at gate
- approve then resume
- reject branch
- restart process between pause and approval

### Acceptance criteria

A real workflow can stop before a risky step and continue only after explicit user approval.

---

## M1.12 — Implement CLI application commands

**Depends on:** M1.1–M1.11

**Primary area:** `apps/cli`

The public executable is **`ve`**.

### `ve init`

- [ ] Detect existing `veyra.yaml` and avoid destructive overwrite without confirmation/flag.
- [ ] Generate a minimal working `veyra.yaml`.
- [ ] Ensure `.veyra/` runtime directories are ignored appropriately without blindly modifying unrelated ignore rules.
- [ ] Print next-step instructions.

### `ve run <goal>`

- [ ] Require or intelligently load a workflow.
- [ ] Load config, workflow, providers, state store.
- [ ] Start a new run.
- [ ] Print concise live events in headless CLI mode.
- [ ] Return meaningful process exit code.
- [ ] Support at least `--workflow`, `--config`, and `--non-interactive` if needed by implementation.

### `ve status`

- [ ] Show active/latest run ID, status, current step, retry count, start/update times.
- [ ] Support a run ID argument/flag.

### `ve review`

- [ ] Show the latest reviewer result and relevant verification summary/artifact references.
- [ ] Do not require rerunning an agent.

### `ve resume`

- [ ] Load a paused/interrupted run and continue from persisted state.
- [ ] Handle no resumable run gracefully.

### `ve doctor`

- [ ] Node/pnpm/platform information.
- [ ] Config validity when inside a Veyra project.
- [ ] provider readiness: OpenAI env presence (without printing key), Codex executable/version, working directory permissions.
- [ ] Clearly distinguish required vs optional provider readiness.

### CLI UX rules

- [ ] Human-readable output by default.
- [ ] Reserve/plan a machine-readable `--json` mode; implement in v0.1 if low-cost.
- [ ] No ANSI assumptions when stdout is non-TTY.
- [ ] Good error messages and non-zero exit codes.

### Acceptance criteria

The complete mock vertical slice can be driven using only `ve` commands.

---

## M1.13 — Add deterministic end-to-end tests

**Depends on:** M1.12

**Primary areas:** integration/e2e tests and fixture projects

### Required scenarios

- [ ] happy path completes in one attempt
- [ ] verifier fails once, executor fixes, then passes
- [ ] reviewer fails once, executor fixes, then passes
- [ ] max retries reached
- [ ] human gate pauses and resumes
- [ ] process restart/resume from persisted state
- [ ] invalid config fails before provider execution
- [ ] missing Codex executable produces actionable error
- [ ] provider failure is persisted

### Acceptance criteria

All scenarios run without real network/provider credentials by using fake adapters and fixture repositories.

---

## M1.14 — Add opt-in real GPT + Codex integration smoke test

**Depends on:** M1.13

### Requirements

- [ ] Never run in default CI.
- [ ] Require explicit environment flag/command.
- [ ] Use a disposable fixture repository/worktree.
- [ ] Planner asks for a tiny deterministic change.
- [ ] Codex makes the change.
- [ ] Verifier checks it.
- [ ] Reviewer evaluates evidence.
- [ ] Test cleans up or prints the retained fixture location for debugging.
- [ ] Document approximate API use/cost considerations.

### Acceptance criteria

On a developer machine with OpenAI credentials and logged-in Codex CLI, one command demonstrates the real closed loop.

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

- [ ] publish/document version 1 schema
- [ ] strict validation with actionable paths/errors
- [ ] forward-version rejection behavior
- [ ] define compatibility policy
- [ ] add schema examples

---

## M3.2 — Typed context and step outputs

- [ ] define how step outputs are named and referenced
- [ ] support safe template/context references in later step inputs
- [ ] prevent accidental dumping of unlimited prior context
- [ ] define artifact references vs inline data
- [ ] persist resolved inputs for audit/debugging where safe

---

## M3.3 — Conditional branching

- [ ] richer outcome conditions beyond simple `on` string lookup if required
- [ ] deterministic branch resolution
- [ ] validation for unreachable/missing paths where feasible
- [ ] tests for branch combinations

---

## M3.4 — Parallel steps

- [ ] execute independent child steps concurrently
- [ ] define fail-fast vs wait-all policy
- [ ] cancellation propagation
- [ ] deterministic result aggregation order
- [ ] concurrency limit
- [ ] persist child states independently
- [ ] TUI-compatible events

---

## M3.5 — Router nodes

- [ ] deterministic/static router rules first
- [ ] optional agent-powered router later in the same abstraction
- [ ] route decision persisted as evidence
- [ ] invalid target protection

---

## M3.6 — Subworkflows

- [ ] reference built-in or user workflow
- [ ] namespace child step IDs/run context
- [ ] input/output mapping
- [ ] error propagation policy
- [ ] recursion/depth guard

---

## M3.7 — Consensus / Judge nodes

- [ ] support multiple independent reviewers
- [ ] aggregation modes such as all-pass, quorum, explicit judge
- [ ] deterministic verifier evidence remains separate and may be mandatory
- [ ] cross-model review is supported but not required
- [ ] persist each review independently

---

## M3.8 — Workflow-level execution policies

- [ ] step timeout
- [ ] retry/backoff policy
- [ ] concurrency limit
- [ ] human approval policy
- [ ] failure strategy
- [ ] optional cost/token budget hooks
- [ ] loop/cycle safety guards

---

## M3.9 — Harden built-in presets

### `dev.yaml`

- planner → executor → verify → reviewer → fix loop

### `bugfix.yaml`

- reproduce/diagnose → fix → targeted verify → broader verify → review

### `review.yaml`

- inspect/diff → deterministic checks → one or more reviewers → report; no mutation by default

### `research.yaml`

- research/planning agents → synthesis/judge → human output; execution tools optional

For each preset:

- [ ] documented purpose
- [ ] declared required roles/capabilities
- [ ] tests with fake adapters
- [ ] sane bounded retries
- [ ] no surprising destructive behavior

---

## M3.10 — User-defined workflow UX

- [ ] `ve run --workflow path/to/workflow.yaml`
- [ ] workflow validation command, e.g. `ve workflow validate ...`
- [ ] list built-in workflows
- [ ] explain missing required agents/providers before execution
- [ ] examples for simple, branching, parallel, and approval workflows

### v0.3 exit criteria

- [ ] users can author workflows without changing TypeScript
- [ ] sequential/branching/parallel/subworkflow/judge concepts are persisted and resumable
- [ ] malformed/cyclic workflows cannot create uncontrolled execution

---

# M4 — v0.4 Provider and plugin ecosystem

Goal: make Veyra genuinely heterogeneous instead of an OpenAI/Codex wrapper.

## M4.1 — Provider capability model

**Primary areas:** `packages/protocol`, `packages/sdk`, `packages/core`

- [ ] define provider/agent capabilities (reasoning, code execution, vision, web/research if supported, structured output, tool use, local CLI, etc.)
- [ ] capability discovery API
- [ ] provider metadata/version/readiness
- [ ] Core routes by role/capability, not hard-coded provider names

---

## M4.2 — Plugin registry and loading

- [ ] define official plugin contract in `@veyra/sdk`
- [ ] explicit registration for built-ins
- [ ] safe third-party plugin loading strategy
- [ ] plugin config namespace
- [ ] plugin version compatibility checks
- [ ] plugin doctor/readiness hook
- [ ] clear error when plugin missing

---

## M4.3 — Claude API provider

**Primary area:** `plugins/claude`

- [ ] reasoning/reviewer adapter
- [ ] structured result normalization
- [ ] usage metadata
- [ ] cancellation/timeouts
- [ ] mocked tests
- [ ] opt-in smoke test

---

## M4.4 — Claude Code executor

**Primary area:** `plugins/claude-code`

- [ ] runtime-based CLI invocation
- [ ] executable/readiness detection
- [ ] non-interactive/structured mode when available
- [ ] cwd/cancellation/timeout/log capture
- [ ] mocked and opt-in real smoke tests

---

## M4.5 — Gemini API provider

**Primary area:** `plugins/gemini`

- [ ] planner/reviewer adapter
- [ ] multimodal/vision capability surfaced only if actually supported by configured model
- [ ] structured results and usage normalization
- [ ] tests/smoke test

---

## M4.6 — Gemini CLI executor

- [ ] decide whether it shares `plugins/gemini` or needs a separate package; do not silently change top-level architecture—document decision first
- [ ] runtime-based invocation
- [ ] readiness and auth detection
- [ ] structured/non-interactive output
- [ ] tests

---

## M4.7 — OpenCode executor

**Primary area:** `plugins/opencode`

- [ ] runtime-based invocation
- [ ] readiness detection
- [ ] normalize result
- [ ] cancellation/timeouts
- [ ] tests/smoke test

---

## M4.8 — OpenAI-compatible/local-model adapter

- [ ] support configurable base URL where appropriate
- [ ] do not assume every OpenAI-compatible server supports every Responses feature
- [ ] capability flags/fallback behavior
- [ ] examples for local models
- [ ] ensure local provider failures are actionable

---

## M4.9 — Authentication and secret-handling policy

- [ ] environment/standard provider auth first
- [ ] never echo secrets
- [ ] never persist provider keys in run state
- [ ] redaction utility for logs/errors
- [ ] `ve doctor` reports presence/readiness without exposing values
- [ ] document precedence of env/config/provider native login

---

## M4.10 — Agent role profiles

- [ ] planner profile
- [ ] executor profile
- [ ] researcher profile
- [ ] reviewer profile
- [ ] judge profile
- [ ] role-specific prompt/context contracts without hard-coding one provider

---

## M4.11 — Optional automatic provider routing

- [ ] begin with explicit deterministic rules, not an opaque autonomous router
- [ ] route by required capability, configured preference, availability, optional budget
- [ ] record why a provider was selected
- [ ] allow users to pin a provider/model
- [ ] graceful fallback policy is explicit, never silent

### v0.4 exit criteria

- [ ] at least two reasoning providers and two coding-agent executors work
- [ ] workflows are provider-agnostic
- [ ] third-party adapter path is documented/tested
- [ ] provider choice can differ by workflow role

---

# M5 — v0.5 Web Dashboard / Agent Control Center

Goal: provide a visual management surface for multiple projects/runs while reusing the same Core/event/state contracts.

## M5.1 — Dashboard technical foundation

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

- [ ] write design doc before implementation
- [ ] authentication
- [ ] secure transport
- [ ] worker identity/capabilities
- [ ] no arbitrary unauthenticated remote command execution
- [ ] local-only mode remains first-class

### v0.5 exit criteria

- [ ] dashboard can observe and control local Veyra runs
- [ ] multi-project view works
- [ ] approvals, workflow state, reviews, verification and metrics are visual
- [ ] Core remains the single orchestration source of truth

---

# M6 — Reliability, security, and engineering hardening

These tasks may begin earlier when required, but must all be complete before claiming production-grade reliability.

## M6.1 — Workspace isolation strategy

- [ ] support optional git worktree isolation per run/task
- [ ] define default behavior for dirty working trees
- [ ] prevent one concurrent run from silently overwriting another
- [ ] preserve/clean worktrees predictably
- [ ] show working directory/worktree in status/UI

---

## M6.2 — Command execution safety model

- [ ] distinguish provider-generated commands from configured verifier commands
- [ ] define approval policy for high-risk operations
- [ ] avoid implicit shell interpolation
- [ ] document that local coding agents may still execute commands according to their own permission model
- [ ] surface effective permission mode to user where detectable

---

## M6.3 — Secret redaction

- [ ] centralized redaction helper
- [ ] redact common API key/token patterns and configured secret env names
- [ ] apply to events, stderr excerpts, persisted errors, Dashboard/TUI logs
- [ ] test that known fixture secrets never reach `.veyra/runs`

---

## M6.4 — Crash recovery and idempotency

- [ ] atomic state updates
- [ ] distinguish `running` from stale/interrupted after process death
- [ ] recovery policy for an agent step that may have partially mutated files
- [ ] `resume` must not blindly repeat destructive completed work
- [ ] persist step attempt IDs and completion boundaries

---

## M6.5 — Concurrency and locking

- [ ] project/run lock design
- [ ] allow safe multiple runs when workspaces are isolated
- [ ] prevent duplicate resume of the same run
- [ ] stale lock recovery

---

## M6.6 — Cancellation semantics

- [ ] user cancel
- [ ] timeout cancel
- [ ] parent cancel propagates to parallel/subworkflow children
- [ ] process tree cleanup
- [ ] state records cancellation reason

---

## M6.7 — Log/artifact retention

- [ ] bounded inline logs
- [ ] large outputs stored as artifacts/files
- [ ] retention/cleanup command or policy
- [ ] artifact metadata includes producer/step/timestamp
- [ ] avoid repo bloat by default

---

## M6.8 — Prompt/context safety and provenance

- [ ] clearly separate project instructions, workflow instructions, previous-agent outputs, tool evidence
- [ ] mark untrusted external/research content where possible
- [ ] Reviewer should rely on verifier evidence rather than blindly trusting Executor claims
- [ ] persist evidence references used for important decisions

---

## M6.9 — Cross-platform support

- [ ] macOS support verified
- [ ] Linux support verified
- [ ] Windows support policy explicitly decided/tested before claiming support
- [ ] path, signals, process termination, shell behavior covered by tests where practical

---

# M7 — Open-source productization and releases

Goal: turn a working internal tool into a credible public developer project.

## M7.1 — Public package strategy

- [ ] decide which packages are published (`@veyra/core`, `@veyra/sdk`, official plugins, CLI package)
- [ ] executable remains `ve`
- [ ] verify npm package/scope ownership and naming before first release
- [ ] remove `private: true` only from packages intentionally published
- [ ] exports/types/files fields are correct

---

## M7.2 — Versioning and changelog

- [ ] semantic versioning policy
- [ ] changeset/release-note workflow
- [ ] changelog generation
- [ ] plugin/core compatibility version policy

---

## M7.3 — Release CI

- [ ] GitHub release workflow
- [ ] npm provenance/signing where supported
- [ ] build/test before publish
- [ ] tag/version consistency checks
- [ ] no secret leakage in logs

---

## M7.4 — Installation experience

- [ ] npm installation documented
- [ ] verify global install exposes `ve`
- [ ] optional Homebrew distribution after npm path is stable
- [ ] upgrade/uninstall docs
- [ ] `ve doctor` useful immediately after install

---

## M7.5 — Contributor documentation

- [ ] `CONTRIBUTING.md`
- [ ] local development guide
- [ ] architecture decision process
- [ ] provider/plugin author tutorial
- [ ] workflow author tutorial
- [ ] test strategy
- [ ] release process

---

## M7.6 — Community/security files

- [ ] `SECURITY.md`
- [ ] Code of Conduct if project wants community contributions
- [ ] issue templates
- [ ] PR template with verification checklist
- [ ] Discussions decision/setup
- [ ] dependency update policy

---

## M7.7 — Example gallery

- [ ] GPT Planner + Codex Executor
- [ ] Claude Planner + Codex Executor
- [ ] GPT Planner + Claude Code Executor
- [ ] cross-model reviewer example
- [ ] parallel reviewers
- [ ] human approval gate
- [ ] bugfix workflow
- [ ] research workflow
- [ ] CI/non-interactive workflow

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

**Start with M0.3 — Add CI for pull requests and main.**
