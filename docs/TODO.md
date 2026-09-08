# Veyra Master TODO

> **Your project. Your agents. One shared context.**
>
> This is the canonical implementation plan for Veyra after the September 2026 product pivot.

Read [`PRODUCT.md`](../PRODUCT.md) first. Then read [`AGENTS.md`](../AGENTS.md) and [`ARCHITECTURE.md`](ARCHITECTURE.md) before implementing any task.

The pre-pivot API-first plan remains available in Git history and is referenced by [`TODO_LEGACY.md`](TODO_LEGACY.md). It is **not** the execution plan anymore.

---

# 0. Product priority

Veyra's first product proof is no longer "OpenAI API planner + Codex executor".

The P0 goal is:

```text
ChatGPT
  ↓ plan/review
Veyra Bridge
  ↓
Veyra Project + local daemon
  ↓
Codex Native (existing ChatGPT login)
  ↓ edit / test / diff
Veyra shared state
  ↓
ChatGPT
  ↓ review / repair / next plan
```

The core path must **not require `OPENAI_API_KEY`**.

OpenAI API, Anthropic API, Gemini API and other API providers remain valid optional integrations. They do not block P0, TUI work or the first release-worthy product demo.

The first supported team is deliberately narrow:

- ChatGPT = planner/reviewer surface;
- Codex native client/CLI = executor;
- local verifier = objective evidence;
- Veyra Project = shared state and coordination boundary.

Additional agents and custom LLMs are deferred until this loop works convincingly.

---

# 1. Autopilot execution rules

Coding agents should work top-to-bottom through this file.

For each task:

1. Read `PRODUCT.md`, `AGENTS.md`, `docs/ARCHITECTURE.md`, this TODO, and the files owned by the task.
2. Select the first unchecked task whose dependencies are complete unless the user explicitly chooses another task.
3. Change the task status to `[-]` when beginning substantial implementation.
4. Implement that task and only the minimum supporting changes it requires.
5. Add meaningful unit/integration/E2E tests.
6. Run task-specific checks plus the repository baseline:

   ```bash
   pnpm lint
   pnpm format:check
   pnpm check
   pnpm test
   pnpm build
   ```

7. Do not claim a live integration passed unless it actually ran against the intended real surface.
8. Mark `[x]` only when all acceptance criteria pass.
9. Use `[!]` for a genuine blocker and record the exact blocker/evidence.
10. Prefer one focused commit per TODO item.
11. Continue automatically to the next eligible TODO unless a human-approval boundary is reached.

## Status markers

- `[ ]` not started
- `[-]` in progress / partially complete
- `[x]` complete and verified
- `[!]` blocked

## Human-approval boundaries

Stop for explicit approval before:

- public npm publication;
- GitHub/public release;
- production deployment;
- destructive Git history operations;
- destructive user-data migration;
- paid-resource creation;
- handling credentials in a new way;
- a major architecture change that contradicts `PRODUCT.md` or `ARCHITECTURE.md`.

Normal local implementation, testing and plan/execute/review iterations should continue automatically.

---

# 2. Existing verified foundation

Do **not** rewrite working foundations merely because the product priority changed.

The repository already has substantial verified work:

- pnpm monorepo, lint/format/typecheck/tests/build and CI;
- provider-neutral protocol contracts;
- workflow DSL, branching, parallelism, routers, subworkflows and consensus;
- local process runtime;
- deterministic shell verifier;
- persisted run state and resumability;
- bounded retries and human approval nodes;
- CLI commands including `ve init/run/status/review/resume/doctor`;
- Codex native adapter and deterministic/native fixture coverage;
- optional API provider adapters;
- plugin SDK and provider capability metadata;
- crash recovery, locking, cancellation and worktree support;
- release/package tooling under `@veyraoss`;
- security, retention, evaluation and telemetry policies.

These are infrastructure for the new product direction.

The architectural pivot is about **what is first-class and what blocks the product**, not deleting prior work.

---

# P0 — Project-centered GPT ↔ Codex Native Bridge

Goal: prove Veyra's reason to exist.

