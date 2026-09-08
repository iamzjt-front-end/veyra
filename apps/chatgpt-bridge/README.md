# ChatGPT MCP Bridge proof (P0.12)

Private, replaceable adapter from the official ChatGPT web MCP surface to the existing local Veyra daemon. It uses the user's native Codex login through the daemon's Project executor binding. No `OPENAI_API_KEY`, native credential copy, chat-history reader, custom UI, or public package is needed.

**Acceptance status: local MCP tests only; real ChatGPT installation and end-to-end acceptance are still pending.** An SDK test client is not evidence of a real ChatGPT conversation. See [the selected bridge decision](../../docs/ADR-001-CHATGPT-BRIDGE.md) and [P0.12](../../docs/TODO.md#p012--implement-the-selected-chatgpt-bridge-proof).

## Local preparation

Use a disposable Project for the first connection. From a clean checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @veyraoss/chatgpt-bridge test
pnpm ve doctor --json
```

The native Codex CLI must already be installed and logged in normally. `ve doctor` reports native readiness without requiring an API key. Veyra does not initiate login or read auth files.

Create/register a disposable local folder and record the returned Project UUID. These commands run from the repository; replace the example path and UUID with the actual fixture path/ID:

```sh
pnpm ve project add /absolute/path/to/disposable-project --json
pnpm ve project bind <project-uuid> --executor codex/native --json
```

If Codex is not on PATH, add `--codex-executable /absolute/path/to/codex` to the bind command. Configure trusted test/build/diff command IDs in the Project's `veyra.yaml` and `checks.yaml` using [the native verification example](../../docs/NATIVE-DISPATCH.md#project-owned-checks-for-native-dispatch). No API agents are required. ChatGPT chooses existing check IDs; it cannot send commands or override the local approval policy.

Start the normal daemon in one terminal and the bridge in another:

```sh
pnpm ve daemon start
pnpm --filter @veyraoss/chatgpt-bridge start --project <project-uuid>
```

For an isolated registry, pass the same `--registry /absolute/private/registry` to the project, daemon and bridge commands. Its canonical directory must be owned by you with mode `0700`. The bridge accepts one to eight repeated `--project` UUIDs. `--port 3180` is the default; `--port 0` selects a free loopback port for local testing.

The startup JSON reports `localUrl`, `mcpUrl`, allowed Project IDs and a private `pairingFile` path. It never prints the pairing secret. The file has mode `0600` and is deleted on normal stop. Read its contents locally only when completing the OAuth form; do not paste the code into a chat, handoff, issue, or log. It is bridge-owned pairing material, not a Codex credential.

## User installation boundary

The bridge always listens on `127.0.0.1`. Localhost by itself is not assumed reachable from ChatGPT. Before the next steps, the user must explicitly approve the temporary HTTPS forwarding route and installation/account linking. The application does not install a forwarder, start a tunnel, or expose a LAN/public listener automatically.

After authorization, use a user-approved development HTTPS forwarder to this loopback port. Restart the bridge with that exact origin so OAuth discovery and resource binding agree:

```sh
pnpm --filter @veyraoss/chatgpt-bridge start \
  --project <project-uuid> \
  --public-url https://your-approved-development-endpoint.example
```

`--public-url` configures metadata and the Host allowlist only; it does not open forwarding. The endpoint must preserve paths, query strings, HTTP request/response bodies and authorization headers. It forwards the bridge, never the daemon's Unix socket. No production hosting or publication is part of this proof.

The proposed temporary route, subject to user approval, is Cloudflare Quick Tunnel: install `cloudflared`, then run `cloudflared tunnel --url http://127.0.0.1:3180` and use its generated HTTPS origin above. Cloudflare documents this as an account-free development route without an uptime guarantee or SSE support. This bridge uses JSON responses over Streamable HTTP, with bounded polling rather than SSE; compatibility is a design inference until the real forwarded ChatGPT run passes. Its OAuth-protected endpoint becomes publicly reachable through Cloudflare for the lifetime of the tunnel, and authorized Project data passes through that provider. No tunnel has been installed or started. [Quick Tunnel documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)

In an eligible **ChatGPT web** account/workspace:

1. Enable Developer mode under Settings → Security and login, subject to workspace policy.
2. Create a private MCP app/connection using `https://your-approved-development-endpoint.example/mcp` and OAuth authentication. Leave credentials/API keys unset; this is a public PKCE client with dynamic registration.
3. Complete the bridge's authorization page using the pairing code from the local private file, only for the connection you are installing. This grants read/write access to the locally selected Project allowlist.
4. Enable that app in the intended ChatGPT conversation. Honour ChatGPT's write confirmations. Refresh the connection after changing tool schemas.

Official documentation checked 2026-09-09: [Developer mode](https://developers.openai.com/api/docs/guides/developer-mode), [connecting/testing MCP apps](https://developers.openai.com/plugins/deploy/connect-chatgpt), [OAuth authentication](https://developers.openai.com/plugins/build/auth). Account/admin entitlement and real confirmation behavior still need to be observed. The official Secure MCP Tunnel is optional because its runtime API key would introduce a prerequisite that this proof avoids.

## Same-conversation acceptance

Ask ChatGPT to implement a small, objectively testable change in the disposable Project. It should perform this sequence itself:

| Tool             | Purpose                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `veyra_projects` | Choose from explicitly allowed Projects and inspect daemon availability.                                                                                 |
| `veyra_project`  | Read that Project's bounded shared engineering state, native readiness and existing check IDs.                                                           |
| `veyra_dispatch` | Send one canonical version-1 handoff with matching Project UUID and a fresh run UUID.                                                                    |
| `veyra_run`      | Wait up to 25 seconds per call; repeat for the same run while running, then review structured results and actual Verifier evidence in this conversation. |
| `veyra_cancel`   | Stop that scoped run when the user requests cancellation.                                                                                                |

The handoff schema is advertised by MCP and revalidated by `@veyraoss/protocol`. It contains goal/plan/criteria/constraints, bounded provenance, relative file/artifact references and optional named verification requests. See [Handoff interchange](../../docs/HANDOFF.md). It cannot contain shell commands, credentials, approval decisions or alternate project roots.

The response contains both model-visible `structuredContent` and equivalent text. Verifier stdout/stderr, exit codes and event references come from persisted Core events for that Project/run. Evidence is bounded and redacted; truncation is explicit. Executor success claims cannot substitute for deterministic verification or ChatGPT review. Missing configuration, login, Project or daemon readiness is returned as state/error, not an API-key request. A paused run instructs local human action; the bridge has no approval-granting tool.

Record the actual ChatGPT surface/plan, connection date, native CLI version, Project/run IDs, local tool sequence, confirmation behavior and success/failure evidence. Confirm that the same real conversation submits the handoff and receives the native result with **no manual message copy in either direction**. Only then may P0.12 be checked off. The full review/fix loop and stable product demo belong to later TODOs.

## Proof limitations and shutdown

- OAuth uses the official MCP SDK's authorization-code/S256 PKCE flow, exact ChatGPT callback allowlist, exact resource binding and bridge-owned opaque tokens. The single-user pairing provider authorizes only the configured Project allowlist; it is not a production identity service.
- OAuth client registrations/grants are process-local (maximum 16 clients, 16 pending grants, 32 access tokens). Approval requests expire after 3 minutes, codes after 1 minute and access tokens after 1 hour. There is no refresh token. Expiry requires reauthorization; restarting loses registration state and requires recreating/relinking the ChatGPT connection.
- Tokens and pairing material are never read from native clients. Known secret values/patterns are redacted from results; this is not a claim to discover every possible secret in arbitrary project text. Authorize only a disposable or otherwise appropriate Project.
- MCP requests are stateless and authenticated, with default 100 KiB JSON input limits, eight concurrent MCP operations, bounded waits and bounded result output. No general file reader, shell executor, chat collector or approval bypass is exposed.
- Results return through tool calls in the active conversation. The server cannot inject a message into a closed conversation or force an idle ChatGPT turn to continue. Project Shared State remains the recovery source.
- Ctrl-C stops the bridge, closes its connections, invalidates its grants and removes its own pairing file. It does **not** cancel daemon jobs. Cancel a selected run before shutdown if desired, stop any user-authorized HTTPS forwarder, then stop the owned daemon. An uncatchable crash may leave an obsolete private pairing file; its code cannot authorize a restarted bridge.

No forwarder installation, account linking or real ChatGPT acceptance has been performed by the automated tests.
