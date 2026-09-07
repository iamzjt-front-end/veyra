# Roadmap

The repository keeps the full target architecture visible from the start. Roadmap milestones describe implementation maturity, not when directories are introduced.

For the canonical task-by-task implementation order, dependencies, tests, and acceptance criteria, see [`docs/TODO.md`](TODO.md).

## M0 — Repository baseline

- [x] Reproducible pnpm install and lockfile
- [x] Formatting/linting baseline
- [ ] CI for pull requests/main
- [ ] Test conventions and deterministic fixtures
- [ ] Documentation hierarchy/cross-links

## v0.1 — Working vertical slice

- [x] Complete Monorepo architecture scaffold
- [x] Provider-neutral protocol scaffold
- [x] Workflow types
- [x] Core event contracts
- [x] Runtime package scaffold
- [x] Verifier package scaffold
- [x] Built-in workflow preset scaffolds
- [x] Provider/dashboard placeholders
- [ ] YAML config loader
- [ ] Workflow loader/validator
- [ ] Hardened protocol contracts
- [ ] Persistent local run state
- [ ] Working OpenAI planner/reviewer adapter
- [ ] Working Codex CLI executor adapter
- [ ] Local process runtime
- [ ] Shell verifier implementation
- [ ] Core orchestration loop
- [ ] Reviewer/fix loop
- [ ] Retry limit enforcement
- [ ] Human approval node
- [ ] Working `ve init/run/status/review/resume/doctor`
- [ ] Deterministic E2E tests
- [ ] Opt-in real GPT + Codex smoke test

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

- [ ] Versioned DSL schema
- [ ] Typed context/step outputs
- [ ] Branching
- [ ] Parallel steps
- [ ] Routers
- [ ] Subworkflows
- [ ] Consensus/judge nodes
- [ ] Execution policies/loop safety
- [ ] Workflow preset hardening
- [ ] User-defined workflow UX

## v0.4 — Provider ecosystem

- [ ] Provider capability model
- [ ] Public plugin registry/SDK
- [ ] Claude API
- [ ] Claude Code
- [ ] Gemini API
- [ ] Gemini CLI
- [ ] OpenCode
- [ ] Local/OpenAI-compatible models
- [ ] Authentication/secret-handling policy
- [ ] Agent role profiles
- [ ] Optional provider capability routing

## v0.5 — Dashboard

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