A user should be able to work in a real ChatGPT conversation, select/bind a Veyra project, let ChatGPT hand implementation to an already-authenticated Codex, receive the execution evidence back automatically, and let ChatGPT review/continue without manual copy/paste.

No OpenAI API key is required for this path.

## P0.0 — Record the product pivot

**Status:** [x] Complete and documented.

**Depends on:** none

### Deliverables

- [x] canonical `PRODUCT.md` defining project-centered/native-auth-first behavior;
- [x] replace the API-first TODO with this P0 plan;
- [x] preserve access to the historical plan through Git history/legacy pointer;
- [x] update `AGENTS.md` with project-first/native-auth-first rules;
- [x] update `docs/ARCHITECTURE.md` with Project, Daemon and Bridge responsibilities;
- [x] update `docs/ROADMAP.md` so API smoke is optional/non-blocking;
- [x] update README positioning and current priority.

P0.0 intentionally changes product priority without discarding verified engine/provider/security work.

---

## P0.1 — Define Veyra Project as a first-class model

**Status:** [x]

**Depends on:** P0.0

**Primary areas:** new `packages/project` (preferred), `packages/protocol`, `packages/config`, CLI

### Goal

Represent a Veyra project explicitly instead of treating a config file/run as the only root object.

A project maps to one real local folder.

### Requirements

- [x] define a provider-neutral `ProjectId` and typed project descriptor;
- [x] project has canonical absolute path and display name;
- [x] project identity must remain stable across process restarts;
- [x] detect/handle duplicate project ids intentionally;
- [x] define `.veyra/project.yaml` (or equivalent documented project metadata file);
- [x] separate project metadata from workflow/provider config where practical;
- [x] never require provider credentials to create/open a project;
- [x] support opening an existing initialized project from any nested subdirectory;
- [x] fail clearly if the configured project path no longer exists;
- [x] path handling must resist accidental traversal/symlink confusion where security-relevant.

### Expected project layout

```text
my-project/
├── application files...
└── .veyra/
    ├── project.yaml
    ├── state.json
    ├── context/
    ├── handoffs/
    ├── runs/
    └── artifacts/
```

Do not create empty directories merely for aesthetics if they are not yet needed, but the ownership/layout contract must be documented.

### Tests

- initialize a project in a fixture folder;
- reopen from project root;
- reopen from nested directory;
- invalid/missing path;
- duplicate id behavior;
- spaces/unicode path;
- symlink/path-boundary behavior;
- no network/provider requirement.

### Acceptance criteria

A provider-free process can create, close and reopen the same typed Veyra Project and locate its project-owned `.veyra` state reliably.

Verification: 24 new Project/contract tests include three cold provider-free processes, nested/symlink paths and identity conflicts. `pnpm lint`, `pnpm format:check`, `pnpm check`, `pnpm test` (1,751 tests) and `pnpm build` passed; frozen offline installation also passed. See `packages/project/README.md` for metadata and relocation behavior.

---

## P0.2 — Add a lightweight global Project Registry

**Status:** [x]

**Depends on:** P0.1

**Primary area:** `packages/project`

### Goal

Allow Veyra surfaces/daemon to find known projects without copying workflow state outside the project.

### Requirements

- [x] global registry under `~/.veyra/projects.json` (or documented platform equivalent);
- [x] registry stores only locator/identity metadata;
- [x] project-owned run/context/workflow state remains in the project folder;
- [x] add project register/unregister/list/get operations;
- [x] make writes atomic enough to survive interruption;
- [x] guard concurrent writers;
- [x] detect moved/deleted projects and surface stale entries clearly;
- [x] avoid silently deleting stale entries;
- [x] do not store provider credentials or chat transcripts;
- [x] allow test-specific registry roots so tests never touch the real home directory.

### CLI target

```text
ve projects
ve project add <path>
ve project remove <project-id>
ve project show <project-id>
```

Exact UX may evolve, but the project registry API must exist independently of presentation.

### Acceptance criteria

Two separate Veyra processes can discover the same registered project and agree on its canonical path without reading unrelated project state.

