# ADR 001: Experimental Browser Bridge for ChatGPT Pro; future Full MCP

Status: amended by explicit product decision on 2026-09-09. P0.11 is complete; real ChatGPT acceptance remains a P0.12 gate.
Evidence rechecked: 2026-09-09. Target account: ChatGPT Pro, confirmed by the user.

## Decision

Implement P0.12 in independent `apps/chatgpt-extension/`: an **Experimental Browser Bridge**, initially Chrome/Chromium and `https://chatgpt.com` only. It connects from its extension service worker directly to the optional authenticated Veyra daemon transport at `http://127.0.0.1:<port>`. No cloudflared, temporary HTTPS tunnel, public server or `OPENAI_API_KEY` is used. All DOM inspection/composer interaction stays inside this app.

Retain `apps/chatgpt-bridge` and its OAuth/MCP implementation and tests as the **future official Full MCP path**. Official supported integration remains the long-term preference, subject to verified account entitlement. Network reachability is not write authorization. Do not disguise dispatch/cancel as read/fetch tools to bypass plan limitations.

## Official capability evidence and discrepancy

| Source checked                                                                                                                                                                                                               | Evidence and consequence                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [OpenAI Help Center: Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt), Availability and FAQ “Are apps and full MCP beta available to Pro users?” | The plan-specific article explicitly limits Pro custom MCP connections to read/fetch and lists Business, Enterprise and Edu for full MCP including write/modify actions. Its displayed update age was 18 days when checked. Use this specific entitlement statement for the current Pro product decision. |
| [OpenAI Developer mode guide](https://developers.openai.com/api/docs/guides/developer-mode), What is / Eligibility                                                                                                           | This page describes read/write MCP support and lists Pro, Plus, Business, Enterprise and Education together. It also documents write confirmations. This conflicts with the Help Center's specific Pro restriction; Veyra records the discrepancy rather than claiming verified Pro write support.        |
| [Connect from ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt) and the Help Center's local-server FAQ                                                                                                  | Remote connection/transport support answers reachability, not plan entitlement, action permission or same-conversation delivery. A working tunnel or SDK client cannot prove the user's Pro account can invoke Veyra dispatch.                                                                            |
| [MCP tool results](https://developers.openai.com/plugins/reference#tool-results)                                                                                                                                             | Structured tool results are visible to the model in a supported tool workflow. This explains the future Full MCP handback design, not access to arbitrary conversations or background message injection.                                                                                                  |

The five required operations—binding, planner handoff submission, native dispatch, cancellation and automatic handback—include state-changing actions. Read/fetch-only access is insufficient. No real Pro MCP write trial is claimed. If official documentation or account capabilities change, re-evaluate the retained Full MCP path with an actual entitled account before changing this decision.

## Experimental browser boundary

- Manifest V3 content scripts run in an isolated world on `chatgpt.com` only. Network access is delegated to the extension service worker with only the loopback host permission. [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts), [cross-origin requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests).
- User installation, a daemon-issued process-local pairing secret, a local Project allowlist and an explicit current-conversation bind are required. Pairing material and bindings use extension session storage; no native credentials, cookies or ChatGPT authentication headers are read. [Chrome session storage](https://developer.chrome.com/docs/extensions/reference/api/storage).
- Only new, completed assistant code blocks explicitly labelled `veyra-handoff` are eligible. Canonical schema and Project identity are checked again before daemon dispatch. Existing messages, user messages, other conversations and streaming fragments are never task input.
- Binding is local and temporary. Navigation, tab closure, stop/unbind and browser restart must not route results into another conversation. Dispatch IDs are deduplicated and repairs have a user-visible bound; no guessed replay after an ambiguous response.
- Result delivery uses the current conversation's ordinary composer, only when empty and idle. Structured execution output remains untrusted data. No hidden ChatGPT backend API, full-history scraping, confirmation bypass or native login extraction is used.
- DOM selectors are experimental and may change. Failure must pause visibly, preserve Project evidence and require a deliberate retry/rebind where appropriate. This design is not an official OpenAI browser integration or a claim of platform approval.

## P0.12 implementation boundary

The bridge adapts existing Project/daemon/protocol contracts. It must not run Codex directly or add workflow business logic to the UI layer. Start with these operations:

1. List only locally authorized Projects and show daemon readiness.
2. Read the selected Project's bounded Shared State, executor binding and available local check IDs.
3. Submit the canonical handoff to `runs.dispatch` with explicit Project/run identity.
4. Wait for that run and return its structured result plus bounded, resolved Verifier evidence.
5. Cancel the selected run.

Every call checks the local Project allowlist; no generic file reader, shell executor, approval-granting tool, native credential/history endpoint or arbitrary chat reader is exposed. The model supplies validated task data and chooses existing checks, never transport credentials or executable definitions. Dispatch/cancel annotations must reflect writes. Native sandbox and Veyra human gates remain effective. Paused/gated work returns a clear state for local human action.

The daemon keeps provider-neutral HTTP transport, Project scoping, bounded responses and authentication; the CLI composes native readiness and trusted execution. The extension never supplies executable definitions or runs Codex itself. The existing MCP SDK/OAuth implementation remains isolated and available for future entitled Full MCP installations.

## Acceptance still required

Local tests must cover loopback Host/Origin/authentication/Project boundaries, schemas, streaming and duplicate suppression, current-conversation navigation, busy composers, cancellation, bounded repairs and actual Verifier evidence. Disposable browser fixtures are useful transport/DOM tests, **not proof of a real ChatGPT integration**.

After the reviewable unpacked extension is built, the user must install/authorize it in Chrome/Chromium and select a disposable registered Project in their real ChatGPT Pro conversation. Record browser/native versions and prove same-conversation handoff/result delivery without manual copying in both directions. No tunnel approval is needed or requested. P0.12 stays incomplete until this live evidence exists; P0.13–P0.15 remain dependent on that gate.
