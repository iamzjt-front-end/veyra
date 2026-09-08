# Roadmap

The repository keeps the full target architecture visible from the start. Roadmap milestones describe implementation maturity, not when directories are introduced.

For the canonical task-by-task implementation order, dependencies, tests, and acceptance criteria, see [`docs/TODO.md`](TODO.md).

The [README](../README.md) introduces Veyra and local setup. [AGENTS.md](../AGENTS.md) defines contributor rules; [ARCHITECTURE](ARCHITECTURE.md) defines stable boundaries. This roadmap summarizes verified milestones and does not replace the detailed TODO.

## M0 — Repository baseline

- [x] Reproducible pnpm install and lockfile
- [x] Formatting/linting baseline
- [x] CI for pull requests/main
- [x] Test conventions and deterministic fixtures
- [x] Documentation hierarchy/cross-links

## v0.1 — Working vertical slice

- [x] Complete Monorepo architecture scaffold
- [x] Provider-neutral protocol scaffold
- [x] Workflow types
- [x] Core event contracts
- [x] Runtime package scaffold
- [x] Verifier package scaffold
- [x] Built-in workflow preset scaffolds
- [x] Provider/dashboard placeholders
- [x] YAML config loader
- [x] Workflow loader/validator
- [x] Hardened protocol contracts
- [x] Persistent local run state
- [x] Working OpenAI planner/reviewer adapter
- [x] Working Codex CLI executor adapter
- [x] Local process runtime
- [x] Shell verifier implementation
- [x] Core orchestration loop
- [x] Reviewer/fix loop
- [x] Retry limit enforcement
- [x] Human approval node
- [x] Working `ve init/run/status/review/resume/doctor`
- [x] Deterministic E2E tests
- [ ] Opt-in real GPT + Codex smoke test (tooling tested; live run blocked by missing OpenAI API credential)

## v0.2 — TUI

- [ ] TUI rendering/event foundation
- [ ] Workflow graph/status view
- [ ] Agent status panel
- [ ] Timeline/event stream
- [ ] Diff/review/verification views
- [ ] Approval actions
- [ ] Pause/resume/cancel
- [ ] TUI regression tests

## v0.3 — Workflow DSL

- [x] Versioned DSL schema
- [x] Typed context/step outputs
- [x] Branching
- [x] Parallel steps
- [x] Routers
- [x] Subworkflows
- [x] Consensus/judge nodes
- [x] Execution policies/loop safety
- [x] Workflow preset hardening
- [x] User-defined workflow UX

## v0.4 — Provider ecosystem

- [x] Provider capability model
- [x] Public plugin registry/SDK
- [ ] Claude API (adapter and deterministic tests implemented; live smoke blocked by missing Anthropic API credential)
- [ ] Claude Code (adapter and deterministic tests implemented; live smoke blocked by native provider request timeouts)
- [ ] Gemini API (adapter, opt-in vision and deterministic tests implemented; live smoke blocked by missing API credential)
- [x] Gemini CLI (Runtime adapter and deterministic tests; native executable unavailable for live verification)
- [ ] OpenCode (adapter and deterministic tests implemented; live smoke blocked by native HTTP 401)
- [x] Local/OpenAI-compatible adapter (explicit Chat Completions modes and loopback HTTP verification)
- [x] Authentication/secret-handling policy
- [x] Agent role profiles
- [x] Optional provider capability routing (explicit ordered fallbacks, scoped readiness and user-supplied estimates)

## v0.5 — Dashboard

Dashboard implementation is waiting for the requested stable TUI prerequisite; M2 remains dependent on the blocked live v0.1 smoke. The independent remote-control design document can proceed without enabling remote execution.

- [ ] Local Web control center foundation
- [ ] Local project/run bridge and event streaming
- [ ] Projects page
- [ ] Run detail page
- [ ] Workflow visualization
- [ ] Agent/provider settings
- [ ] Human approval inbox
- [ ] Cost/token/duration metrics
- [ ] Multi-project runs
- [ ] Remote worker/control-plane design

## Hardening and open-source productization

These areas continue across milestones and are tracked in detail in `docs/TODO.md`:

- [ ] worktree/workspace isolation
- [ ] command execution safety
- [ ] secret redaction
- [ ] crash recovery/idempotency
- [ ] locking/concurrency/cancellation
- [ ] artifact/log retention
- [ ] cross-platform support
- [ ] public package/release strategy
- [ ] contributor/security/community docs
- [ ] example gallery and docs polish
- [ ] evaluation/benchmark harness