Verification: five independent concurrent writers and a second cold reader agree on the registry; killed-writer recovery, stale/duplicate identity, malformed/linked registry and separate-process CLI tests pass. All five baseline commands passed (1,762 tests), including isolated packing of the CLI dependency closure; frozen offline installation passed.

---

## P0.3 — Define the Shared Project State contract

**Status:** [x]

**Depends on:** P0.1

**Primary areas:** `packages/project`, `packages/protocol`, state store

### Goal

Make `.veyra/` the shared blackboard between ChatGPT-facing surfaces, Veyra and Codex.

### Requirements

- [x] define project context categories: goal, constraints, decisions, active plan, current task;
- [x] define structured handoff envelope;
- [x] define structured execution result envelope;
- [x] define review/next-action envelope;
- [x] connect handoffs to existing run/event/artifact ids instead of duplicating unbounded data;
- [x] preserve provenance: who/which surface produced each decision or handoff;
- [x] include schema/version metadata;
- [x] handoff/result structures must be JSON-serializable and provider-neutral;
- [x] support bounded summaries/references rather than persisting arbitrary full chat transcripts;
- [x] document what is project-shared vs session-local;
- [x] credentials/tokens must never appear in shared state;
- [x] retain current secret-redaction guarantees.

### Required design principle

Veyra does **not** make ChatGPT and Codex share complete conversation histories.

They share the engineering state needed to continue work:

```text
goal
plan
acceptance criteria
constraints
decisions
changed files
diff/evidence
verification
review
next action
```

### Acceptance criteria

A fake planner and fake executor in separate processes can exchange a complete task/result solely through the Project Shared State contract, with provenance and no direct in-memory coupling.

Verification: 25 new contract/store tests pass, including separate fake planner/executor/reviewer processes, revision conflicts, bounded cross-project evidence, malformed/linked state and secret redaction. All five baseline commands passed (1,787 tests). One existing 5-second Core test timed out under initial concurrent load; its unchanged isolated run and full rerun passed. See `docs/PROJECT-STATE.md`; this is contract proof, not real ChatGPT bridge proof.

---

## P0.4 — Implement the local Veyra Daemon

**Status:** [x]

**Depends on:** P0.2, P0.3

**Primary areas:** new `packages/daemon` (preferred), CLI

### Goal

Provide one local coordinator that multiple Veyra surfaces can talk to while project work continues.

### Requirements

- [x] add `ve daemon start` / `ve daemon stop` / `ve daemon status` or a similarly clear lifecycle;
- [x] daemon must bind locally by default;
- [x] no cloud dependency;
- [x] persist only non-secret daemon metadata required for discovery;
- [x] single-instance or well-defined multi-instance behavior;
- [x] stale PID/socket recovery;
- [x] clean shutdown/cancellation;
- [x] project registry integration;
- [x] structured logging with existing redaction rules;
- [x] bounded resource use;
- [x] no provider login copying;
- [x] daemon must not become the owner of project business state; Project remains source of truth.

### Acceptance criteria

A second process can discover a running daemon, query health and list registered projects, then the daemon can be restarted without losing project state.

Verification: independent daemon/client/CLI processes, normal restart, killed-owner socket recovery, cancellation, private permissions, bounded redacted logging and malformed discovery tests passed. All five baseline commands passed (1,795 tests); frozen offline installation passed. `ve daemon start` is an explicit foreground service. See `packages/daemon/README.md` for lifecycle and the local-user trust boundary.

---

## P0.5 — Define Daemon IPC / Tool API

**Status:** [x]

**Depends on:** P0.4

**Primary areas:** daemon, protocol, SDK

### Goal

Expose a small stable local API usable by CLI/TUI/future ChatGPT bridge.

### Minimum operations

- [x] `projects.list`;
- [x] `projects.get`;
- [x] `projects.register`;
- [x] `runs.dispatch`;
- [x] `runs.get`;
- [x] `runs.wait` or event subscription;
- [x] `runs.cancel`;
- [x] `handoffs.get`;
- [x] `results.get`;
- [x] health/readiness operation.

### Requirements

