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

OpenAI API, Anthropic API, Gemini API and other API providers remain valid optional integrations. They do not block P0, GUI work or the first release-worthy product demo. The product is GUI-first; Side Panel → Local Control Center → CLI is the surface priority. TUI is deferred/optional, with its scaffold retained and no P0/P1 delivery requirement. Read [UX Flow](UX-FLOW.md) and [Design](DESIGN.md) for GUI/UX constraints.

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

**Status:** [x]

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

- [x] explicit opt-in for live native Codex smoke;
- [x] disposable fixture only;
- [x] protected tests/instructions checked for tampering;
- [x] bounded timeout/retry;
- [x] cleanup on success/failure;
- [x] no publication/push/deployment.

### Acceptance criteria

A real already-authenticated Codex completes the disposable fixture task through Veyra daemon/project handoff with `OPENAI_API_KEY` unset.

This is the first major P0 gate.

Verification: `env -u OPENAI_API_KEY pnpm --filter @veyraoss/cli smoke:native` passed with real native `codex-cli 0.153.4`, Project `bebab765-d550-4d1d-83b7-2407e50c2d61`, run `bd573315-0b40-4fbc-abb4-772f1c75aaa5`, session `01a081fb-3bd8-7561-a9e1-59c52d3afc36`. A production CLI daemon dispatched the canonical handoff, Codex changed only `src/message.js`, and an independent client fetched actual passing test/build/diff evidence. Protected files and build output passed; the fixture and daemon were cleaned up. Default harness tests also reject false success, tampering and symlink substitution, and verify cancellation cleanup. All five baseline commands passed (1,878 tests). See `docs/NATIVE-DISPATCH.md`; this proves native local dispatch, not the later ChatGPT bridge.

---

## P0.11 — ChatGPT Bridge feasibility spike

**Status:** [x]

**Depends on:** P0.5, P0.9, P0.10

### Goal

Choose the safest practical way for a real ChatGPT conversation to call Veyra and receive results.

### Investigate in priority order

1. official ChatGPT App/Plugin/tool/MCP capabilities available to the target user plan;
2. supported local/tunneled integration paths;
3. browser extension/content-script bridge as experimental fallback;
4. desktop accessibility/UI automation only as a last-resort experimental path.

### Required research outputs

- [x] supported auth model;
- [x] whether current conversation can invoke a tool/action;
- [x] whether tool result can return to that same conversation;
- [x] local daemon connectivity requirements;
- [x] write/action limitations for target plans;
- [x] permissions/security implications;
- [x] maintenance risk;
- [x] whether any path would violate product/platform rules;
- [x] recommendation with evidence.

### Non-goals

- do not assume "Sign in with ChatGPT" grants conversation/history access;
- do not scrape all saved ChatGPT histories;
- do not require OpenAI API keys merely to avoid doing the bridge work.

### Acceptance criteria

Commit a short ADR/design document selecting the P0 bridge path and explaining why. If official integration cannot yet meet the P0 goal, explicitly authorize an isolated experimental browser bridge for the product proof without contaminating Core.

Initial P0.11 verification selected official ChatGPT web Developer mode + authenticated MCP, with an explicitly authorized reachable transport as a future installation requirement. P0.12 updates that selection after the user confirmed ChatGPT Pro: the plan-specific Help Center restricts custom Pro MCP to read/fetch and conflicts with the general Developer mode guide. The amended [ADR 001](ADR-001-CHATGPT-BRIDGE.md) selects the isolated Experimental Browser Bridge and retains Full MCP for future entitled installations. The original research-only item passed all five baseline commands (1,878 tests); no real ChatGPT interaction was claimed.

---

## P0.12 — Experimental ChatGPT Web Bridge for Pro product proof

**Status:** [!] The latest real Pro run dispatched a canonical handoff, created a native Codex session, and returned its failed result automatically to the same conversation for human-decision review. Native model connections timed out before verification; the two-minute daemon ceiling cancelled execution. The native environment/deadline repair below restores system-proxy inheritance and is locally verified, including a real no-tools model connectivity probe. Successful Project execution and verification still require a fresh user-directed test in the existing binding. The retained MCP app is the preferred future official Full MCP production path. No tunnel or public server is selected.

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

- [x] explicit user installation/permission (user-confirmed real Chrome Stage B installation);
- [x] localhost/project scope only by default;
- [x] no unrelated conversation harvesting;
- [x] no credential extraction;
- [x] content from ChatGPT/Codex is untrusted input and validated;
- [x] destructive/high-risk actions still use Veyra approval gates;
- [x] experimental browser/UI code isolated in a replaceable app/bridge package.

### Acceptance criteria

A real ChatGPT session can submit a task to a disposable registered project and receive the native Codex result through the bridge without the user manually copying either direction.

### Stage A — deterministic local acceptance

- [x] actual MV3 manifest/build/content script/service worker and fixed extension identity;
- [x] direct loopback daemon client and explicit authorized Project selection/binding;
- [x] ten-minute single-use pairing invitation, explicit scope confirmation, eight-hour Project-scoped grant, expiry/revocation and trusted-context session storage;
- [x] mandatory standalone `VEYRA_HANDOFF_BEGIN/END`, JSON/canonical schema validation, fresh run identity, native readiness and no dispatch from ordinary prose;
- [x] native dispatch API reuse, polling, one-time acknowledged `VEYRA_RESULT_BEGIN/END` handback and explicit Reviewer instructions;
- [x] current-conversation binding, Project name/root/UUID, Enabled/Disabled, Run ID/status, agent event status, Codex readiness, daemon connectivity, Last Result and cancellation controls;
- [x] bounded explicit repair handoffs (default three total executions), reserved review framing without implementing the P0.14 workflow;
- [x] deterministic DOM, unit/integration/security tests; actual Chromium extension fixture; disposable live-test preparation and independent protected-file/test/build inspection;
- [x] all seven product/status documents updated, retained official MCP app and complete twelve-step Stage B guide.

