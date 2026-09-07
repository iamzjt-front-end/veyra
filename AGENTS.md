# AGENTS.md — Veyra contributor instructions

## Product intent

Veyra is a provider-agnostic control plane for heterogeneous AI agents. Its core value is orchestration, verification, resumability, and human control — not another chat UI and not another single-model coding agent.

## Architectural rules

1. `packages/core` must not depend on a specific model vendor.
2. Provider-specific logic lives under `plugins/*`.
3. All agent input/output crosses `@veyra/protocol` contracts.
4. Deterministic verification (tests, lint, build, benchmark) is distinct from LLM review.
5. Workflows must be declarative and resumable.
6. Human approval is a first-class workflow node, not a special UI hack.
7. CLI, TUI, and future GUI share the same core/event model.
8. Do not bind the product architecture to GPT + Codex even if they are the first supported adapters.

## First implementation target

Build a vertical slice for this workflow:

```text
plan → execute → verify → review
                    ↑       |
                    └─ fix ─┘
```

with a maximum retry count and an optional human gate.

## Coding conventions

- TypeScript, strict mode.
- Prefer small explicit interfaces over framework-heavy abstractions.
- Avoid LangChain/LangGraph in v0.1 unless a concrete requirement proves necessary.
- No hidden global state.
- Persist workflow/run state as JSON first; database support can come later.
- Emit structured events so TUI/GUI can subscribe without coupling to engine internals.

## Before completing a task

Run:

```bash
pnpm check
pnpm test
pnpm build
```

If a command cannot run because the scaffold is incomplete, report the blocker instead of silently skipping it.