- [x] typed/versioned request/response contracts;
- [x] local caller authentication/trust model documented;
- [x] never expose arbitrary filesystem operations as a generic bridge primitive;
- [x] project id must scope project operations;
- [x] bounded payloads and artifact references;
- [x] event streaming or polling must not busy-loop;
- [x] explicit errors for daemon unavailable/project missing/run missing;
- [x] tests must run without external network/provider access.

### Acceptance criteria

A test client in another process can register/open a project, dispatch a fake run, wait for completion and fetch a structured result through the daemon API.

Verification: a separate daemon and external client registered/opened a Project, dispatched a fake executor, ran a real local Verifier and fetched a structured result whose evidence IDs resolve to Core events. UUID replay refusal, Project scoping, cancellation, bounded waits, shutdown/persistence races, restart and incomplete-result behavior passed. All five baseline commands passed (1,814 tests), as did frozen offline installation. The first full run hit an existing 5-second consensus-test timeout; the unchanged case passed alone in 0.7 seconds, then the complete suite passed without relaxing assertions/timeouts. Local trust, limits and explicit workflow composition are documented in `packages/daemon/README.md`.

---

## P0.6 — Make native Codex readiness/auth the default executor path

**Status:** [x]

**Depends on:** P0.5

**Primary areas:** `plugins/codex`, runtime, daemon, CLI doctor

### Goal

Use the user's already-installed/already-authenticated Codex instead of requiring an OpenAI API key.

### Requirements

- [x] detect Codex executable/version;
- [x] detect readiness/authentication using supported native behavior without reading credentials;
- [x] distinguish installed-but-not-authenticated from executable-missing;
- [x] `ve doctor` should treat native Codex readiness as sufficient for executor readiness;
- [x] OpenAI API key absence must be shown as optional, not a core failure, for the native golden path;
- [x] do not copy Codex auth/session token files;
- [x] do not log credential material;
- [x] document existing ChatGPT/Codex login ownership clearly;
- [x] support explicit executable path override for tests/advanced users.

### Acceptance criteria

On a machine with Codex already logged in through its normal user flow, Veyra reports the native Codex executor ready without `OPENAI_API_KEY`.

Verification: with `OPENAI_API_KEY` unset, default `ve doctor --json` and explicit `/Applications/ChatGPT.app/Contents/Resources/codex` override both reported native executor ready on `codex-cli 0.153.4`; the supported native status command reports ChatGPT login. No credential files were inspected/copied, and raw login diagnostics are excluded from doctor output. Default doctor treats API integrations as optional; `--config`/`--workflow` retains explicit optional-workflow readiness checks. Missing/unauthenticated/unknown states, probe failures, output bounds and redaction tests passed. All five baseline commands passed (1,820 tests), along with isolated `pnpm installation:check`. Login readiness does not claim live model invocation; that proof belongs to the native dispatch E2E.

---

## P0.7 — Add project-bound Codex session continuity

**Status:** [x]

**Depends on:** P0.6, P0.3

**Primary areas:** Codex adapter, daemon, project state

### Goal

Allow Veyra to start and continue Codex work associated with one project/run.

### Requirements

- [x] define a safe provider-neutral session reference type;
- [x] create a new Codex execution/session for a project task using supported native interfaces;
- [x] resume/continue a known session where Codex supports it;
- [x] bind stored session reference to project id/run id;
- [x] never persist authentication credentials;
- [x] session references must be optional/recoverable if the native tool changes/loses history;
- [x] project working directory must be explicit;
- [x] preserve existing permission/sandbox visibility;
- [x] cancellation and timeout use existing Runtime semantics;
- [x] collect final native result and relevant structured metadata.

### Acceptance criteria

Two separate Veyra processes can dispatch then continue a Codex task for the same test project using only the stored safe session reference/native client state.

If native Codex does not expose reliable resumable session semantics, document the limitation and preserve continuity through Project Shared State instead of scraping private storage.

