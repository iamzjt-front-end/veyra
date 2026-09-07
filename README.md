# Veyra

> **One goal. Many agents. Verified execution.**

Veyra is an agent control plane for orchestrating heterogeneous AI agents and deterministic tools in one verifiable workflow.

Instead of asking one model to do everything, Veyra lets you use the best agent for each job:

```text
Goal
  ↓
Planner (GPT / Claude / Gemini)
  ↓
Executor (Codex / Claude Code / Gemini CLI / OpenCode)
  ↓
Verifier (tests / lint / build / benchmark)
  ↓
Reviewer (same or different model)
  ↓
PASS → next step
FAIL → repair loop
```

## Why Veyra?

Today, developers often act as the human message bus between planning models and coding agents. Veyra is intended to remove that manual coordination layer while keeping explicit verification and human approval gates.

## Repository layout

```text
apps/
  cli/          Headless CLI and automation entrypoint
  tui/          Terminal UI (interactive mission control)
packages/
  core/         Orchestration engine
  protocol/     Provider-neutral agent/workflow contracts
  workflow/     Workflow graph and transition engine
  config/       Configuration model and loader
  sdk/          Public extension SDK
plugins/
  openai/       OpenAI reasoning/provider adapter
  codex/        Codex execution adapter
workflows/      Built-in workflow presets
examples/       Minimal examples
docs/           Architecture and roadmap
```

## Planned user experience

```bash
veyra init
veyra run "finish the current milestone"
veyra status
veyra review
veyra resume
```

Running `veyra` without arguments will eventually open the TUI.

## Development

Requirements:

- Node.js >= 20
- pnpm 10 (via Corepack is recommended)

```bash
corepack enable
pnpm install
pnpm build
pnpm veyra -- doctor
```

## Status

This repository currently contains the **v0.1 architecture scaffold**. Provider calls are intentionally stubbed. The next milestone is a working local vertical slice:

1. load `veyra.yaml`
2. load a workflow preset
3. call a planner adapter
4. invoke Codex as executor
5. run deterministic verification commands
6. review result
7. persist run state
8. retry or stop at a human approval gate

See [`docs/ROADMAP.md`](docs/ROADMAP.md).
