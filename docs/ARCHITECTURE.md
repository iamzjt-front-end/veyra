# Architecture

This document owns Veyra's stable responsibility model. Read [`PRODUCT.md`](../PRODUCT.md) first for product intent, [`AGENTS.md`](../AGENTS.md) for contributor rules, [`TODO`](TODO.md) for implementation order, and [`ROADMAP`](ROADMAP.md) for milestone status.

## Architectural thesis

Veyra is a **project-centered control plane**.

Its surfaces are GUI-first: Chrome Side Panel beside ChatGPT, then Local Control Center, then CLI infrastructure. [UX Flow](UX-FLOW.md) and [Design](DESIGN.md) are the GUI/UX contract. Shared UI, Side Panel and local Control Center are implemented; popup is a small launcher. The user explicitly prioritized GUI-1–GUI-6 ahead of real P0.12 re-acceptance. TUI is optional/deferred and not required by P0/P1.

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
- handoffs/results/reviews;
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
- project-scoped handoffs/results/reviews;
- local IPC/tool API;
- integration with Core/Runtime/Verifier.

The daemon is local-first. It must not turn Veyra into a cloud requirement.

### ChatGPT Bridge

The bridge is a surface, not Core.

Its job is to let an explicitly selected/current ChatGPT workflow communicate with the local daemon using project-scoped structured requests/results.

Preference order:

1. official supported ChatGPT App/Plugin/tool integration;
2. isolated experimental browser bridge for the current ChatGPT Pro product proof;
3. desktop UI/accessibility automation only as a last-resort experiment requiring a separate decision.

The bridge must not assume that identity OAuth grants chat-history access and must not silently harvest unrelated conversations.

For the current ChatGPT Pro proof, [ADR 001](ADR-001-CHATGPT-BRIDGE.md) selects `apps/chatgpt-extension`: all DOM/composer code stays in that replaceable experimental app. Its service worker defaults to `chrome.runtime.connectNative`. The stdio host in `apps/cli` verifies the pinned extension origin and local installation identity, then discovers/starts the coordinator through private Unix IPC. The shared `projectTool` API supplies bounded Project state/readiness/run/Verifier/diff evidence to both native and optional HTTP transports. Explicit conversation bindings persist as routing/intent metadata, without transcript bodies. The daemon contains only transport/Project/evidence logic; the CLI composes native readiness. `apps/chatgpt-bridge` retains the future official Full MCP implementation. No tunnel or API key is part of the current proof.

Full MCP is the preferred future official production path after verifying write/action entitlement. Replacing the browser surface must preserve the existing handoff protocol, shared Project `.veyra/` state, native Codex integration and Project/Daemon/Core/Runtime/Protocol/Verifier responsibilities. No browser selectors or composer operations belong in those packages.

The retained HTTP fallback exchanges a private, ten-minute single-use pairing invitation for an eight-hour local grant scoped to the launcher's Project allowlist. Explicit extension confirmation is required; authenticated revocation, expiry and daemon restart invalidate access. Host/Origin/CORS, request validation and Project scope are independent checks; localhost alone is not trusted. The page never receives pairing material. The current conversation's new completed assistant turn is inspected for explicit `VEYRA_HANDOFF_BEGIN/END` and `VEYRA_REVIEW_BEGIN/END` frames. Only bounded, validated engineering envelopes cross to the daemon. Results use `VEYRA_RESULT_BEGIN/END` with an explicit Reviewer instruction and exact result association. Review text never executes commands or satisfies a human approval gate. The formal P0.14 repair engine remains deferred.

The page adapter resolves the explicit `data-testid="conversation-turn-…"` container (observed as `section`) or the legacy `article`, then requires the normal completion toolbar inside that same turn. A generic parent or a sibling's toolbar is not completion evidence. Planner instructions show a complete canonical example: `context.currentTask` is a plan task ID string, decisions are structured objects, and verification requests belong beside `context`. The existing Protocol validator remains authoritative; bridge-specific error hints do not coerce malformed planner data into execution.

### Review persistence and independent outcomes

`ProjectReview` remains the canonical model: `projectId`, `runId`, `resultId`, optional `handoffId`, reviewer provenance, `verdict`, `summary`, `findings`, `nextAction` and evidence references. Legacy reviews/absent findings remain readable; the bridge retains the original uppercase verdict as `sourceVerdict`. The web adapter maps existing compact PASS/FAIL/HUMAN_DECISION objects to pass/fail/needs_input. Any supplied IDs must match the current binding's acknowledged result; omitted legacy IDs are supplied only from that exact result receipt, never from chat text or project names.