The original Stage A HTTP path in `apps/chatgpt-extension` sent only a new completed assistant turn's explicitly delimited canonical handoff to the authenticated `http://127.0.0.1:<port>` daemon. Native Messaging is now the default supporting transport; HTTP remains diagnostic/fallback. Project `.veyra/` owns engineering state; no complete conversation, native credentials, cookies or tokens are harvested. The popup distinguishes current binding from a previous/other page. Disable stops automation; Stop/Cancel also cancels the run; Unpair revokes the grant. Navigation, duplicate/ambiguous dispatch, busy composers and uncertain delivery pause or wait without guessed replay. Existing native execution, Verifier and human gates are reused.

`apps/chatgpt-bridge` and its 16 OAuth/MCP tests remain the **preferred future official Full MCP production path**. [ADR 001](ADR-001-CHATGPT-BRIDGE.md) records the freshly rechecked Help Center Pro read/fetch restriction and the conflicting general Developer mode guide. Transport reachability does not prove write/action entitlement. No cloudflared, ngrok, public server or API key is used by this proof.

Original Stage A verification on 2026-09-09: **24 extension tests** and **6 loopback HTTP tests** pass, covering malformed/missing/multiple markers, schema/identity, Host/Origin/auth/Project boundaries, invitation/grant expiry, single-use pairing, cancellation, revocation during pending native readiness, response bounds, old/user/streaming exclusion, navigation, acknowledgement, bounded repairs and protected-fixture tampering. The actual unpacked MV3 extension in Chromium **149.0.7827.55**, with simulated ChatGPT/executor and real daemon/Verifier, executed twice, observed failed then passed verification, and automatically returned exactly two results to the same fixture conversation. Current Project/readiness/Last Result UI, navigation isolation and UI-driven grant revocation also passed. Its owned browser/profile/daemon were cleaned up. These are deterministic transport/DOM tests, **not real ChatGPT/native-account acceptance**.

During original Stage A, a separate disposable `veyra-pro-proof` Project was prepared with trusted test/build/diff commands and independent registry. Its generated production-daemon start/status/health/stop scripts passed. With `OPENAI_API_KEY` unset, native **Codex 0.153.4** reported installed, authenticated and ready without credential-file access. That daemon was stopped; only the disposable Project and scripts remain for Stage B. This readiness probe does not claim a model invocation or real ChatGPT handback.

The original Stage A baseline passed: `pnpm lint`, `pnpm format:check`, `pnpm check`, `pnpm test` (**1,926 passed**) and `pnpm build`. See the [extension guide](../apps/chatgpt-extension/README.md) for reproducible build, fixture, native-ready checks, real-account prompt, evidence locations and stop/uninstall steps.

### Real ChatGPT Pro acceptance record — 2026-09-09

User-reported Stage B evidence (not an agent-run account test):

- Chrome extension installation and content-script injection on real `chatgpt.com` work.
- Local pairing succeeds; Daemon is connected; `veyra-pro-proof` is recognized.
- Native Codex **0.153.4** reports `available=true / ready=true` using the existing native login; no `OPENAI_API_KEY` is used.
- The **same real ChatGPT conversation receives the Veyra binding/Project/context user message, and ChatGPT responds**.
- The remaining failure is send-confirmation normalization: the extension incorrectly reports paused/Disabled with “绑定消息发送未确认：会话或输入内容发生变化，已停止发送。” after the real message/reply. Strict composer-string equality does not survive legal contenteditable normalization.
- The user also reports Chrome/system sluggishness after binding. Code inspection found repeated 1.5-second conversation scans, layout-sensitive `innerText` reads and overlapping 3-second popup/Run queries. `runs.get` reads persisted events and repeated popup readiness checks can probe native Codex. These are confirmed avoidable costs; a before/after profile of the user's personal Chrome/system was not captured.

