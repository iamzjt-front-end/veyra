# Veyra Product Definition

> **Your project. Your agents. One shared context.**

Veyra is a **project-centered control plane for the AI tools a developer already uses**.

The product is **GUI-first, Project-first, Native-auth-first, API-key-optional**. [UX Flow](docs/UX-FLOW.md) and [Design](docs/DESIGN.md) define its interaction and visual contract: Chrome Side Panel is the primary daily surface, Local Control Center is the deeper Project/Run surface, and CLI supplies setup/init/open/doctor infrastructure. TUI is deferred and is not a P0/P1 requirement.

The first product goal is intentionally narrow:

> Make ChatGPT and Codex work as one project team without requiring the user to copy messages between them and without requiring an OpenAI API key for the core workflow.

## The problem

A common workflow today is:

```text
ChatGPT
  ↓ plan
Human copies plan
  ↓
Codex
  ↓ implementation
Human copies result
  ↓
ChatGPT
  ↓ review / next plan
Human copies again
  ↓
Codex
```

The developer becomes the message bus.

Veyra exists to remove that coordination work while keeping the developer in control of important approvals.

## Product model

The first-class object in Veyra is a **Project**, represented by a real local folder.

```text
~/Projects/my-app/
├── src/
├── tests/
├── ...
└── .veyra/
    ├── project.yaml
    ├── state.json
    ├── context/
    ├── handoffs/
    ├── runs/
    └── artifacts/
```

The project folder is the shared workspace. `.veyra/` is the shared project state used to coordinate tools that otherwise have separate conversations and sessions.

Veyra must not depend on one agent reading another agent's full chat history. The durable shared state is the project, its files, structured handoffs, decisions, verification evidence and run state.

## First golden path

The first release-worthy product proof is:

```text
                 ChatGPT
          Planner / Reviewer
                  │
                  │ structured handoff
                  ▼
             Veyra Bridge
                  │
                  ▼
             Veyra Daemon
                  │
        ┌─────────┴─────────┐
        │                   │
        ▼                   ▼
  Project Shared State   Codex Native
      .veyra/          existing ChatGPT login
        │                   │
        │              edits / commands
        │                   │
        └─────────┬─────────┘
                  ▼
              Verifier
                  │
                  ▼
             Veyra Result
                  │
                  ▼
                 ChatGPT
          review / next plan
```

The user should be able to start from a ChatGPT conversation, hand a project task to Codex automatically, receive the implementation result back in the same planning/review flow, and continue the loop without manually copying text.

## Native-auth-first

Veyra should prefer tools the user is already authenticated to use.

For the first golden path:

- ChatGPT is the planning/review surface.
- Codex runs through the installed native Codex client/CLI and reuses its existing ChatGPT account authentication.
- Veyra does not require `OPENAI_API_KEY` for this path.

API providers remain supported as **optional integrations**. They are useful for automation, CI, alternate models and advanced configurations, but they are not the reason Veyra exists and must not block the core native workflow.

Preferred integration order:

1. native authenticated client/session;
2. existing local account/session;
3. local or OpenAI-compatible model;
4. API-key provider when the user explicitly chooses it.

## Project-centered shared context

Veyra shares engineering state, not arbitrary chat transcripts.

Useful shared context includes:

- project goal;
- current plan;
- acceptance criteria;
- constraints;
- decisions and their rationale;
- current task;
- changed files;
- Git diff summary;
- verification results;
- artifacts;
- review verdict;
- next action;
- retry/approval state.

A handoff should be structured and bounded. Example:

```json
{
  "projectId": "veyra",
  "runId": "run-123",
  "role": "executor",
  "goal": "Implement project registry",
  "plan": {
    "summary": "...",
    "tasks": ["..."],
    "acceptanceCriteria": ["..."]
  },
  "context": {
    "constraints": ["..."],
    "decisions": ["..."]
  }
}
```

Execution returns structured evidence rather than a pasted conversation:

```json
{
  "status": "completed",
  "summary": "...",
  "changedFiles": ["..."],
  "verification": {
    "status": "passed"
  },
  "artifacts": []
}
```

## Project registry

Project-owned state belongs in the project folder. A lightweight global registry may keep only enough information to find projects:

```text
~/.veyra/
└── projects.json
```

Example responsibilities:

- project id/name;
- absolute/local path;
- last-opened timestamp;
- daemon/project binding metadata that is not project-owned.

The registry must not become a second source of truth for project workflow state.

## Local daemon

Veyra needs a local coordinator so ChatGPT-facing bridges, GUI/CLI surfaces and native agents can communicate with the same project state.

The daemon owns local coordination concerns such as:

