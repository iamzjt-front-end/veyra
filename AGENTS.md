# AGENTS.md — Veyra contributor instructions

## Product intent

Veyra is a provider-agnostic control plane for heterogeneous AI agents. Its core value is orchestration, verification, resumability, and human control — not another chat UI and not another single-model coding agent.

## Stable architecture

The repository uses a complete architecture scaffold even when some modules are still planned. Do not collapse package boundaries merely because a feature has not been implemented yet.

### Package ownership

- `packages/core` — orchestration and run coordination only.
- `packages/workflow` — workflow graph, DSL, transitions, retries, branching, gates.
- `packages/runtime` — agent/process execution lifecycle, cancellation, timeouts, working directories, streams.
- `packages/verifier` — deterministic verification such as shell, tests, lint, typecheck, build, benchmark.
- `packages/protocol` — provider-neutral contracts and shared event/result types.
- `packages/config` — config loading, parsing, validation, defaults.
- `packages/sdk` — public extension surface for third-party providers/nodes/tools.
- `plugins/*` — provider-specific adapters.
- `apps/*` — user interfaces only; business logic belongs in packages.

## Architectural rules

1. `packages/core` must not depend on a specific model vendor.
2. Provider-specific logic lives under `plugins/*`.
3. All agent input/output crosses `@veyra/protocol` contracts.
4. `packages/core` must not directly spawn Codex, Claude Code, or other provider CLIs; process lifecycle belongs in `packages/runtime`.
5. Deterministic verification belongs in `packages/verifier` and is distinct from LLM review.
6. Workflows must be declarative and resumable.
7. Human approval is a first-class workflow node, not a UI-specific hack.
8. CLI, TUI, and Dashboard consume the same core/event model.
9. Do not bind the architecture to GPT + Codex even if they are the first fully working adapters.
10. Planned provider/dashboard directories may remain placeholders until their roadmap milestone; do not remove them as "unused".
11. The product/brand name is `Veyra`, but the public CLI command is `ve`. Do not reintroduce `veyra` as the executable name. Brand-owned config/state names such as `veyra.yaml` and `.veyra/` remain unchanged unless explicitly redesigned.

## Master implementation plan

`docs/TODO.md` is the canonical detailed execution plan. `docs/ROADMAP.md` is only the milestone summary.

When implementing roadmap work:

1. Read `docs/TODO.md` before coding.
2. Unless the user explicitly names a different task, take the first unchecked TODO whose dependencies are complete.
3. Work on **one TODO item at a time** and do not start later items speculatively.
4. Implement only the minimum supporting changes required for that TODO.
5. Satisfy its acceptance criteria and tests before marking it complete.
6. Update the TODO checkbox/status truthfully only after verification passes.
7. Stop after the requested TODO and report results, blockers, and verification commands.

Do not treat future/deferred TODO items as permission to expand the current task's scope.

## First implementation target

Build a vertical slice for:

```text
plan → execute → verify → review
                    ↑       |
                    └─ fix ─┘
```

with a maximum retry count, persisted local state, and an optional human gate.

## Coding conventions

- TypeScript, strict mode.
- Prefer small explicit interfaces over framework-heavy abstractions.
- Avoid LangChain/LangGraph in v0.1 unless a concrete requirement proves necessary.
- No hidden global state.
- Persist workflow/run state as JSON first; database support can come later.
- Emit structured events so CLI/TUI/Dashboard can subscribe without coupling to engine internals.

## Before completing a task

Run the task-specific checks in `docs/TODO.md` plus the repository baseline checks that currently exist.

The intended baseline is:

```bash
pnpm lint
pnpm format:check
pnpm check
pnpm test
pnpm build
```

`lint`/`format:check` become mandatory once M0.2 is implemented. If a command cannot run, report the blocker instead of silently skipping it.
