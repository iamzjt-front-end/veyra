# Experimental ChatGPT Browser Bridge (P0.12)

Private Manifest V3 extension for **Chrome/Chromium + `https://chatgpt.com`**. It connects directly to the local Veyra daemon at `http://127.0.0.1:<port>`. No public server, Cloudflare, tunnel, API key, ChatGPT backend API or native credential access is involved. The existing [`apps/chatgpt-bridge`](../chatgpt-bridge/README.md) remains the future official Full MCP path; see the [Pro capability decision](../../docs/ADR-001-CHATGPT-BRIDGE.md).

**Experimental:** DOM selectors/composer behavior may change. Local simulated-browser tests do not complete the real ChatGPT acceptance gate. Installation and the first live account/project test require the user's involvement.

## Build and install locally

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @veyraoss/chatgpt-extension test
```

In Chrome/Chromium, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `apps/chatgpt-extension/dist` from this repository. The public manifest key fixes the unpacked extension ID to `meibodpmcjcjdpfaaejdpiclijnpcclh`; it is an identifier, not an authentication secret. No Web Store publication is performed.

Use a disposable Project for the first live test:

```sh
pnpm ve project add /absolute/path/to/disposable-project --json
pnpm ve project bind <project-uuid> --executor codex/native --json
pnpm ve doctor --json
pnpm ve daemon start --http-port 3181 \
  --http-origin chrome-extension://meibodpmcjcjdpfaaejdpiclijnpcclh \
  --http-project <project-uuid>
```

Use `--codex-executable /absolute/path/to/codex` when binding if Codex is not on PATH. It must already be logged in through its native client. The daemon does not read or copy native login files. Existing optional API provider config is not required. Configure named trusted test/build checks using the [native dispatch example](../../docs/NATIVE-DISPATCH.md#project-owned-checks-for-native-dispatch). The planner can select these check IDs; it cannot supply commands.

For a separate registry add the same `--registry /absolute/private/registry` to Project/daemon commands. The HTTP interface is off unless the port, exact extension origin and at least one Project UUID are all explicitly supplied. Repeat `--http-project` for at most eight Projects. The daemon listens only on `127.0.0.1` and prints a private **pairing file path**, never its secret.

Open an existing ChatGPT conversation (`/c/<uuid>`, including a conversation in a GPT/Project), then open the extension popup:

1. Import the daemon's JSON pairing file using the popup's file picker. To reach a hidden `.veyra` directory on macOS, use **Command–Shift–G** in the picker and enter the printed file path. Do not paste its contents into ChatGPT.
2. Click **Detect daemon / Refresh projects** and select a Project.
3. Set an execution limit from 1 to 5 (default 3, including the initial run and repairs). Empty the composer, remove attachments and wait until ChatGPT finishes generating.
4. Click **Bind current conversation and enable automatic execution**. This explicitly grants automatic processing of subsequent marked handoffs for this binding and sends bounded Project shared state, check IDs and a concrete handoff template into this conversation.

The extension processes **only new completed assistant blocks** labelled `veyra-handoff`, for example:

````text
```veyra-handoff
{
  "version": 1,
  "kind": "handoff",
  "id": "<the fresh run UUID from the extension template>",
  "projectId": "<the selected Project UUID>",
  "runId": "<the same fresh run UUID>",
  "provenance": {
    "role": "planner",
    "surface": "chatgpt-extension",
    "actor": "ChatGPT",
    "at": "<ISO timestamp from the template>",
    "contentTrust": "untrusted"
  },
  "context": { "goal": "Implement the requested feature", "constraints": [], "decisions": [] },
  "requestedVerification": [{ "id": "test", "kind": "test" }]
}
```
````

This example is explanatory; real identity/timestamp values are supplied automatically. See the canonical [handoff schema](../../docs/HANDOFF.md) for optional plan, acceptance criteria and references. Generic JSON, user messages, old blocks, multiple blocks, incomplete streaming responses, unknown fields and mismatched Project/run IDs cannot dispatch.

The daemon invokes the Project's native executor and actual Verifier. The extension waits and submits `veyra-result` to the **same conversation**, followed by the next fresh handoff identity when the bound allows another run. GPT can review or emit a repair handoff. No GPT/Codex text needs to be copied by the user. This transport capability does not mark the later P0.13/P0.14 real review/repair acceptance complete.

## Local state and failure behavior

- Pairing and binding data live only in `chrome.storage.session`, restricted to trusted extension contexts. The page/content script never receives the pairing secret. Browser restart clears the grant; daemon restart or eight-hour expiry requires importing a new file.
- Only one conversation is bound at a time. Navigating, reloading or closing its tab pauses automatic delivery. Project handoffs, results and run evidence remain in `.veyra/`; no full chat history is stored. Already-dispatched work may continue until explicitly cancelled or the daemon stops.
- **Stop automatic bridge / Cancel current run** disables new dispatch/handback before requesting daemon cancellation. It does not delete files. Failed cancellation is shown in the popup; inspect the run locally.
- A busy composer waits without overwriting the user's draft. An uncertain dispatch/submit is never automatically replayed. Confirmed delivery requires the message to appear in the current conversation, not merely a Send click. Inspect the conversation/Project before rebinding after uncertainty.
- Native/Project/daemon readiness and human-gated runs are shown explicitly. The extension cannot approve gates, publish packages, deploy, read arbitrary files or choose another executable.
- Result envelopes and artifact references retain their provenance. Verifier evidence is resolved from actual saved events, with bounded output and explicit truncation. Git patches are labelled **current workspace, including pre-existing changes**, with read time; they are not an immutable run-specific diff. Untracked files are listed, not read; parent repositories and `.veyra`/`.env*` content are excluded. Non-Git Projects report unavailable Git evidence. Use a trusted named diff Verifier for immutable run-specific evidence.
- Handoffs are at most 64 KiB, network replies 256 KiB, automatic result payloads 128 KiB. Oversized results pause rather than silently claim complete verification. Known secrets are redacted; this does not detect every possible secret in arbitrary source files. Choose an appropriate Project.

## Reproducible local browser fixture

```sh
pnpm --filter @veyraoss/chatgpt-extension exec playwright install chromium
pnpm --filter @veyraoss/chatgpt-extension smoke:browser
```

An already-installed compatible Chromium can be selected with `CHROMIUM_EXECUTABLE=/absolute/path/to/chromium`. The script loads the actual unpacked extension in a disposable profile, intercepts `chatgpt.com` with a local DOM fixture, and permits no public requests. A fake executor edits a disposable Project; the real daemon and Verifier fail once, then pass after the fixture emits a repair handoff. It asserts exactly two automatic same-conversation result submissions and removes the owned browser/daemon/profile afterward. It neither signs into ChatGPT nor proves a real native login.

The live gate still requires the user's real Pro conversation and installed native Codex: record Chrome/Chromium and native versions, Project/run IDs, the automatically delivered failed/passed evidence, and current-conversation review. Do not mark P0.12 complete based only on this fixture.
