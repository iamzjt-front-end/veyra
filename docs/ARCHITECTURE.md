# Architecture

This document owns Veyra's stable responsibility model. Read [`PRODUCT.md`](../PRODUCT.md) first for product intent, [`AGENTS.md`](../AGENTS.md) for contributor rules, [`TODO`](TODO.md) for implementation order, and [`ROADMAP`](ROADMAP.md) for milestone status.

## Architectural thesis

Veyra is a **project-centered control plane**.

The durable coordination boundary is not a model conversation. It is a real local Project plus structured shared state.

```text
                 ChatGPT
            planner / reviewer
                   │
             bridge surface
                   │
                   ▼
              Veyra Daemon
                   │
              Veyra Project
        ┌──────────┼──────────┐
        │          │          │
        ▼          ▼          ▼
 shared state   Core/flow   Codex Native
   .veyra/       + verify   existing login
        │          │          │
        └──────────┼──────────┘
                   ▼
            structured result
                   │
                   ▼
                 ChatGPT
```

ChatGPT and Codex may keep separate native histories/sessions. Veyra does not require them to share raw chat history. Veyra shares project state, handoffs, decisions, artifacts and verification evidence.

## Primary concepts

### Project

A Veyra Project maps to one real local folder and is the first-class object for coordination.

Project-owned state lives with the project:

```text
my-project/
├── source / tests / docs ...
└── .veyra/
    ├── project.yaml
    ├── state.json
    ├── context/
    ├── handoffs/
    ├── runs/
    └── artifacts/
```

The exact files/directories may be created lazily, but ownership is stable:

- project identity and metadata;
- active/previous run state;
- structured context and decisions;
- handoffs/results;
- artifacts/evidence.

Provider credentials do not belong in project state.

### Global Project Registry

A lightweight local registry may live under `~/.veyra/` and stores only enough identity/locator metadata to find projects. It must not become a second source of truth for workflow/run state.

### Shared Project State

The shared-state contract contains engineering context needed for handoff:

- goal;
- plan and acceptance criteria;
- constraints;
- decisions/provenance;
- active task;
- changed files/diff references;
- deterministic verification;
- review verdict/next action;
- bounded artifacts;
- retry/approval state.

It does not contain an unbounded copy of ChatGPT or Codex history.

### Daemon

The local daemon is Veyra's coordinator between surfaces and native agents.

It owns:

- project registry access;
- local health/readiness;
- run dispatch/status/wait/cancel;
- event streaming;
- safe session references;
- project-scoped handoffs/results;
- local IPC/tool API;
- integration with Core/Runtime/Verifier.

The daemon is local-first. It must not turn Veyra into a cloud requirement.

### ChatGPT Bridge

The bridge is a surface, not Core.

Its job is to let an explicitly selected/current ChatGPT workflow communicate with the local daemon using project-scoped structured requests/results.

Preference order:

1. official supported ChatGPT App/Plugin/tool integration;
2. supported local/tunneled bridge;
3. isolated experimental browser bridge for the product proof;
4. desktop UI/accessibility automation only as a last-resort experiment.

The bridge must not assume that identity OAuth grants chat-history access and must not silently harvest unrelated conversations.

For the current ChatGPT Pro proof, [ADR 001](ADR-001-CHATGPT-BRIDGE.md) selects `apps/chatgpt-extension`: all DOM/composer code stays in that replaceable experimental app. Its service worker uses the daemon's optional authenticated `127.0.0.1` HTTP transport, with a local Project allowlist and temporary conversation binding. The daemon contains only transport/Project/evidence logic; the CLI composes native readiness. `apps/chatgpt-bridge` retains the future official Full MCP implementation. No tunnel or API key is part of the current proof.

### Native Codex

Codex is P0's executor through the installed native client/CLI and its normal existing ChatGPT authentication.

Veyra may store safe project/session references where supported, but never copies native credentials.

The P0 golden path must work without `OPENAI_API_KEY`.

API-based model adapters remain optional providers behind the same provider-neutral architecture.

## Layer model

Veyra separates responsibilities so product surfaces remain replaceable and model/provider logic does not leak into orchestration.

1. **Project** — identity, registry and project-owned shared state.
2. **Protocol** — provider/surface-neutral contracts and events.
3. **Workflow** — graph, DSL, transitions, retry, branching, parallelism, gates.
4. **Runtime** — executes agents/processes and manages their lifecycle.
5. **Verifier** — deterministic shell/test/build/benchmark verification.
6. **Core** — coordinates workflow execution, policy, state and events.
7. **Daemon** — local long-lived coordination and IPC/tool API.
8. **Providers** — native/API adapters such as Codex/OpenAI/etc.
9. **Surfaces** — CLI, ChatGPT bridge, TUI and Dashboard.

## Repository boundaries

Current repository plus P0 target additions:

```text
apps/
  cli/             automation/headless surface (`ve`)
  tui/             interactive terminal surface
  dashboard/       Web control center
  chatgpt-bridge/  retained future official Full MCP surface
  chatgpt-extension/  experimental Chrome/Chromium proof for ChatGPT Pro (P0)

packages/
  project/         Project identity, registry, shared-state model (P0)
  daemon/          local coordinator + typed IPC/tool API (P0)
  core/            orchestration
  workflow/        workflow DSL + state machine
  runtime/         agent/process runtime
  verifier/        deterministic verification
  protocol/        shared contracts
  config/          config parser
  sdk/             extension SDK

plugins/
  codex/           native Codex executor (P0 golden path)
  openai/          optional API integration
  claude/          optional API integration
  claude-code/     optional native integration
  gemini/          optional API integration
  gemini-cli/      optional native integration
  opencode/        optional native integration
```