`reviews.submit` / `reviews.get` reuse typed daemon IPC and the Project-scoped `projectTool` API, including grant checks before and after operations. `ProjectHandoffStore` extends its existing immutable envelope archive with `<runId>.review.json` in `.veyra/handoffs/`. A per-run lock plus bounded, no-follow, atomic private writes makes identical submissions idempotent and rejects conflicting replacements. The latest `ProjectSharedState.review` mirrors that same envelope through revision-checked updates; a late historical review cannot replace another run's active context. `results.get` includes the matching archived review, including after coordinator restart. No separate UI JSON database is introduced.

The extension stores only a review receipt (IDs, timestamp and pending/submitting/recorded delivery phase) with its durable binding. It records intent before submitting, never resends an uncertain write, and reconciles through read-only `reviews.get` on restoration. The acknowledged result must belong to this exact tab/document/binding/conversation. Initial assistant IDs are excluded on reattachment; only new completed turns are read. Receipt changes notify open surfaces through existing storage events; Side Panel then fetches canonical Project evidence. This adds no periodic DOM scanning or idle network timer. HUMAN_DECISION pauses automatic work without granting approval; an explicit validated later handoff still uses the existing dispatch budget/gates.

Run presentation projects three distinct facts:

- **Execution** uses optional `executionStatus` in daemon run/result contracts, derived from actual lifecycle/agent events. A settled negative task finding may still have completed execution; cancellation, timeout, native errors, interruption and approval pauses remain distinct. Existing `status` retains its conservative aggregate semantics for compatible callers. Historical reports derive lifecycle from their Core run when available and do not invent missing proof.
- **Verification** comes only from actual requested checks/evidence: pending, running, passed, failed or incomplete. Missing/not-run evidence cannot be presented as a pass.
- **Review** comes only from a persisted review for this exact result: pending, approved, needs_changes or human_decision. No “reviewing” status is invented from a spinner or unstructured model prose. PASS is displayed as Approved, independently of verification failures.

### Native browser installation and lifecycle

`ve setup` registers `com.veyraoss.bridge` in user-level Chrome/Chromium host manifests (macOS/Linux). Only `chrome-extension://meibodpmcjcjdpfaaejdpiclijnpcclh/` is allowed. The host independently checks Chrome's origin argument before accessing installation state. It reads/writes bounded length-prefixed UTF-8 JSON on stdio; stdout contains no CLI text. A private installation identity and expiring Project ID/root grants live under the selected registry's `browser/`; explicit Bind grants engineering-state access for that Project, with revocation/identity rotation via `ve setup --revoke`. Registry names/locations and readiness are metadata-only discovery. No browser/native account credentials are stored.

The host is a CLI composition surface, not a second executor. The coordinator starts in a separate process; disconnecting Chrome cannot terminate active Codex runs. An opt-in one-shot 60-second idle deadline only runs when no operations/admitted runs remain. Foreground `ve daemon start` keeps its diagnostic behavior. The extension closes an idle native port after five seconds and reconnects on the next action. There are no periodic keepalives or idle DOM scans.

Finder-launched Chrome may lack the proxy environment used by a terminal. Before starting the native service, the macOS host can read enabled static HTTP/HTTPS proxy addresses from a bounded `/usr/sbin/scutil --proxy` probe and pass them to its own child processes. Explicit proxy environment choices take precedence, including an empty override or `NO_PROXY=*`. Automatically derived proxies retain loopback/system bypass entries. The host never evaluates PAC, retrieves proxy credentials, writes shell/system/Codex configuration or exposes these settings to the page. Other platforms retain their existing environment. This is native-launch composition in `apps/cli`, not browser or provider logic in the daemon.

A lost worker cache is not a disconnected state: the first requested snapshot after worker eviction revalidates local connectivity, bound installation/Project identity and readiness once, then resumes cached event-driven snapshots. This accounts for Chrome's documented [worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle). A dropped native handshake or allowlisted evidence read may recover once after a 200ms delay; a repeated read requires the same installation identity. Invalid replies, authorization failures and timeouts are not silently retried. Dispatch, cancellation, grants and other mutations are never replayed after a lost response. The conversation observer also recognizes streaming attributes removed from reused controls, while retaining the completion toolbar, quiet period, schema and exact-conversation checks.