Verification: `env -u OPENAI_API_KEY pnpm --filter @veyraoss/codex smoke:session` passed with native `codex-cli 0.153.4`. Two independent Veyra processes created then resumed session `01a081cb-cf95-72d3-a7e4-f46ac48ccd4c` for one disposable Project/run, verified both scoped edits, preserved protected files, and recalled prior native context absent from the stored reference. The fixture was removed; native history remains native-client-owned. Protocol/store/Core/daemon tests validate safe optional references, UUID and scope enforcement, failures and Runtime controls. All five baseline commands passed (1,843 tests), plus frozen offline installation. The first full run exposed missing development workspace links in the isolated packaging fixture; those links were added and the complete suite then passed. See `docs/CODEX.md` for exact commands and explicit Shared State recovery when native history is unavailable.

---

## P0.8 — Bind Project roles to native Codex

**Status:** [x]

**Depends on:** P0.7

### Goal

Make a Veyra Project able to say "Codex is this project's executor" independent of API provider configuration.

### Requirements

- [x] project-level role binding for `executor: codex/native`;
- [x] optional session continuity metadata;
- [x] role/provider remains separable in protocol;
- [x] defaults must not hardcode future multi-provider architecture into Core;
- [x] clear doctor/status output showing effective role binding;
- [x] no requirement to configure planner/reviewer API keys for a native-executor-only dispatch.

### Acceptance criteria

A project can be initialized, bind native Codex as executor, restart Veyra and retain that binding safely.

Verification: Project role bindings survive independent CLI processes and daemon startup without `veyra.yaml` or `OPENAI_API_KEY`. Protocol/store tests cover safe session references, provider/role separation, private atomic writes, stale revisions, identity changes and unsafe metadata. Doctor/status show the effective binding; new runs never reuse another run's session. All five baseline commands passed (1,859 tests). Parallel full-suite runs hit existing 5-second Core timing limits; original tests passed with package execution serialized, then final `pnpm test` passed without changing assertions or timeouts. See `packages/project/README.md` for binding and continuity semantics.

---

## P0.9 — Implement the canonical Handoff Protocol

**Status:** [x]

**Depends on:** P0.3, P0.8

### Goal

Provide the exact structured contract used by a ChatGPT-facing planner/reviewer and Codex executor.

### Planner → Executor handoff must support

- [x] project/run identifiers;
- [x] goal;
- [x] plan summary;
- [x] ordered/structured tasks;
- [x] acceptance criteria;
- [x] constraints;
- [x] relevant prior decisions;
- [x] artifact/file references where necessary;
- [x] requested verification;
- [x] provenance/source label.

### Executor → Reviewer result must support

- [x] completion/failure status;
- [x] implementation summary;
- [x] changed files;
- [x] diff summary/reference;
- [x] verifier evidence;
- [x] artifacts;
- [x] unresolved risks/blockers;
- [x] native execution/session reference if safe;
- [x] provenance/source label.

### Requirements

- [x] schemas/versioning;
- [x] validate untrusted bridge/provider inputs;
- [x] deterministic serialization tests;
- [x] bounded size/large artifact references;
- [x] no complete conversation-history field;
- [x] no credentials.

### Acceptance criteria

The same handoff/result payload can be consumed by fake ChatGPT, real Codex adapter and future alternative surfaces without changing Core.

Verification: canonical serialization/parse, schema versions, safe references, bounds, credential/history rejection and exact requested-check/result links passed. A fake planner sent the same wire envelope through the real Codex adapter (injected process runner), actual local Verifier and fake reviewer; pass, fail, skipped checks and pre-dispatch unknown-check rejection passed. All five baseline commands passed (1,873 tests), with package tests serialized before the final standard test command to avoid known resource contention. No Core changes or live ChatGPT claims. See `docs/HANDOFF.md` for field semantics, trust and versioning.

---

## P0.10 — Real native Codex Project dispatch E2E

**Status:** [ ]

**Depends on:** P0.4–P0.9

### Goal

Prove the local half of the product before adding ChatGPT UI automation.

### Scenario

1. create/register disposable Veyra Project;
2. start daemon;
3. dispatch a structured task through the daemon;
4. native authenticated Codex edits the fixture;
5. Veyra runs deterministic verification;
6. result/evidence is persisted under that project;
7. another client process fetches the result;
8. no OpenAI API key is present.

### Safety

