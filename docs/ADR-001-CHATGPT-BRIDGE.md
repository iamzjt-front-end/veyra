# ADR 001: Official MCP for the P0 ChatGPT bridge

Status: accepted for implementation; real account/connection proof belongs to P0.12.
Evidence checked: 2026-09-09. Depends on the passing P0.10 native dispatch gate.

## Decision

Use ChatGPT **web Developer mode with a data-only MCP server**, isolated in a private `apps/chatgpt-bridge` workspace. Keep the Veyra daemon on its private Unix socket. The bridge binds loopback only; an explicitly approved development HTTPS forwarder connects ChatGPT to it. Use OAuth authorization for private Project data and dispatch. Do not publish a plugin, open unauthenticated remote write tools, or require an OpenAI API key.

Official capability meets the proposed P0 interaction, so browser extension/desktop automation is not selected or authorized as a workaround. Account availability and actual behavior must still be proven before P0.12 is marked complete.

## Evidence and applicability

| Question                             | Finding and consequence                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target plans/surface                 | Official Developer mode documentation lists Plus, Pro, Business, Enterprise and Education on the web. It enables read/write MCP tools; write calls normally need confirmation, with a per-conversation remembered choice available. Veyra must honour host confirmation and workspace policy. The user's exact target plan/admin entitlement is not yet verified; desktop/mobile parity is not assumed. [Developer mode](https://developers.openai.com/api/docs/guides/developer-mode) |
| Current conversation and return path | Tool `structuredContent` and `content` enter the conversation and are visible to the model. A tool can return a run ID, and subsequent calls can wait/read that run. No full-chat read permission or external message injection is needed. This supports the design; it is not a claim that an installed real conversation has passed. [Tool results](https://developers.openai.com/plugins/reference#tool-results)                                                                    |
| Local connectivity                   | ChatGPT needs a reachable HTTPS MCP endpoint or Secure MCP Tunnel. A development HTTPS forwarder is explicitly supported for testing. Localhost alone is useful for an MCP test client, but is not assumed reachable from ChatGPT's cloud. User installation/connection and forwarding approval are required. [Connection testing](https://developers.openai.com/plugins/deploy/connect-chatgpt)                                                                                       |
| Official private tunnel              | Secure MCP Tunnel provides outbound-only access but requires a Platform tunnel identity, permissions and a runtime API key. It is an optional future transport, not the P0 baseline. [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)                                                                                                                                                                                                             |
| Auth                                 | Private data/write tools should authenticate the user. MCP OAuth uses discovery, resource-bound tokens, authorization code + S256 PKCE, and registered/allowlisted redirects. Bridge authorization is separate from native Codex login; neither grants ChatGPT history access. [Authentication](https://developers.openai.com/plugins/build/auth)                                                                                                                                      |
| UI and maintenance                   | Official MCP tooling supports schema-defined tools and model-readable results without custom UI. This avoids dependence on browser DOM selectors or accessibility layouts. Tool metadata/schema changes still need connection refresh and regression prompts. [MCP server guide](https://developers.openai.com/plugins/build/mcp-server)                                                                                                                                               |

## P0.12 implementation boundary

The bridge adapts existing Project/daemon/protocol contracts. It must not run Codex directly or add workflow business logic to the UI layer. Start with these operations:

1. List only locally authorized Projects and show daemon readiness.
2. Read the selected Project's bounded Shared State, executor binding and available local check IDs.
3. Submit the canonical handoff to `runs.dispatch` with explicit Project/run identity.
4. Wait for that run and return its structured result plus bounded, resolved Verifier evidence.
5. Cancel the selected run.

Every call checks the local Project allowlist; no generic file reader, shell executor, approval-granting tool, native credential/history endpoint or arbitrary chat reader is exposed. The model supplies validated task data and chooses existing checks, never transport credentials or executable definitions. Dispatch/cancel annotations must reflect writes. Native sandbox and Veyra human gates remain effective. Paused/gated work returns a clear state for local human action.

Use the official TypeScript MCP SDK and existing package conventions. Start with local single-user proof: OAuth pairing requires an explicit local grant, authorizes only configured Projects, uses short-lived bridge-owned tokens, and cannot reuse Codex credentials. An HTTPS forwarder must not expose unauthenticated Project data or permit broad network binding. Public forwarding, account linking and tool confirmation are the user's final installation boundary after the implementation is testable locally. No production authorization service or public distribution is claimed by this proof.

`runs.dispatch` returns promptly; bounded waits fetch persisted completion in the same active ChatGPT tool workflow. A stopped model turn or closed conversation is not a supported server-push channel. P0.12 must test the real tool sequence rather than infer unlimited background autonomy. Project Shared State remains the recovery source.

## Alternatives and platform boundaries

An extension/content script would require explicit installation, narrowly scoped access to the selected conversation and a replaceable experimental package. It has higher maintenance risk and would need a new decision about applicable platform rules. Desktop UI automation adds accessibility permission and layout sensitivity. Neither is justified while the official path is available. No approach may bypass entitlement, login, write confirmations, or harvest unrelated chats. The selected documented developer-mode testing path provides no evidence of a platform-rule conflict when these boundaries are respected; public distribution has additional requirements and is out of scope.

## Acceptance still required

Local MCP client tests must cover schemas, authorization/Project boundaries, missing readiness, duplicate run handling, waits/cancellation and real Verifier evidence. Then the user must enable/install the connection in an eligible ChatGPT web workspace and approve its scoped tools/forwarding. A real ChatGPT conversation must dispatch to the already-authenticated native Codex and receive the result without copied messages. Record host/client versions, confirmation behavior and both success/failure outcomes. Until that evidence exists, P0.12–P0.15 remain incomplete.