Extension local storage holds at most 50 explicit conversation bindings (Project ID/root, installation ID, leases and phase); result/handoff bodies remain in `.veyra/`. A same-conversation restore validates installation, Project root, grant/readiness and current tab/epoch. Ambiguous dispatch/bootstrap/delivery intents pause. An unclaimed result can be reloaded from Project evidence. Pause persists; Unbind deletes local routing immediately and requests cancellation of active work. Only one tab owns a live binding; changing conversations cannot reroute a pending result. Machine blocks fold reversibly after confirmed delivery/accepted dispatch without changing protocol or durable evidence.

Explicit Bind/Resume may recover a missing main-frame content receiver once. The background revalidates the active tab and canonical conversation, probes only URL/document identity in the isolated world, and uses Chrome's [document-scoped script injection](https://developer.chrome.com/docs/extensions/reference/api/scripting#type-InjectionTarget) and [document-targeted message](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-sendMessage) APIs. An isolated, short-lived conversation target also rejects same-document SPA navigation. Only the read-only `prepare` handshake is repeated; `arm`, dispatch, delivery and other page messages never trigger injection or replay. Invalid replies, permission errors and a second missing receiver fail closed. A per-document isolated-world lifetime prevents duplicate listeners/observers and disposes invalidated runtimes; recovery injection cannot automatically restore or send messages before the explicit handshake. Failed preparation preserves a user pause. This does not introduce a periodic page probe, scan unrelated tabs/history or change Project/Daemon/Protocol authority.

### Native Codex

Codex is P0's executor through the installed native client/CLI and its normal existing ChatGPT authentication.

Veyra may store safe project/session references where supported, but never copies native credentials.

The trusted native execution composition supplies a 15-minute invocation ceiling, matching the Codex adapter's bounded default. The daemon's generic fallback remains two minutes; explicit command checks retain their own deadlines and default to two minutes. Core applies the stricter step/composition limit and preserves cancellation/cleanup. Neither a browser handoff nor IPC request can change the execution ceiling. A connectivity failure is not a reason to replay an interrupted task or bypass human decisions.

Native Project verification is an acyclic evidence sequence: a settled executor failure or ordinary check failure can continue into the next requested, locally configured check. Each check runs at most once; it does not repair or re-invoke the agent. Cancellation, timeout, needs-input, cleanup failures and explicit workflow stop/approval policies still terminate or pause execution. A failed last executor or any failed/missing required check keeps the Project result failed, even when the final workflow node succeeds. Exact local check commands are supplied as executor guidance; `commandsRun` and native command logs remain execution claims, while only persisted Verifier events supply verification status and evidence.

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
9. **Surfaces** — ChatGPT Side Panel/bridge, Local Control Center and CLI; TUI is deferred.

## Repository boundaries

Current repository plus P0 target additions:

```text
apps/
  cli/             setup/init/open/doctor and automation (`ve`)
  tui/             retained scaffold; deferred/optional
  dashboard/       local React/Vite Control Center; development fixtures stay isolated
  chatgpt-bridge/  retained future official Full MCP surface
  chatgpt-extension/  experimental Chrome/Chromium proof for ChatGPT Pro (P0)

packages/
  ui/              shared GUI tokens/components/icons/motion, no orchestration
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

ChatGPT Side Panel/bridge, Local Control Center and CLI render Project state and issue typed commands. They must not reimplement Core or provider logic. `packages/ui` owns semantic light/dark tokens, accessible controls, restrained motion and evidence presentation shared by the two GUI surfaces. It must not depend on browser conversation DOM, native authentication or execution. Browser DOM stays in `apps/chatgpt-extension`. The local GUI server is composed under `apps/cli`: `ve open` or scoped Native Messaging opens a one-use local invitation, exchanged for a short-lived HttpOnly/SameSite session plus CSRF protection. Exact Host/Origin, installation/grant revocation and Project root checks protect the common Project tool API. Only evidence reads and cancellation of an existing run are available; it does not grant dispatch, shell/file or approval authority. `runs.list` reads existing Core/handoff stores, returning bounded native run summaries. File-system notifications batch meaningful state changes into SSE; no token stream repaint or idle polling is introduced. Hidden pages close subscriptions; a separate GUI idle shutdown never cancels active coordinator work. The Control Center uses local authenticated access; `ve open` must not expose an unauthenticated localhost control API.

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

GUI productization precedes the pending real P0.12 re-test by the latest explicit user decision; it does not substitute for real P0.13 evidence. Stop for the first user visual review after GUI-6 verification/commit/push. TUI is deferred; GUI work does not depend on it.

The existing [remote-control design](REMOTE-CONTROL-DESIGN.md) remains documentation only. Remote/cloud execution still requires an explicit later product decision; P0 is local-first.
