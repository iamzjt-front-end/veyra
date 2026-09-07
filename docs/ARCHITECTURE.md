# Architecture

## Mental model

Veyra separates five concerns:

1. **Protocol** — provider-neutral contracts.
2. **Workflow** — graph, transitions, retry, parallelism, gates.
3. **Runtime/Core** — executes the graph and emits events.
4. **Providers** — adapters for reasoning agents and coding agents.
5. **Surfaces** — CLI, TUI, and future GUI.

## Dependency direction

```text
apps/cli ─────┐
apps/tui ─────┼──> packages/core ──> packages/workflow
future/gui ───┘          │                   │
                          ├──> packages/protocol
plugins/* ────────────────┘
```

Core may call a provider only through a protocol interface supplied at runtime.

## Core workflow nodes

The initial node vocabulary should stay small:

- `agent`
- `command`
- `human`
- `parallel`
- `router`
- `subworkflow`

## Event model

The engine should emit structured events such as:

- `run.started`
- `run.completed`
- `step.started`
- `step.completed`
- `step.failed`
- `agent.started`
- `agent.completed`
- `verification.completed`
- `approval.required`
- `run.paused`

CLI/TUI/GUI should render these events rather than reaching into engine state.

## State

Start with local files:

```text
.veyra/
  state/
  runs/
    <run-id>/
      input.json
      events.jsonl
      state.json
      artifacts/
```

This keeps v0.1 transparent, debuggable, and git-friendly where appropriate.
