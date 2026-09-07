# Architecture

This document owns Veyra's stable package boundaries and responsibility model. Read [AGENTS.md](../AGENTS.md) for contributor rules, [TODO](TODO.md) for the next implementation task and its acceptance criteria, [ROADMAP](ROADMAP.md) for milestone status, and the [README](../README.md#development) for setup commands.

## Mental model

Veyra separates the system into explicit layers so orchestration remains provider-neutral and user interfaces remain replaceable.

1. **Protocol** — provider-neutral contracts and events.
2. **Workflow** — graph, DSL, transitions, retry, branching, parallelism, gates.
3. **Runtime** — executes agents/processes and manages their lifecycle.
4. **Verifier** — deterministic shell/test/build/benchmark verification.
5. **Core** — coordinates workflow execution, state, events, and policy.
6. **Providers** — adapters for reasoning agents and coding agents.
7. **Surfaces** — CLI, TUI, and Dashboard.

## Repository boundaries

```text
apps/
  cli/          automation/headless surface (`ve`)
  tui/          interactive terminal surface
  dashboard/    Web control center

packages/
  core/         orchestration
  workflow/     workflow DSL + state machine
  runtime/      agent/process runtime
  verifier/     deterministic verification
  protocol/     shared contracts
  config/       config parser
  sdk/          extension SDK

plugins/
  openai/
  codex/
  claude/
  claude-code/
  gemini/
  opencode/
```

The directory layout represents the target architecture, not the percentage of implementation complete.

The project name is **Veyra** while its public terminal command is **`ve`**. Brand-owned configuration/state names (`veyra.yaml`, `.veyra/`) are intentionally independent from the short executable name.

## Dependency direction

```text
apps/cli ──────────┐
apps/tui ──────────┼──────────────┐
apps/dashboard ────┘              │
                                  ▼
                            packages/core
                           /      |      \
                          ▼       ▼       ▼
                  workflow    runtime   verifier
                       \         |         /
                        \        ▼        /
                         └── protocol ───┘
                                ▲
                                │
                            plugins/*
```

Provider adapters are injected into the runtime/core through protocol interfaces. Core must never import a concrete provider package.

## Responsibilities

### Core

Coordinates a run: workflow state, step scheduling, policy, state persistence integration, and event emission. It should not know how a specific CLI process is spawned or how a specific model API is called.

### Workflow

Owns declarative workflow definitions and transition semantics. The initial node vocabulary should stay small:

- `agent`
- `command`
- `human`
- `parallel`
- `router`
- `subworkflow`
- `end`

### Runtime

Owns execution lifecycle concerns such as:

- invoking an `AgentAdapter`
- spawning local coding-agent CLIs
- working directory isolation
- stdout/stderr streaming
- cancellation
- timeout
- exit status

### Verifier

Owns objective verification. Examples:

- shell commands
- unit/integration tests
- lint
- typecheck
- build
- benchmarks
- custom deterministic checks

LLM review is not deterministic verification and must remain a separate workflow step.

### Protocol

Defines shared input/output contracts so providers and surfaces do not leak into one another.

### Surfaces

CLI, TUI, and Dashboard render core state/events and issue commands. They should not reimplement orchestration logic.

## Event model

The engine should emit structured events such as:

- `run.started`
- `run.completed`
- `run.failed`
- `run.paused`
- `step.started`
- `step.completed`
- `step.failed`
- `agent.started`
- `agent.completed`
- `verification.completed`
- `approval.required`

## State

Start with transparent local files:

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

A database or remote control plane can be introduced later without changing workflow semantics.