The repair keeps DOM logic inside `apps/chatgpt-extension`: unique-marker/BEGIN-END/normalized-content integrity, trusted user-intervention detection and new same-conversation user-message echo proof; uncertain delivery never replays. MutationObserver handles only new/completed turns, active runs use bounded backoff and popup changes read cached snapshots. Project evidence and human approval gates are unchanged. See the [reload/retest guide](../apps/chatgpt-extension/README.md#native-messaging-产品流程).

### Repair verification — 2026-09-09

- `pnpm --filter @veyraoss/chatgpt-extension test`: **48 passed**, including native text-node/DIV boundaries, paragraphs/BR/NBSP, large bilingual JSON, repeated blank lines, marker/BEGIN-END integrity, draft/tampering/navigation/binding/attachment/streaming rejection, echo-only confirmation and no uncertain replay.
- `pnpm --filter @veyraoss/chatgpt-extension smoke:browser`: **passed** in Chromium **149.0.7827.55**. Fourteen real DOM/trusted-input cases pass, including an already-present binding echo plus GPT reply without a second click. The actual unpacked extension still executes twice against the offline fixture, verifies failure then success and returns exactly two results to the same conversation, with cancellation/revocation boundaries retained.
- Performance regression: **3,000 old turns**, **60 wall-clock idle seconds**, **0 DOM queries**, **0 handoff checks**, page TaskDuration delta **0.0274 seconds** in this fixture. A 1,000-mutation burst triggers one completed-turn check. Unit tests also cover 60-second virtual idle, active-run bounded backoff, stopping an in-flight query, popup open/closed cleanup, snapshot updates without network/write feedback and composer changes during a pending defer response. These numbers are local fixture evidence, not a personal Chrome/system profile.
- All five required baseline commands pass: `pnpm lint`, `pnpm format:check`, `pnpm check`, `pnpm test` (**1,950 passed**), `pnpm build`.
- One browser startup attempt timed out waiting for its extension service worker while baseline/build work was running; the independently rerun built extension passed all browser checks above. Test-owned browser/profile/daemon resources were cleaned up. The user's real daemon, conversation and Project evidence were not reset.

### Blocker, attempts and unlock

Installation, native authorization, canonical dispatch and automatic same-conversation failure handback are now user-confirmed. The latest run is terminal `failed`, with native network retries and all requested checks `not_run`; its evidence must be retained. After the native environment/deadline repair, keep the current conversation and Project binding. The rebuilt local host/coordinator load on the next normal connection after idle shutdown; this backend repair does not require Extension Reload, setup/init/pairing, or Unbind/Bind. A fresh user-directed request must create a new handoff/run ID, execute native Codex, run the configured checks and return evidence to the same conversation. Do not replay the failed handoff or automatically override the real review's human-decision gate.

The user must confirm successful Project execution and real-page behavior. Browser regressions use disposable profiles; the isolated no-tools native connectivity probe reuses Codex's own existing login without reading/copying credentials or the original Project. No unrelated conversation or public forwarder is used. The previous tunnel proposal remains superseded. Neither fixtures nor the connectivity probe replace this live Pro confirmation; P0.12 remains incomplete and P0.13–P0.15 remain unstarted by explicit user instruction.

---

### Live reconnect repair — user report, 2026-09-10

**Status:** [x] Local repair and deterministic verification only; real P0.12 remains [!].

Depends on the implemented native onboarding and GUI. The user reproduced Ready → disconnected while remaining in the explicitly bound ChatGPT conversation and generating a new framed handoff. Local logs show successful coordinator startup followed by its normal 60-second idle shutdown; the selected Project still contains only `project.yaml`, with no handoff/run/result evidence. Reconnecting repeatedly is not an acceptable product recovery flow.

Repair worker-wakeup connection snapshots and bounded native recovery, test completed-turn detection across streaming-control changes, and preserve exact Project/conversation identity, human gates and no replay of uncertain writes. Add worker/port/DOM/security/idle regressions, run native and HTTP Chromium smoke plus all five baseline commands, rebuild source and packaged extension assets, commit/push, then stop for real Pro re-acceptance. Do not mark P0.12 complete or start P0.13–P0.15.

Verification:

- A cold worker rehydrates connectivity, bound installation/Project identity and readiness once on its first requested snapshot. Another 100 idle snapshots make no native requests or binding writes. Rotated installation identity, changed Project root and revoked grants remain blocked; recovery never re-authorizes a Project.
- A native handshake or allowlisted read interrupted by a dropped port can recover once after 200ms. Reads require the same installation identity. Invalid replies, repeated failures and uncertain dispatch writes fail closed; stale old-port replies cannot affect a replacement. No periodic retry/keepalive is added.
- Completed-turn detection now observes old streaming attributes when ChatGPT reuses its Stop button. Four attribute variants pass without weakening the new-turn, completion-toolbar, quiet-period, schema or exact-conversation checks.
- Extension tests: **86 passed**. Both `smoke:native-browser` and `smoke:browser` passed in Chromium **149.0.7827.55**. Native smoke verifies actual 60-second coordinator idle exit, two forced worker restarts with lost globals, automatic snapshot recovery, and a new handoff waking the cold worker/coordinator without manual Reconnect or bootstrap replay. Each transport executes exactly twice and returns exactly two same-conversation results, with failed then passed Verifier evidence. ChatGPT and the executor are simulated; transport, host, coordinator and Verifier are real.
- Both Chromium fixtures pass **14 normalization/safety cases**, **3,000 old turns**, **60 wall-clock idle seconds**, **0 idle DOM queries**, and one completed-turn check per **1,000-mutation burst**. Main-thread TaskDuration deltas are native **0.0249s** / HTTP **0.0237s**; these are isolated fixture measurements, not whole-machine CPU claims.
- `pnpm lint`, `pnpm format:check`, `pnpm check`, `pnpm test` (**2,030 passed**) and `pnpm build` all passed. Source and CLI-packaged extension outputs contain the same **14 files**, verified byte-for-byte. The existing user Project, grants and conversation were not reset; test-owned browser/host/coordinator resources were cleaned up.

Next live step: Reload Veyra in `chrome://extensions`, refresh the original bound conversation, confirm the same Project restores, wait over one minute, then issue a new test task. No setup/init/pairing is needed for the existing native installation. Stop after the focused fix commit/push for this real Pro re-acceptance.

### Live turn-container and handoff-guidance repair — user report, 2026-09-10

**Status:** [x] Local repair and deterministic verification only; real P0.12 remains [!].

Depends on the locally verified reconnect repair. The user reloaded/rebound and sent a fresh read-only test handoff; the Side Panel remained Ready with no run. Read-only DOM inspection of only the specified conversation's latest assistant turn found a completed `section` with its normal copy toolbar, no streaming and an empty composer. The old `article`/direct-parent scope had no completion button; the explicit `conversation-turn-…` scope did. The Project still has no handoff/run/result evidence.

Recognize the observed explicit conversation-turn container, reuse it in both event-driven and direct completion checks, retain legacy article support and same-turn completion/identity guards. Add sanitized live-layout fixtures, no sibling-toolbar borrowing/old-turn replay tests, both native/HTTP browser checks and the baseline. Verify the fixed read-only parser against the original page without dispatching or replaying its handoff. Commit/push, then stop for Reload and real P0.12 re-acceptance; P0.13–P0.15 remain blocked.

The fixed parser recognizes the original live message, but the unchanged canonical validator correctly rejects it: `context.decisions` contains strings instead of decision objects, `context.currentTask` is an object instead of a plan task ID string, and `requestedVerification` is incorrectly nested inside `context`. The existing planner instruction did not explain these types/locations and its minimal example omitted them. Provide a full, indented canonical example and explicit field guidance, plus localized rejection reasons. Never coerce/rewrite that invalid input into a dispatch. The live read-only probe reported recognition with schema rejection and `dispatchAttempted: false`; no message, native run or Project file was created.

Verification:

- **96 extension tests pass**, including the observed section with a nested sibling toolbar, legacy article support, old-turn exclusion, refusal to borrow an adjacent/outside toolbar, unknown-container rejection, streaming completion, mutation bursts, deferred handback, complete template validity and three malformed-field rejections before transport/state writes. The canonical Protocol validator and human approval boundaries are unchanged.
- Both `smoke:native-browser` and `smoke:browser` pass in Chromium **149.0.7827.55**. The native fixture uses the observed nested section layout and plain paragraph handoffs; the HTTP fixture retains legacy article/code blocks. Both consume the complete planner template, execute exactly twice, verify failure then success, and return exactly two results to the same fixture conversation. Native smoke also passes real 60-second coordinator idle shutdown, two worker evictions, automatic binding/readiness recovery and new-handoff dispatch without bootstrap replay. The HTML fixtures explicitly declare UTF-8 so indented Chinese/English instructions and NBSP normalization are tested correctly.
- Both fixtures pass **14 normalization/safety cases**, **3,000 mixed section/article old turns**, **60 wall-clock idle seconds**, **0 idle DOM queries**, and one check after **1,000 mutations**. Main-thread TaskDuration deltas: native **0.0604s**, HTTP **0.0348s**. No polling/keepalive timer was added. These are isolated fixtures, not whole-machine CPU or real-account execution proof.
- `pnpm lint`, `pnpm format:check`, `pnpm check`, `pnpm test` (**2,040 passed**) and `pnpm build` all pass. The source and CLI-packaged extension have the same **14 files**, byte-for-byte. Test-owned browser/host/coordinator resources were cleaned up. The user's actual Project still contains only `project.yaml`; its grants, files and conversation were not reset or replayed.

Next live step: Reload the built extension, refresh the original conversation, confirm no active run, then Unbind/Bind the same Project once to deliver the corrected planner instructions. Send a new ordinary read-only test request; do not resend the malformed old JSON. This one-time template refresh does not change the normal Bind-once behavior. Stop after focused commits/push; require real native execution and same-conversation result evidence before completing P0.12.

### Live page-receiver recovery — user report, 2026-09-10

**Status:** [x] Local repair and deterministic verification only; real P0.12 remains [!].

Depends on the verified turn-container/template repair. After updating the extension, the user reports Bind failing with Chrome's `Could not establish connection. Receiving end does not exist.` The screenshot shows the unbound screen and the previous handoff, not a new native execution. The previous background sent `prepare` directly to a content script that could be absent or invalidated after extension reload, with no page-receiver recovery.

Reproduce extension reload while the same ChatGPT page remains open. Recover only the read-only preparation handshake for the explicitly selected current conversation, using a main-document-scoped content script attachment. Do not retry bootstrap, handoff dispatch or result delivery; preserve authorization, identity, unknown-outcome and no-history boundaries. Make content initialization idempotent, provide localized actionable connection failures, and add reload/navigation/duplicate/permission/idle regressions. Run both browser transports and all baseline checks, commit/push and stop for real P0.12 re-acceptance. P0.13–P0.15 remain unstarted.

Verification:

- Explicit Bind/Resume recovers only Chrome's exact missing-receiver error, once. Read the active tab/conversation and Chrome main-document ID, attach packaged `content.js` to that document in the isolated world, and retry only `prepare`. An isolated conversation ticket rejects a same-document SPA route change. Navigation, foreign documents, denied permission, malformed/lost replies and repeated failures stop safely. Bootstrap/dispatch/result sends are never retried.
- Content initialization has one live receiver per document. An invalidated instance disposes its observers/listeners/run timer before replacement. Recovery attachment does not send an automatic restore/hello; it waits for the explicit bind/resume handshake. Failed Resume preparation preserves the user's pause. Binding rechecks the current tab/conversation after native readiness. Known pre-send connection failures display the recovery instruction directly in Chinese or English. The added `scripting` permission does not expand the existing host allowlist.
- **121 extension tests pass**, including receiver recovery, navigation/document/permission rejection, invalidated/duplicate lifetimes, paused-state preservation, and both language error cards. Both `smoke:native-browser` and `smoke:browser` pass in Chromium **149.0.7827.55**. Native smoke actually reloads the extension, proves fresh worker globals and the exact missing-receiver error, then binds successfully while preserving the same unrefreshed ChatGPT document. It also verifies normal armed page refresh, actual 60-second coordinator idle exit, cold-worker recovery and no bootstrap replay. The native harness enables Developer Mode and loads the unpacked extension only in its disposable profile using Chrome's configuration and CDP APIs; no personal profile is changed.
- Both transports execute exactly twice and return exactly two same-conversation results, with failed then passed Verifier evidence. Both pass **14 normalization/safety cases**, **3,000 old turns**, **60 wall-clock idle seconds**, **0 idle DOM queries** and one check after **1,000 mutations**. Main-thread TaskDuration deltas: native **0.0357s**, HTTP **0.0291s**. No periodic scan, reconnect loop or keepalive was added. These are isolated browser fixtures with simulated ChatGPT/executor, not a real-account or whole-machine performance proof.
- `pnpm lint`, `pnpm format:check`, `pnpm check`, `pnpm test` (**2,065 passed**) and `pnpm build` pass. Source and CLI-packaged extension assets contain the same **14 files**, byte-for-byte. Browser smokes use the existing `CHROMIUM_EXECUTABLE` documented in [GUI acceptance](GUI-ACCEPTANCE.md); no browser download is required. Test-owned browser/host/coordinator resources are cleaned up. Read-only inspection still finds only `project.yaml` in the user's actual Project shared state; no real handoff, execution or result is claimed.

Stop after the focused fix commit/push. The user reloads the built extension, returns to the currently unbound original conversation and binds the same Project, then requests one fresh read-only task. Require real native execution and automatic same-conversation result evidence before completing P0.12.

### Live native connection and deadline repair — user report, 2026-09-10

**Status:** [x] Local repair and verification complete; real P0.12 Project re-acceptance remains blocked.

Depends on the verified page-receiver repair. The user now confirms a real handoff dispatch and automatic failure-result return to the same ChatGPT conversation, followed by a structured human-decision review. Project evidence records native session creation, repeated model connection timeouts, WebSocket-to-HTTPS fallback, cancellation by the daemon's hard-coded 120-second deadline, and all three requested checks `not_run`. This proves the failure-handback path, not successful native execution or P0.12 completion.

Read-only diagnostics found that Chrome's process has no proxy environment variables while macOS and the working terminal use an existing local HTTP/HTTPS proxy. An unauthenticated connection probe times out directly but reaches the Codex endpoint through that configured proxy. Recover the native-host launch environment from bounded static macOS proxy settings, preserve explicit environment choices, avoid credential/PAC handling or global configuration writes, and retain loopback bypass. Give trusted native execution its bounded 15-minute adapter budget without lengthening command-check defaults or retrying uncertain work. Test launch-environment propagation, timeout/cancellation, both bridge transports and the baseline; perform only an isolated no-tools connectivity probe with existing native login. Preserve the actual failed run and stop for a new user-directed real Project test after commit/push. P0.13–P0.15 remain unstarted.

Verification:

- The actual failed run's Core events (07:28:46–07:30:47 UTC) preserve native session creation, repeated `request timed out`, HTTPS fallback and cancellation at 120 seconds. No completed executor result or Verifier event exists. The screenshot supplies the same-conversation failure handback and structured `HUMAN_DECISION` review evidence. Separate `rmcp` HTTP 403 startup errors are not treated as proof that native account authentication failed.
- A credential-free HEAD probe to the Codex service times out directly after 8 seconds; the existing proxy receives HTTP 405 in 0.94 seconds (reachability only). The real no-tools probe starts without shell proxy variables or `OPENAI_API_KEY`. The new resolver recovers the static system proxy; native Codex **0.153.4** returns exactly `VEYRA_CONNECTION_OK`, `turn.completed`, exit 0, in **23.97 seconds**. This ephemeral probe uses a disposable directory; MCP tools are disabled only for this invocation to isolate model connectivity, without changing user configuration. It is not a Project execution/Verifier proof. The [official non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) were checked; no API-key route or forced transport change was introduced.
- **19 native environment tests** cover proxy/bypass inheritance, explicit upper/lowercase/empty/all-proxy choices, IPv6, PAC/autodiscovery rejection, malformed addresses/ports, duplicate scalars, other platforms and failed/truncated/timeout probes. The caller environment remains unchanged. Only the local host reads static system settings, once per startup with a 2-second/16-KiB bound; no idle timer, credential access or global setting writes are added.
- **3 daemon deadline regressions** verify the generic two-minute default, a trusted 15-minute budget reaching execution, a stricter step deadline cancelling work, and rejection of remote timeout overrides. Native handoff integration verifies that the adapter receives the 15-minute budget while checks still default to two minutes. Existing cancellation, approval and no-replay tests pass.
- `pnpm test`: **2,087 passed**, including **121 extension tests**. Both browser transports pass in Chromium **149.0.7827.55**: two executions/two same-conversation results with Verifier failure then success, 14 safety cases, 3,000 old turns and 60 idle seconds with **0 DOM queries** (native TaskDuration **0.0369s**, HTTP **0.0576s**). Native smoke retains actual extension reload, cold worker/coordinator recovery and scoped local run details. An initial Control Center page-event wait timed out; the fixture now reports visible errors, and the isolated rerun passed. No production GUI behavior was changed for that test timeout.
- `pnpm lint`, `pnpm format:check`, `pnpm check` and `pnpm build` pass. Native host/coordinator assets are rebuilt; both extension directories still contain the same 14 files. The actual failed Project evidence is preserved. Test profiles/processes and the probe directory are cleaned up. The original coordinator idle-stopped normally; the next connection starts rebuilt code.

Stop after focused commits/push. Retain the current binding and ask for one new read-only verification task in the original ChatGPT conversation. Successful native execution/Verifier/result return remains necessary before completing P0.12.

### Product onboarding support (implementation started before the GUI phase order)

- [x] Implement `ve setup`, native messaging installation and project-scoped authorization, lazy coordinator lifecycle, default Project-first `ve init`, persistent explicit conversation binding, simplified interim popup and reversible machine-message folding.
- [x] Verify native messaging framing/origin/scope, installation safety, refresh/restart recovery, cancellation, idle behavior and both native/HTTP browser fixtures, then run all baseline commands.

This supporting work follows [UX-FLOW](UX-FLOW.md). It does not complete the real ChatGPT Pro gate or the GUI phases. The simplified popup is an interim proof interface; its replacement follows Phase 3/4 below. Developer proof scripts and loopback transport remain diagnostic/fallback capabilities.

### Native onboarding verification — 2026-09-09

- `pnpm --filter @veyraoss/chatgpt-extension test`: **62 passed**. Restoration preserves the exact conversation/Project/installation identity; ambiguous delivery/dispatch is not replayed. New concurrency regressions cover Unbind during dispatch, Bind, Resume and document restoration, including late replies. Local storage contains routing/intent metadata only. HTTP Unpair does not silently switch transport.
- CLI onboarding tests: **9 passed**, including idempotent Project registration/native binding, configuration preservation, nested init, framed UTF-8 messages, caller origin/schema/scope/expiry/revocation, foreign/linked installation rejection and concurrent lazy startup of one independent coordinator. Daemon integration verifies idle shutdown while preserving admitted runs. Packaging checks the complete extension assets and stdio host inside the CLI tarball.
- `pnpm --filter @veyraoss/chatgpt-extension smoke:native-browser`: **passed**, Chromium **149.0.7827.55**. Real `connectNative` → registered stdio host → automatically started coordinator → actual native adapter with a fixture executable, then real Verifier. Explicit HTTP-to-native switching refreshes Projects automatically. Same-conversation refresh restores an armed binding without another bootstrap. Two executions return two results, first failed then passed; scope/Unbind pass. No API key or public network is used.
- `pnpm --filter @veyraoss/chatgpt-extension smoke:browser`: **passed**, retained HTTP pairing/revocation path, two same-conversation results and failed/passed Verifier evidence.
- Both browser fixtures include **14 normalization/safety cases**, **3,000 old turns**, **60 wall-clock idle seconds**, **0 idle DOM queries** and one completed-turn check after a **1,000-mutation burst**. TaskDuration delta: native **0.0147 seconds**, HTTP **0.0307 seconds**. These are isolated fixture measurements, not a profile of personal Chrome. Test-owned profiles, hosts and daemons are cleaned up.
- `pnpm lint`, `pnpm format:check`, `pnpm check`, `pnpm test` (**1,974 passed**) and `pnpm build`: **all passed**. Both source and CLI-packaged extension directories are built.
- `env -u OPENAI_API_KEY pnpm ve -- doctor --json`: native **Codex 0.153.4**, available/authenticated/Ready on macOS arm64 and Node 22.22.0. This is a supported non-secret readiness probe, not a live model request.

**Real-account acceptance remained blocked at this onboarding checkpoint.** The user then confirmed re-testing had not happened. The later 2026-09-10 live reconnect report above supersedes that snapshot. Follow the [Native Messaging re-acceptance guide](../apps/chatgpt-extension/README.md#native-messaging-产品流程). No fixture or native readiness result completes P0.12 or substitutes for real-account acceptance. The later explicit GUI-first decision below removes this as a GUI implementation prerequisite.

### GUI productization phases — user decision, 2026-09-09

The latest explicit product decision starts GUI productization **before** real P0.12 re-acceptance. This supersedes the earlier Phase 1 prerequisite. P0.12 remains [!] pending real ChatGPT Pro re-testing; fixtures/screenshots do not complete it. Complete GUI-1 through GUI-6, push focused commits, then stop for the user's first visual review. Do not start P0.13–P0.15 in this implementation run.

| Phase | Status | Work / acceptance                                                                                                                                                                                 | Depends on                 |
| ----- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| GUI-1 | [x]    | Shared `packages/ui`: semantic light/dark tokens, typography, accessible primitives, icons and restrained motion.                                                                                 | Existing native onboarding |
| GUI-2 | [x]    | Chrome Side Panel, chatgpt.com only; explicit Project binding and restore; real workflow/evidence; unbound, idle, running, verification, completed, failed, paused, disconnected and dark states. | GUI-1                      |
| GUI-3 | [x]    | Tiny popup: status, Open Veyra, current Project and secondary Diagnostics.                                                                                                                        | GUI-2                      |
| GUI-4 | [x]    | Local Control Center through `ve open`: authenticated local access; Overview, Projects, Runs and Settings; shared UI, no mock production data.                                                    | GUI-3                      |
| GUI-5 | [x]    | Run detail/timeline, bounded unified diff, verification, review and artifacts with truthful provenance.                                                                                           | GUI-4                      |
| GUI-6 | [x]    | Independent `pnpm ui:dev` fixtures, fixed light/dark/narrow/wide screenshots, keyboard/reduced-motion/security/idle regressions and actual Chromium extension smoke.                              | GUI-5                      |

Each phase requires its task checks, all five baseline commands and a focused commit. Side Panel and Control Center screenshots must be generated from running UI. Keep fixtures/dev data separate from production. Retain Native Messaging, HTTP fallback, Project state, human gates and all existing protocol/runtime protections. No idle polling/animation or fictional progress/review evidence. No TUI/provider/cloud/release expansion.

### GUI-1 verification — 2026-09-09

Shared React primitives, semantic light/dark tokens, typography, spacing, iconography, workflow status, dialog/tabs/keyboard focus and reduced motion are implemented. Five new tests cover untrusted text, accessible controls, unknown/absent evidence and workflow labels. All baseline commands (`pnpm lint`, `pnpm format:check`, `pnpm check`, `pnpm test`, `pnpm build`) passed. Browser visual acceptance follows in GUI-2/GUI-6.

### GUI-2 verification — 2026-09-09

The real extension now has a Chrome Side Panel enabled only on `chatgpt.com`. It uses shared UI, cached event-driven snapshots and scoped Project/run evidence. Exact-conversation identity accompanies controls; normal/uncertain sends retain all existing guards. Current Project/binding, workflow, execution/verification/result handback, pause/unbind/cancel and a details drawer are implemented. Machine blocks fold into reversible compact rows. No production fixture import exists.

`smoke:panel` produced ten actual browser screenshots in `output/playwright/gui/`, including required light/dark states; 320/360/400/420/460 widths, no overflow, drawer focus and Escape passed. Both `smoke:native-browser` and `smoke:browser` passed in Chromium 149.0.7827.55 with real Side Panel rendering of the actual fixture run/result. Each executed twice, verified fail/pass and returned two results; native armed refresh and HTTP revocation remain intact. Both measured 3,000-turn/60-second idle with zero DOM queries; TaskDuration deltas were 0.0261s native and 0.0274s HTTP. The 14 send-normalization/safety cases and mutation burst checks still pass. Extension unit tests: 67 passed; full baseline: 1,984 passed. All five baseline commands passed. These are deterministic browser fixtures, not real ChatGPT Pro re-acceptance.

### GUI-3 verification — 2026-09-09

Popup now shows only Veyra/status, Open Veyra, current Project and a Diagnostics shortcut. Its Side Panel open call stays in the user gesture. Unsupported tabs cannot open it. The previous proof controls and HTTP pairing remain in the separate `diagnostics.html` page, not the happy path. Two new launcher tests passed (69 extension tests); all five baseline commands passed (1,986 total tests). `smoke:panel`, native Chromium smoke and HTTP Chromium smoke all passed after moving the diagnostic controls. `output/playwright/gui/popup.png` is the running fixture screenshot. No real Pro gate is claimed.

### GUI-4 verification — 2026-09-09

`ve open` now opens the built local Control Center: Overview, Projects, Runs, Project detail and Settings, sharing the Side Panel's tokens/components. A scoped Native Messaging invitation links Side Panel run details to the same Project. Existing Daemon/Core stores supply real bounded run history; no production mock exists. The GUI transport is loopback-only with one-use 60-second invitations, eight-hour HttpOnly/SameSite sessions, exact Host/Origin, CSRF, Project root/scope checks, live grant/installation revocation and no dispatch/approval/file-shell authority. SSE batches meaningful state changes; hidden/closed pages detach, retries are bounded and the GUI idles down independently of active Codex work.

All five baseline commands passed. Six local-server/packaged-launch/security tests, four additional protocol rejection cases and two UI/store tests passed, including concurrent nonce reuse, cross-project denial, real saved history, logout, event batching and idle shutdown. Browser smoke exercised production assets against a real disposable local Daemon, session reload, Project navigation and logout. Five light screenshots plus dark Overview rendered without overflow at 900/1440px. Native Chromium extension smoke also passed (14 send/safety cases, two executions/handbacks, verifier fail/pass, 3,000 old turns, 60s idle, zero DOM queries, 0.0311s TaskDuration). Screenshots are in `output/playwright/gui/`. P0.12 real Pro acceptance remains pending.

### GUI-5 verification — 2026-09-09

Run Detail now presents the goal, four-step timeline, bounded unified diff/file navigation, additions/deletions, text-safe lexical highlighting, expandable unchanged context, verification status/duration/output, matching persisted review verdict/references and artifact paths. Run IDs/provenance stay in collapsed metadata. Current workspace patches are explicitly labelled as including pre-existing edits; executor reports and recorded verifier/reviewer evidence remain distinct. Missing review is pending, and repair remains in the bound conversation until the real P0.14 implementation. No fake test counts, approval or arbitrary file-opening capability was added.

All five baseline commands passed. Six new tests cover diff limits/line numbers, hostile text, quoted/traversal paths, binary files, mismatched verifier events and mismatched review/result identity (eight Control Center tests total). GUI browser smoke passed with seven routes plus dark Run Detail, file navigation and expanded verification output; production-asset/local-daemon session smoke passed. Side Panel screenshot/keyboard/width smoke passed. HTTP Chromium extension smoke passed with two executions/handbacks, verifier fail/pass, revocation, 14 send/safety cases and 3,000-turn/60s idle: zero DOM queries, 0.0284s TaskDuration. New screenshots include `control-center-run.png`, `control-center-failed.png` and `control-center-run-dark.png` in `output/playwright/gui/`.

### GUI-6 verification — 2026-09-09

`pnpm ui:dev` provides independent, interactive Side Panel/Control Center/popup fixtures. Production bundles exclude fixture data/fonts. Twenty-four versioned screenshots pin Chromium 149.0.7827.55/macOS, scale, viewport, locale, time, local font versions and reduced motion; `pnpm ui:test` compared all 24 with **zero differing pixels**. Automated WCAG A/AA checks passed for every captured state. Narrow/wide widths, menu/drawer keyboard controls, diff navigation and reduced motion passed. Virtualized Project/run lists mount at most 14 rows with 3,000 entries; Home/End focus also works before scrolling. Auxiliary text contrast was strengthened after the automated audit. Hidden popup/panel refresh work is suspended; sign-out clears the GUI snapshot and rejects late evidence replies.

All five baseline commands passed (**2,005 tests**, including 69 extension tests and nine Control Center tests). `smoke:panel`, `smoke:gui`, native MV3 and retained HTTP MV3 smoke passed. Both extension transports executed twice and returned two same-conversation results, with failed/passed Verifier evidence, 14 send-normalization/safety cases and one completed-turn check after 1,000 mutations. Native refresh/Unbind and scoped Side Panel → built Control Center Project/run navigation passed; HTTP revocation passed. For 3,000 old turns and 60s idle, both performed zero DOM queries (TaskDuration native 0.0224s, HTTP 0.0164s). The final production-asset/local-Daemon GUI run with 36 Projects measured 60 idle seconds, zero API requests, zero UI mutations and 0.0199s TaskDuration. These are isolated browser measurements, not a personal Chrome profile or real model proof.

Screenshot baselines are in `apps/dashboard/test/visual/baseline/`; review images and JSON reports are in `output/playwright/gui/`. Both source and CLI-packaged extension assets were built and byte-compared; only current GUI hashed bundles are packaged. See [GUI acceptance](GUI-ACCEPTANCE.md) for startup, Chrome Reload, fixed-browser commands, screenshot inventory and remaining timers. **Stop for the user's first visual review after focused commits/push. P0.12 stays [!]; P0.13–P0.15 remain unstarted.**

### GUI localization — user request, 2026-09-10

**Status:** [x]

Depends on completed GUI-1–GUI-6. Localize Side Panel, popup, Diagnostics, machine-message controls and Local Control Center into Simplified Chinese and English. Default to Simplified Chinese, provide explicit persistent language selection, and preserve canonical protocol values, Project/run evidence and all dispatch/delivery safety checks. Verify both languages, switching/restoration, accessibility/widths and idle behavior, then run all five repository checks. This work does not complete real P0.12 acceptance or start P0.13–P0.15.

Implemented a shared UI translation catalog, bilingual language selectors and persistent local preferences. Extension surfaces synchronize through trusted extension storage; cosmetic updates repaint only Veyra-owned machine controls in the current supported tab. Control Center preferences use a private machine-registry file and the existing authenticated/CSRF-protected local session, surviving refresh and server/port changes. Project content, raw evidence and protocol values remain verbatim. No polling, dispatch, replay, binding change or approval authority was added.

All five repository checks passed (**2,016 tests**, including 72 extension tests). Locale regression covers interpolation parity, unknown/prototype-like text, save failures, late reads, storage synchronization, private-file protections, forged requests and revocation. Native/HTTP Chromium fixtures switched language without changing binding records or execution count; both retained two executions/handbacks, verifier fail/pass, 14 send/safety cases, 3,000 old turns and zero idle DOM queries over 60 seconds (TaskDuration 0.0191s / 0.0217s). Production Control Center restored English after refresh and a real server restart on another port; its 36-Project idle test recorded zero API requests/UI mutations and 0.0150s TaskDuration over 60 seconds.

`smoke:panel`, `smoke:gui`, both extension transport smokes and `pnpm ui:test` passed. **48 bilingual screenshots compared with zero differing pixels**, with automated WCAG A/AA, keyboard and width checks. Source and CLI-packaged extension assets are rebuilt; existing Chrome installations require Reload and a target ChatGPT page refresh. See [GUI acceptance](GUI-ACCEPTANCE.md). These are deterministic local proofs; **P0.12 remains [!] for real Pro re-acceptance, and P0.13–P0.15 remain unstarted.**

## P0.13 — Real ChatGPT → Codex → ChatGPT closed loop

**Status:** [ ]

**Depends on:** P0.12; the current user-directed GUI phase order also requires GUI-6 and user visual review before this final product demo work.

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

# TUI — deferred / optional future surface

Preserve `apps/tui` as a scaffold. It is not required by P0/P1 and has no automatic start condition after a milestone. Do not develop it unless a new explicit product decision restores it to the roadmap. GUI implementation is tracked in the phases above and does not depend on TUI.

The existing `apps/dashboard` scaffold hosts the GUI-4 Local Control Center. Its Projects/Runs/settings/evidence UI must reuse shared `packages/ui` and the same Project/Daemon contracts. Remote/cloud control remains a separate deferred decision.

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

**Real P0.12 successful Project execution after the native environment/deadline repair.** Canonical dispatch and automatic failure handback are now demonstrated in real Pro. Preserve that failed run, retain the current binding, and stop after focused commits/push for a new user-directed task. The native host recovers the existing macOS system proxy and uses a bounded 15-minute execution budget; the real no-tools connectivity probe passes. No Extension Reload, rebind, setup/init/pairing or old-handoff replay is required for this backend fix. Do not infer successful Project verification from fixtures or connectivity, or start P0.13–P0.15 before P0.12 passes.

Optional API smoke is not a blocker.
