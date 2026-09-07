# Roadmap

The repository keeps the full target architecture visible from the start. Roadmap milestones describe implementation maturity, not when directories are introduced.

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
- [ ] Persistent local run state
- [ ] Working OpenAI planner adapter
- [ ] Working Codex executor adapter
- [ ] Local process runtime
- [ ] Shell verifier implementation
- [ ] Reviewer loop
- [ ] Retry limit enforcement
- [ ] Human approval node
- [ ] Working `veyra run`

## v0.2 — TUI

- [ ] Workflow graph/status view
- [ ] Agent status panel
- [ ] Timeline/event stream
- [ ] Diff viewer
- [ ] Approval actions
- [ ] Pause/resume

## v0.3 — Workflow DSL

- [ ] Branching
- [ ] Parallel steps
- [ ] Subworkflows
- [ ] Routers
- [ ] Consensus/judge nodes
- [ ] Workflow preset hardening
- [ ] User-defined workflows

## v0.4 — Provider ecosystem

- [ ] Claude API
- [ ] Claude Code
- [ ] Gemini API
- [ ] Gemini CLI
- [ ] OpenCode
- [ ] Local/OpenAI-compatible models
- [ ] Public plugin SDK
- [ ] Provider capability discovery / routing

## v0.5 — Dashboard

- [ ] Local Web control center
- [ ] Multi-project runs
- [ ] Run history
- [ ] Cost/token metrics
- [ ] Workflow visualization
- [ ] Remote worker support
