# Roadmap

Veyra is now explicitly **GUI-first, Project-first, Native-auth-first and API-key-optional**. Read [`PRODUCT.md`](../PRODUCT.md) for the product definition and [`docs/TODO.md`](TODO.md) for the canonical task-by-task plan.

The repository already contains substantial verified orchestration/runtime/provider infrastructure. The roadmap below distinguishes those foundations from the current product priority.

## P0 — Project-centered GPT ↔ Codex Native Bridge

**Current product priority.**

Goal: let a real ChatGPT workflow hand work to an already-authenticated native Codex inside a selected Veyra Project, then return structured implementation evidence to ChatGPT automatically for review/repair — with no manual copy/paste and no OpenAI API key required for the golden path.

- [x] product pivot recorded in `PRODUCT.md`
- [x] Project first-class model
- [x] global local Project Registry
- [x] shared Project State / handoff contract
- [x] local Veyra Daemon
- [x] typed daemon IPC/tool API
- [x] native Codex readiness/auth as default executor path
- [x] project-bound Codex session continuity
- [x] project role binding to native Codex
- [x] canonical planner/executor/reviewer handoff protocol
- [x] real native Codex Project dispatch E2E with `OPENAI_API_KEY` unset
- [x] ChatGPT bridge feasibility ADR/spike
- [ ] P0.12 Experimental ChatGPT Web Bridge for Pro product proof (extension installed; real Pro re-acceptance pending)
- [ ] **real ChatGPT → Codex → ChatGPT closed loop (MVP gate)**
- [ ] automatic review/fix loop
- [ ] stable onboarding/demo

Product onboarding follows [UX Flow](UX-FLOW.md): Setup once, Bind once, then talk. Supporting native transport/onboarding work is tracked inside P0.12; it does not claim the later real closed-loop or stable demo gates.

The exact implementation order and acceptance criteria are in [`TODO.md`](TODO.md).

Current Pro P0 uses the isolated Chrome/Chromium **Experimental Browser Bridge**, using Native Messaging with `ve setup` / `ve init` and persistent explicit conversation binding; loopback pairing remains a diagnostic fallback; it reads only explicit handoffs in the bound current conversation, never full ChatGPT history. Native Codex reuses existing login and Project `.veyra/` owns shared engineering state. API providers remain optional; `OPENAI_API_KEY` and public tunnels are not prerequisites. The retained `apps/chatgpt-bridge` is the **preferred future official Full MCP production path** after verified account write/action entitlement. Deterministic extension tests do not complete the real Pro gate or unlock P0.13–P0.15.

## GUI productization — current user priority

The 2026-09-09 user decision moved GUI implementation ahead of the pending real P0.12 re-test. [TODO](TODO.md#gui-productization-phases--user-decision-2026-09-09) records the exact six phases:

1. Shared `packages/ui` design system, light/dark, accessible controls and restrained motion.
2. Chrome Side Panel with explicit Project binding and evidence-based workflow status.
3. Tiny popup launcher/status/Diagnostics.
4. `ve open` local Control Center: Overview, Projects, Runs and Settings.
5. Run detail: bounded unified diff, Verifier evidence, matching review and artifacts.
6. Independent fixtures and fixed visual/keyboard/idle/security regression.

These surfaces are implemented; final acceptance evidence and status live in TODO. Stop after the GUI verification/commit/push for the first user visual review. Real ChatGPT Pro re-acceptance remains pending. Neither fixtures nor screenshots substitute for P0.12/P0.13; automatic review/repair and the stable real demo remain P0.14/P0.15 work.

## TUI — deferred / optional

Preserve `apps/tui` as a scaffold, without further development. It is not required for P0/P1 and has no automatic milestone-triggered start. Surface priority is **Side Panel → Local Control Center → CLI → optional future TUI**. Local GUI does not depend on TUI. Remote/cloud execution remains deferred and requires a separate product decision.

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
- [x] managed redaction/scoped evidence and text-safe rendering for Side Panel/Local Control Center; actual verification is recorded under GUI-4–GUI-6

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