- [ ] explicit opt-in for live native Codex smoke;
- [ ] disposable fixture only;
- [ ] protected tests/instructions checked for tampering;
- [ ] bounded timeout/retry;
- [ ] cleanup on success/failure;
- [ ] no publication/push/deployment.

### Acceptance criteria

A real already-authenticated Codex completes the disposable fixture task through Veyra daemon/project handoff with `OPENAI_API_KEY` unset.

This is the first major P0 gate.

---

## P0.11 — ChatGPT Bridge feasibility spike

**Status:** [ ]

**Depends on:** P0.5, P0.9, P0.10

### Goal

Choose the safest practical way for a real ChatGPT conversation to call Veyra and receive results.

### Investigate in priority order

1. official ChatGPT App/Plugin/tool/MCP capabilities available to the target user plan;
2. supported local/tunneled integration paths;
3. browser extension/content-script bridge as experimental fallback;
4. desktop accessibility/UI automation only as a last-resort experimental path.

### Required research outputs

- [ ] supported auth model;
- [ ] whether current conversation can invoke a tool/action;
- [ ] whether tool result can return to that same conversation;
- [ ] local daemon connectivity requirements;
- [ ] write/action limitations for target plans;
- [ ] permissions/security implications;
- [ ] maintenance risk;
- [ ] whether any path would violate product/platform rules;
- [ ] recommendation with evidence.

### Non-goals

- do not assume "Sign in with ChatGPT" grants conversation/history access;
- do not scrape all saved ChatGPT histories;
- do not require OpenAI API keys merely to avoid doing the bridge work.

### Acceptance criteria

Commit a short ADR/design document selecting the P0 bridge path and explaining why. If official integration cannot yet meet the P0 goal, explicitly authorize an isolated experimental browser bridge for the product proof without contaminating Core.

---

## P0.12 — Implement the selected ChatGPT Bridge proof

**Status:** [ ]

**Depends on:** P0.11

### Goal

Allow one real ChatGPT workflow to interact with the local Veyra daemon/project.

### Minimum bridge capabilities

- [ ] select/bind a Veyra project;
- [ ] submit a structured planner handoff;
- [ ] dispatch to native Codex through daemon;
- [ ] wait/observe completion without manual copy/paste;
- [ ] obtain structured result/evidence;
- [ ] return that result to the same active ChatGPT workflow where the selected bridge permits it;
- [ ] clearly show when native/project/daemon readiness is missing.

### Security requirements

- [ ] explicit user installation/permission;
- [ ] localhost/project scope only by default;
- [ ] no unrelated conversation harvesting;
- [ ] no credential extraction;
- [ ] content from ChatGPT/Codex is untrusted input and validated;
- [ ] destructive/high-risk actions still use Veyra approval gates;
- [ ] experimental browser/UI code isolated in a replaceable app/bridge package.

### Acceptance criteria

A real ChatGPT session can submit a task to a disposable registered project and receive the native Codex result through the bridge without the user manually copying either direction.

---

## P0.13 — Real ChatGPT → Codex → ChatGPT closed loop

**Status:** [ ]

**Depends on:** P0.12

### This is the MVP product gate

Prove exactly this:

```text
User asks ChatGPT for a project change
        ↓
ChatGPT produces/chooses implementation plan
        ↓
Veyra bridge sends handoff
        ↓
Native Codex implements in bound project
        ↓
Veyra verifier records objective evidence
        ↓
Veyra bridge returns execution result
        ↓
Same ChatGPT workflow reviews the result
```

### Requirements

- [ ] real project binding;
- [ ] real ChatGPT conversation/workflow;
- [ ] real native Codex authentication/session;
- [ ] `OPENAI_API_KEY` unset/not required;
- [ ] no manual copy/paste between GPT and Codex;
- [ ] persisted project handoff/result/evidence;
- [ ] demonstrate failure as well as success reporting;
- [ ] bounded execution and clear cancellation;
- [ ] record exact platform/client versions used.

### Acceptance criteria

One reproducible demo reaches ChatGPT review of a real Codex implementation automatically. This closes the product proof that originally motivated Veyra.

