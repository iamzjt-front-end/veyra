# Roadmap

Veyra is now explicitly **project-centered and native-auth-first**. Read [`PRODUCT.md`](../PRODUCT.md) for the product definition and [`docs/TODO.md`](TODO.md) for the canonical task-by-task plan.

The repository already contains substantial verified orchestration/runtime/provider infrastructure. The roadmap below distinguishes those foundations from the current product priority.

## P0 — Project-centered GPT ↔ Codex Native Bridge

**Current product priority.**

Goal: let a real ChatGPT workflow hand work to an already-authenticated native Codex inside a selected Veyra Project, then return structured implementation evidence to ChatGPT automatically for review/repair — with no manual copy/paste and no OpenAI API key required for the golden path.

- [x] product pivot recorded in `PRODUCT.md`
- [x] Project first-class model
- [x] global local Project Registry
- [x] shared Project State / handoff contract
- [ ] local Veyra Daemon
- [ ] typed daemon IPC/tool API
- [ ] native Codex readiness/auth as default executor path
- [ ] project-bound Codex session continuity
- [ ] project role binding to native Codex
- [ ] canonical planner/executor/reviewer handoff protocol
- [ ] real native Codex Project dispatch E2E with `OPENAI_API_KEY` unset
- [ ] ChatGPT bridge feasibility ADR/spike
- [ ] selected ChatGPT bridge proof
- [ ] **real ChatGPT → Codex → ChatGPT closed loop (MVP gate)**
- [ ] automatic review/fix loop
- [ ] stable onboarding/demo

The exact implementation order and acceptance criteria are in [`TODO.md`](TODO.md).

## P1 — TUI / Agent Mission Control

TUI work no longer waits on an OpenAI API smoke test. It is downstream of the native project bridge so it renders the correct Project/Daemon model instead of becoming a parallel orchestration system.

- [ ] project selector/registry view
- [ ] daemon health/readiness
- [ ] workflow/run graph
- [ ] native agent/session status
- [ ] timeline/event stream
- [ ] diff/review/verification views
- [ ] approval inbox
- [ ] pause/resume/cancel
- [ ] TUI regression tests
- [ ] stable demo

Bare `ve` may eventually launch the TUI, while headless commands remain supported.

## P2 — Dashboard

Dashboard implementation follows a stable Project/Daemon/TUI model.

- [ ] local Web control center foundation
- [ ] project/run bridge and event streaming
- [ ] Projects page
- [ ] Run detail page
- [ ] workflow visualization
- [ ] native agent/provider readiness/settings
- [ ] human approval inbox
- [ ] cost/token/duration metrics where known
- [ ] multi-project runs
- [x] remote worker/control-plane design document only

Remote/cloud execution remains deferred and requires a separate explicit product decision.

---

# Verified foundations retained from the pre-pivot roadmap

These capabilities are not discarded. They provide the engine/safety/release base for P0.

## M0 — Repository baseline

- [x] reproducible pnpm install and lockfile
- [x] formatting/linting baseline
- [x] CI for pull requests/main
- [x] test conventions and deterministic fixtures
- [x] documentation hierarchy/cross-links

## Orchestration / workflow foundation

- [x] complete Monorepo architecture scaffold
- [x] provider-neutral protocol contracts
- [x] YAML config loader
- [x] workflow loader/validator
- [x] persistent local run state
- [x] local process runtime
- [x] shell verifier
- [x] Core orchestration loop
- [x] reviewer/fix loop
- [x] bounded retry enforcement
- [x] human approval nodes
- [x] `ve init/run/status/review/resume/doctor`
- [x] deterministic E2E tests
- [x] versioned Workflow DSL
- [x] typed context/step outputs
- [x] branching
- [x] parallel steps
- [x] routers
- [x] subworkflows
- [x] consensus/judge nodes
- [x] execution policies/loop safety
- [x] user-defined workflow UX

## Native/provider foundation

- [x] Codex native adapter and deterministic/native fixture verification
- [x] provider capability model
- [x] public plugin registry/SDK
- [x] OpenAI API adapter (optional integration)
- [x] Claude API adapter (optional integration; live API smoke not required for P0)
- [x] Claude Code adapter implementation (optional native integration)
- [x] Gemini API adapter (optional integration)
- [x] Gemini CLI adapter implementation (optional native integration)
- [x] OpenCode adapter implementation (optional native integration)
- [x] local/OpenAI-compatible adapter
- [x] authentication/secret-handling policy
- [x] agent role profiles
- [x] optional provider capability routing

### Optional live validations, no longer product blockers

- [ ] OpenAI API live smoke (requires optional `OPENAI_API_KEY`)
- [ ] Anthropic API live smoke
- [ ] Gemini API live smoke
- [ ] Claude Code live timeout investigation
- [ ] OpenCode native credential investigation
- [ ] Gemini CLI live verification when executable is available

Missing API credentials must not make the P0 native GPT ↔ Codex path unhealthy.

## Hardening

- [x] worktree/workspace isolation
- [x] command execution safety and provenance
- [x] crash recovery/idempotency policy
- [x] local run/store locking and stale-owner recovery
- [x] cancellation propagation and process cleanup
- [x] bounded event/artifact storage and retention
- [x] prompt/decision provenance
- [x] macOS/Linux platform verification and explicit native Windows policy
- [ ] secret-redaction rendering checks for future ChatGPT Bridge/TUI/Dashboard surfaces (existing managed paths already hardened)

## Open-source productization

- [x] official `@veyraoss` package strategy and ownership verification
- [x] fixed versioning/changelog workflow
- [x] release CI and protected publication workflow
- [x] isolated global npm install verification for `ve`
- [x] contributor/development documentation
- [x] security/community policies
- [x] example gallery
- [x] local evaluation harness
- [x] default no-external-product-telemetry policy
- [ ] final product documentation/demo polish after P0/P1

No npm package/public release has been published yet. Publication remains an explicit human-approval boundary.

---

# Release gate

A first public release should not be triggered just because release tooling works.

Before publication, at minimum:

- [ ] P0 real ChatGPT → Codex → ChatGPT loop is verified;
- [ ] P0 onboarding/demo is reproducible;
- [ ] README/install docs describe native-auth-first behavior accurately;
- [ ] OpenAI API key is clearly optional for the golden path;
- [ ] all baseline/CI checks pass;
- [ ] release artifacts/changelog are reviewed;
- [ ] user gives explicit publication approval.

For the next concrete engineering task, follow [`docs/TODO.md`](TODO.md#next-task).