- project registry access;
- run dispatch;
- run status and waiting;
- Codex session creation/resume;
- event streaming;
- structured handoffs;
- verifier integration;
- safe cancellation;
- local authentication/readiness discovery.

It must not become a cloud requirement. Veyra remains useful offline except where the chosen AI tool itself needs network access.

## ChatGPT bridge

The long-term preference is an official, supported ChatGPT App/Plugin/tool integration when the product surface exposes the required capabilities.

Until then, an experimental local/browser bridge may be used to prove the product loop, but it must be isolated from Core and treated as replaceable infrastructure.

For the current **ChatGPT Pro** P0 proof, the selected path is `apps/chatgpt-extension`: an **Experimental Browser Bridge** for Chrome/Chromium + `chatgpt.com`, using Chrome Native Messaging to reach the local coordinator. The product flow is **Setup once. Bind once. Then just talk.** See [UX Flow](docs/UX-FLOW.md). `ve setup` establishes a persistent local installation, `ve init` registers a native-bound Project, and explicit current-conversation binding persists across refresh. Loopback HTTP and pairing files remain developer diagnostics/fallback only. Only validated `VEYRA_HANDOFF_BEGIN/END` data can dispatch; structured `VEYRA_RESULT_BEGIN/END` evidence returns to that same conversation for review. The bridge does not read full ChatGPT history or native credentials, and does not use a public server, tunnel or API key.

The retained `apps/chatgpt-bridge` is the **preferred future official Full MCP production path**, conditional on verified write/action entitlement. Reachability alone does not prove that entitlement; the [ADR](docs/ADR-001-CHATGPT-BRIDGE.md) records conflicting official plan documentation. Native Codex keeps its existing login, API providers stay optional, and `<project>/.veyra/` remains the shared-state center regardless of bridge replacement. P0.12's real Chrome/Pro acceptance is pending; local fixtures are not a product-loop proof.

Bridge rules:

- explicit user installation/permission;
- project-scoped actions;
- no hidden collection of unrelated conversations;
- no assumption that "Sign in with ChatGPT" grants chat-history access;
- no scraping stored ChatGPT history as Veyra's memory model;
- use structured handoffs to/from the current workflow;
- official integration should be preferred whenever it can replace experimental UI automation.

## Codex integration

Codex is the first executor.

The native path should support:

- detect installed Codex;
- detect whether native authentication is ready without reading secrets;
- start a project-bound session;
- resume a known project session where supported;
- dispatch structured work;
- stream/collect completion state;
- collect changed files/diff/verification evidence;
- persist only safe session references needed for project continuity.

Do not copy or persist Codex credentials.

## Human control

Veyra should remove routine coordination, not remove user authority.

Human approval remains required for explicitly gated actions such as:

- package publication;
- public release;
- production deployment;
- destructive repository/history operations;
- destructive data migration;
- credential/security decisions that require user choice;
- any workflow-defined approval gate.

Normal plan → execute → verify → review iterations should continue automatically within configured limits.

## What Veyra is not

Veyra is not:

- another chat UI;
- a replacement for ChatGPT or Codex;
- an API-key-only multi-agent framework;
- a system that requires every model to use the same provider;
- a chat-history scraper;
- an autonomous system allowed to publish/deploy without approval;
- a cloud service requirement.

## Product priorities

Priority order until the first product proof is complete:

1. Project model and shared state.
2. Local daemon and project IPC.
3. Native Codex authentication/session continuity.
4. Structured GPT ↔ Codex handoff protocol.
5. Real P0.12 ChatGPT/native transport proof.
6. GUI productization: shared UI system, Side Panel and Local Control Center in the TODO phase order.
7. Real P0.13 closed loop, P0.14 automatic review/fix and P0.15 stable demo using that GUI.
8. Additional agents/providers only after the golden loop is proven.

Additional providers, model routing and API integrations must not distract from the first GPT + Codex loop.

The current simplified popup is an interim proof interface. It will become a small Side Panel launcher; it is not the target daily GUI. Shared `packages/ui` and the Control Center are planned, not shipped. Preserve the existing TUI scaffold without investing in it unless a future product decision restores it to the roadmap.

## MVP success criterion

Veyra reaches its first meaningful product milestone when this works on a real project:

```text
User asks ChatGPT to implement a project change
        ↓
ChatGPT creates/approves the plan
        ↓
Veyra dispatches it to native Codex automatically
        ↓
Codex changes the project
        ↓
Veyra verifies and packages the result
        ↓
The result is returned to the ChatGPT workflow automatically
        ↓
ChatGPT reviews it and either finishes or sends a repair
```

No manual copy/paste between ChatGPT and Codex. No OpenAI API key required for the core path.

That is Veyra's P0 product proof.
