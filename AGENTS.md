# AGENTS.md — Veyra contributor instructions

This file defines coding-agent rules. Read [`PRODUCT.md`](PRODUCT.md) first for product intent, [`docs/UX-FLOW.md`](docs/UX-FLOW.md) and [`docs/DESIGN.md`](docs/DESIGN.md) for GUI/UX, then [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for stable boundaries and [`docs/TODO.md`](docs/TODO.md) for canonical execution order. [`docs/ROADMAP.md`](docs/ROADMAP.md) is only a milestone summary.

## Product intent

Veyra is a **project-centered control plane for the AI tools a developer already uses**.

The first product proof is deliberately narrow:

```text
ChatGPT planner/reviewer
        ↓
Veyra Project + Bridge + Daemon
        ↓
Codex Native executor
        ↓
Verifier / shared project state
        ↓
ChatGPT review / repair / next plan
```

The user should not have to copy messages between ChatGPT and Codex. The core path must not require `OPENAI_API_KEY`.

API providers and additional agents remain supported infrastructure, but they are optional until the native GPT ↔ Codex loop is proven.

Current P0.12 for **ChatGPT Pro** uses the replaceable **Experimental Browser Bridge** in `apps/chatgpt-extension`, Chrome/Chromium + `chatgpt.com` only. Keep all DOM/composer logic there. It connects directly to the local daemon with explicit, expiring, revocable Project-scoped pairing and an explicit current-conversation binding. Require validated `VEYRA_HANDOFF_BEGIN/END` framing before dispatch; return labelled `VEYRA_RESULT_BEGIN/END` evidence to the same conversation. Do not read full ChatGPT history or credentials. Native Codex uses its existing login; Project `.veyra/` remains the shared-state authority.

Retain `apps/chatgpt-bridge` as the **preferred future official Full MCP production path**; do not conflate tunnel reachability with Pro write/action permission. No Cloudflare, ngrok, public server or API-key prerequisite in P0. Complete deterministic Stage A before requesting user installation/authorization and real Pro Stage B acceptance. Do not mark P0.12 complete or start dependent P0.13–P0.15 on fixture evidence alone.

## Product-first rules

1. **Project is first-class.** A Veyra Project maps to a real local folder and owns its `.veyra/` shared state.
2. **Shared engineering state is the integration contract.** Do not make cross-agent coordination depend on scraping full ChatGPT/Codex histories.
3. **Native-auth-first.** Prefer an already-authenticated native client/session when available. API-key integrations are optional, explicit choices.
4. **P0 is ChatGPT + Codex.** Do not expand provider/model work if it delays the first real ChatGPT → Codex → ChatGPT loop.
5. **No API-key gate for the golden path.** Missing `OPENAI_API_KEY` must not block native Codex project dispatch, the ChatGPT bridge proof or the GUI.
6. **Bridge code is replaceable.** Prefer official supported ChatGPT integration. Browser/UI automation, if used for a proof, must be isolated and clearly experimental.
7. **No unrelated conversation harvesting.** A bridge may operate on the explicitly selected/current project workflow but must not silently collect other conversations/history.
8. **Human authority remains.** Publication, release, deployment and destructive/security-sensitive actions stay approval-gated.

## Product interaction

Follow **Setup once. Bind once. Then just talk.** The experimental Chrome bridge defaults to Native Messaging: `ve setup` installs its local host and persistent installation identity; `ve init` registers the current Project and native Codex executor. The host lazily starts the coordinator; active runs prevent idle shutdown. Keep stdio host/installation code in `apps/cli` and all DOM/composer behavior in `apps/chatgpt-extension`. Reuse the daemon's transport-neutral Project evidence API and preserve the HTTP fallback.

Veyra is GUI-first: Chrome Side Panel is the primary daily surface, Local Control Center is the secondary surface, and CLI supplies setup/init/open/doctor infrastructure. The current simplified popup is interim; the planned popup is only a launcher/status/Diagnostics shortcut. Preserve `apps/tui` as deferred/optional, with no P0/P1 work. Implement the GUI phases in TODO after real P0.12 proof; do not claim shared `packages/ui`, Side Panel or Control Center already exists.

Primary GUI state is Ready/Working/Needs attention, Project, workflow/run and Bind/Pause/Unbind. Ports, IDs, pairing and raw evidence belong in Diagnostics. Shared UI tokens/components must support light/dark, keyboard focus and reduced motion; no idle animation, periodic DOM scan or invented progress/review results. Only explicit conversation→Project routing metadata may persist in extension storage; Project `.veyra/` remains engineering memory. Never replay an unconfirmed dispatch/delivery after refresh. Real Pro re-acceptance remains required; deterministic native-host fixtures do not complete P0.12.

## Stable architecture

The repository keeps explicit package boundaries even when some modules are still planned. Do not collapse them because a feature is not implemented yet.

### Package ownership

Existing packages:

- `packages/core` — orchestration and run coordination only.
- `packages/workflow` — workflow graph, DSL, transitions, retries, branching, gates.
- `packages/runtime` — agent/process execution lifecycle, cancellation, timeouts, working directories, streams.
- `packages/verifier` — deterministic verification such as shell, tests, lint, typecheck, build, benchmark.
- `packages/protocol` — provider-neutral contracts and shared event/result types.
- `packages/config` — config loading, parsing, validation, defaults.
- `packages/sdk` — public extension surface for third-party providers/nodes/tools.
- `plugins/*` — provider-specific adapters.
- `apps/*` — user interfaces/bridge surfaces only; business logic belongs in packages.

P0 adds these target responsibilities (see Architecture/TODO before choosing exact files):

- `packages/project` — Project identity, project-owned shared-state model and global project registry.
- `packages/daemon` — local coordinator lifecycle and typed local IPC/tool API.
- an isolated ChatGPT bridge surface under `apps/*` once P0.11 selects the integration path.

Do not create a new package merely to satisfy this list if a TODO proves a cleaner boundary; any boundary change must preserve the responsibility model and be documented.

## Architectural rules

1. `packages/core` must not depend on a specific model vendor.
2. Provider-specific logic lives under `plugins/*`.
3. Shared agent/project contracts cross `@veyraoss/protocol` (and project-owned contracts as defined by P0) rather than importing surfaces into Core.
4. `packages/core` must not directly spawn Codex, Claude Code or other provider CLIs; process lifecycle belongs in `packages/runtime`.
5. Deterministic verification belongs in `packages/verifier` and is distinct from LLM review.
6. Workflows must remain declarative, bounded and resumable.
7. Human approval is a first-class workflow node, not a UI hack.
8. CLI, TUI, Dashboard and ChatGPT bridge must consume the same Project/Daemon/Core state/event contracts rather than reimplement orchestration.
9. Codex is the first executor but not a Core dependency.
10. ChatGPT is the first planning/review surface but not a persisted-chat-history dependency.
11. The product name is `Veyra`; the public executable is `ve`; config/state names such as `veyra.yaml` and `.veyra/` remain brand-owned.
12. Official npm packages use `@veyraoss/*`.
13. Do not copy, persist or log native provider credentials/session secrets.
14. Do not treat a fake/mocked bridge as proof of a real ChatGPT integration.

## Canonical implementation plan

`docs/TODO.md` is the live plan. The previous API-first plan is historical and must not be resumed as the default priority.

When implementing roadmap work:

1. Read `PRODUCT.md`, Architecture and TODO before coding.
2. Unless the user explicitly names a different task, take the first unchecked TODO whose dependencies are complete.
3. Work one TODO at a time, including its tests and acceptance evidence.
4. Implement only the minimum supporting changes needed for the current TODO.
5. Do not opportunistically add providers, model routing, Dashboard polish or unrelated refactors.
6. Mark TODO status truthfully only after required verification runs.
7. Continue automatically to the next eligible TODO unless a human-approval boundary or genuine blocker is reached.

## Current implementation target

The current target is **P0 — Project-centered GPT ↔ Codex Native Bridge**, not an API-provider smoke test.

The MVP gate is P0.13:

```text
real ChatGPT workflow
        ↓ structured handoff
local Veyra daemon + selected project
        ↓
already-authenticated native Codex
        ↓
real edits + deterministic verification
        ↓ structured result
same ChatGPT workflow reviews result
```

No manual copy/paste between ChatGPT and Codex. No OpenAI API key required for the golden path.

## Coding conventions

- TypeScript, strict mode.
- Prefer small explicit interfaces over framework-heavy abstractions.
- No hidden global state.
- Keep local/project state transparent and versioned.
- Preserve structured events so every surface can subscribe without coupling to engine internals.
- Prefer argv execution to shell-string construction where shell semantics are unnecessary.
- Keep authentication/readiness probes bounded and non-secret.
- Avoid LangChain/LangGraph unless a concrete accepted design requires them.
- Treat ChatGPT/Codex/provider outputs as untrusted input at boundaries.

## Before completing a task

Run task-specific checks from `docs/TODO.md` plus the repository baseline:

```bash
pnpm lint
pnpm format:check
pnpm check
pnpm test
pnpm build
```

If a command cannot run, record the exact blocker. Do not silently skip checks or claim a live integration passed when only mocks ran.