`project`, `daemon`, and the bridge surface are target boundaries introduced by P0. The TODO may refine exact package names if implementation evidence suggests a better decomposition, but responsibility must remain separate.

The product name is **Veyra**, public command is **`ve`**, project state uses **`.veyra/`**, config remains **`veyra.yaml`** where applicable, and official npm packages use **`@veyraoss/*`**.

## Dependency direction

Conceptually:

```text
ChatGPT bridge ─────┐
CLI/TUI/Dashboard ──┼────> Daemon API ─────> Project
                    │          │                │
                    │          ▼                │
                    │        Core <─────────────┘
                    │       / | \
                    │      /  |  \
                    │     ▼   ▼   ▼
                    │ workflow runtime verifier
                    │     \    |    /
                    │      \   ▼   /
                    └──────> protocol
                               ▲
                               │
                           plugins/*
```

Important rules:

- surfaces do not reach into provider private storage;
- Core does not import concrete provider packages;
- Daemon exposes project-scoped operations, not arbitrary filesystem control;
- Runtime owns native process lifecycle;
- Project owns durable coordination state;
- Verifier remains separate from LLM review;
- bridge code is replaceable and cannot own orchestration semantics.

## Responsibilities

### Project package

Owns:

- project ids/descriptors;
- canonical project paths;
- project metadata;
- global registry;
- project-owned shared-state contract/storage helpers;
- safe lookup from nested working directories;
- atomic/concurrent registry/state concerns defined by P0.

It does not execute agents.

### Daemon package

Owns:

- daemon lifecycle/discovery;
- typed local IPC/tool API;
- project registry access;
- run dispatch/status/wait/cancel;
- event subscription;
- native readiness/session coordination;
- local trust/auth boundary for bridge clients.

It delegates execution/state responsibilities to the appropriate packages rather than duplicating them.

### Core

Coordinates a run: workflow scheduling, policy, state integration, retries/approval semantics and event emission. It should not know how a specific CLI process is spawned or how a specific model authenticates.

### Workflow

Owns declarative workflow definitions and transitions, including:

- `agent`;
- `command`;
- `human`;
- `parallel`;
- `router`;
- `subworkflow`;
- consensus/judge semantics;
- `end`.

### Runtime

Owns execution lifecycle:

- invoking adapters;
- spawning local native-agent CLIs;
- working directories/worktrees;
- stdout/stderr streaming;
- cancellation;
- timeout;
- process-tree cleanup;
- exit status.

### Verifier

Owns deterministic evidence:

- shell commands;
- unit/integration tests;
- lint/typecheck/build;
- benchmarks;
- deterministic custom checks.

LLM review is not deterministic verification.

### Protocol

Defines serializable shared contracts so providers, daemon and surfaces do not leak implementation details into one another.

P0 adds versioned handoff/result/project/daemon contracts while preserving provider neutrality.

### Providers

Provider adapters translate Veyra contracts into a specific native/API integration.

Codex native is the first executor. OpenAI API and other model APIs are optional; absence of their API keys must not make the P0 project/native path unhealthy.

### Surfaces

CLI, ChatGPT bridge, TUI and Dashboard render/project state and issue typed commands. They must not reimplement Core or provider logic.

## Authentication model

Veyra distinguishes:

- Veyra local caller/daemon trust;
- native provider authentication owned by the native provider;
- optional API credentials owned by explicit API integrations.

P0 must reuse Codex's supported native authentication/readiness without reading or copying secret files.

A ChatGPT bridge must use the permissions granted by its supported integration surface. Identity login must not be treated as blanket access to user chat history.

## Event model

Existing structured events remain authoritative and should expand only as needed for Project/Daemon/Bridge lifecycle, for example:

- project registered/opened/stale;
- daemon ready/stopping;
- run dispatched;
- run started/completed/failed/paused/resumed;
- handoff created/consumed;
- step started/completed/failed;
- agent started/completed/failed;
- verification started/completed;
- approval required/resolved;
- bridge request/result metadata without raw secret/history capture.

Surfaces render events instead of reaching into internal mutable state.

## State and provenance

Project state remains transparent and local by default.

Existing run snapshots/events/artifacts should be reused rather than building a parallel store.

Every cross-surface handoff/result should retain enough provenance to answer:

- which project/run;
- which role/surface/provider produced it;
- which task/plan/version;
- which evidence supports the result;
- which decision caused the next transition.

Keep payloads bounded. Large diffs/logs/artifacts should be referenced rather than copied into every envelope.

## Safety

Project/Daemon/Bridge additions must preserve current safety work:

- secret redaction;
- worktree/working-directory boundaries;
- command-source provenance;
- approval gates;
- bounded logs/artifacts;
- cancellation/recovery;
- no implicit publication/deployment;
- no external Veyra telemetry by default.

A browser bridge is not a security sandbox. If used, it must request explicit narrow permissions and be isolated from Core so it can later be replaced by an official supported ChatGPT integration.

## Current product gate

The architectural MVP is P0.13:

```text
real ChatGPT workflow
        ↓
structured project handoff
        ↓
local Veyra daemon
        ↓
already-authenticated native Codex
        ↓
real project edit + deterministic verifier
        ↓
structured result
        ↓
same ChatGPT workflow reviews it
```

No manual copy/paste. No OpenAI API key required.

TUI/Dashboard work is downstream product UX, not a substitute for this gate.

The existing [remote-control design](REMOTE-CONTROL-DESIGN.md) remains documentation only. Remote/cloud execution still requires an explicit later product decision; P0 is local-first.