---

## P0.14 — Automatic review/fix loop

**Status:** [ ]

**Depends on:** P0.13

### Goal

Remove the remaining routine handoff after ChatGPT review.

### Requirements

- [ ] ChatGPT review result represented as structured verdict + findings + next action;
- [ ] `PASS` completes or advances the plan;
- [ ] `FAIL` creates a repair handoff to Codex automatically;
- [ ] repair result returns to ChatGPT automatically;
- [ ] configurable maximum automatic repair iterations (default conservative, e.g. 3);
- [ ] repeated/no-progress detection;
- [ ] user approval for architecture/product decisions when required;
- [ ] preserve full project run history/provenance;
- [ ] user can pause/cancel at any time.

### Acceptance criteria

A deliberately flawed first Codex implementation is rejected by ChatGPT, repaired automatically, verified again and accepted without manual message copying, within configured retry limits.

---

## P0.15 — Stable product demo and onboarding

**Status:** [ ]

**Depends on:** P0.14

### Requirements

- [ ] one-command or short documented local setup from clean checkout/install;
- [ ] `ve doctor` clearly distinguishes required native readiness from optional API providers;
- [ ] create/register/select project UX is understandable;
- [ ] demo shows ChatGPT → Codex → ChatGPT loop;
- [ ] demo explicitly says no API key is required for the golden path;
- [ ] README/video/GIF only show behavior that actually passed;
- [ ] document bridge limitations and supported ChatGPT surface/version;
- [ ] document Codex auth/session limitations;
- [ ] full baseline/CI passes.

### Acceptance criteria

A new developer following the documented prerequisites can reproduce the P0 loop without configuring an OpenAI API key.

---

# P1 — TUI / Agent Mission Control

**Status:** deferred until P0.13; foundation work may start after P0.10 only if it does not delay the ChatGPT bridge.

The TUI is a surface for Project/Daemon state, not the product's coordination engine.

Planned work after the P0 loop is proven:

- [ ] project selector/registry view;
- [ ] daemon health;
- [ ] workflow/run graph;
- [ ] active native agent/session status;
- [ ] timeline/event stream;
- [ ] diff/review/verification view;
- [ ] approval inbox;
- [ ] pause/resume/cancel;
- [ ] TUI tests;
- [ ] stable demo.

Bare `ve` may eventually open the TUI, but the P0 bridge must not depend on terminal UI rendering.

---

# P2 — Dashboard

Deferred until P1 is stable.

Dashboard should consume the same Project/Daemon API and never reimplement orchestration.

Planned:

- [ ] projects;
- [ ] run detail;
- [ ] workflow visualization;
- [ ] native-agent readiness/settings;
- [ ] approvals;
- [ ] metrics/history;
- [ ] multi-project view.

Remote/cloud control remains a separate explicit product decision.

---

# Optional provider validation / non-blocking backlog

These items are useful, but they do **not** block P0 or P1:

- [ ] OpenAI API live smoke for the existing Responses adapter;
- [ ] Anthropic API live smoke;
- [ ] Gemini API live smoke;
- [ ] Claude Code live timeout investigation;
- [ ] OpenCode native credential investigation;
- [ ] Gemini CLI native live verification where executable is available;
- [ ] live cross-model evaluation harness;
- [ ] additional providers/custom LLMs;
- [ ] automatic provider/model routing improvements.

`OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` are optional-provider credentials, not base Veyra requirements.

---

# Release/publication backlog

Existing package/release tooling is retained.

Do not publish simply because tooling is ready.

Before first public npm release:

- [ ] P0.13 real closed loop passes;
- [ ] P0.15 onboarding/demo passes;
- [ ] package docs reflect native-auth-first product model;
- [ ] no API key is documented as mandatory for golden path;
- [ ] explicit human approval to publish;
- [ ] release artifacts/CI reviewed;
- [ ] changelog prepared.

Homebrew and other distribution channels remain optional after a useful npm release.

---

# Next task

**P0.10 — Real native Codex Project dispatch E2E.**

Do not resume the old API-key smoke as a blocker. It is now optional provider validation.
