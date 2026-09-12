# Existing Codex conversation binding

The Side Panel defaults to **选择 Codex 已有对话 → 绑定当前对话**. Search the task's title and check its directory. The Project folder follows that task automatically and is read-only; there is no second Project selection. A confirmed binding displays both the local Project and the Codex task title. A Project need not already be registered: explicit Bind initializes/registers the native task's exact folder, preserving existing user configuration. Nested folders inside another Veyra Project require an explicit matching root, rather than registering an unintended ancestor.

**高级：直接绑定本地项目** retains the separate Project-only flow using a Veyra-managed Codex session. Its Project selector and recent list are hidden by default. Entering or leaving this path clears the previous choice, so a hidden Project or native task cannot be bound by mistake. The loopback HTTP diagnostic fallback keeps direct Project selection; existing bindings and their `.veyra/` evidence are unchanged.

## Support boundary

The integration uses the official [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server): metadata listing/reading, exact-ID resume and turn submission. It does not use internal Codex desktop tool pipes or impersonate another task. It does not copy transcripts or credentials. The initial implementation uses an owned stdio app-server, with workspace-write sandboxing and human approval requests left unresolved for the user. It does not attach to the desktop app's private stdio connection.

On the installed `0.154.0-alpha.6.1` binary, the desktop can retain a native writer lock even when a task looks idle. A separate `thread/read` reports `notLoaded` for that task but `thread/resume` correctly refuses it with `already has an active writer`. Discovery does not imply availability. Current desktop installations may need to close before releasing their writer; Veyra does not stop the desktop, kill another task, force a takeover, fork, or create a replacement. This is a real native ownership limit, not an extension reconnect problem. No API key, tunnel or alternative provider is used to get around it.

## State and authorization

- Metadata-only discovery runs on explicit user actions, 30 entries per page with bounded search/cursor. Native `preview` and transcript fields are discarded; `useStateDbOnly` prevents metadata repair scans on the verified native version.
- The trusted extension UI alone can request selection. A content script cannot register a native task or enumerate tasks. The host re-reads the selected ID/title/root before initializing anything.
- Native grants retain up to 20 explicitly selected IDs per Project, are rooted, expire and can be revoked with the existing local authorization. Ordinary Project authorization renewal preserves the selected IDs. HTTP pairing cannot dispatch into existing native conversations.
- A binding saves only task ID/title/root, current ChatGPT URL, tab lease and existing receipts. New Veyra Run IDs retain the selected Codex ID; untrusted handoff text cannot change it.
- The daemon checks the target's current native directory. The native writer is acquired before appending one turn. Missing IDs, moved folders, writer conflicts, protocol failures and human-input requests never switch to a fresh session.
- Accepted execution and native session references are persisted with existing Project handoff/result/Verifier evidence. Ambiguous admission is not resent. Stdio cancellation terminates only Veyra's owned app-server/process group. The opt-in shared transport interrupts only a confirmed Veyra turn and never terminates the shared server.

## Verification on 2026-09-11

Native metadata discovery returned the exact requested task **确认旧代码已删除** (`01a07a2c-85ca-79e1-99e2-28f5b690498d`) and the `etf-quant-monitor` root. A metadata-only resume probe was refused by its active-writer lock. No task was submitted to that user project and no ETF source files were changed. This is **not** recorded as a completed user-conversation binding or execution.

An independent durable fixture at `~/Projects/veyra-proofs/existing-conversation-OzLwMh` verified:

1. The original native process exits. Two new Veyra runs, `b1095855-0cd2-418c-b46f-fe811e1908d2` and `7176dd68-3666-432f-9d50-55ece6c26431`, both continue native task `01a0910d-93c6-79c3-9f89-6e3ac9af051e`. Both recall a random marker supplied only in the earlier native turn. Safe references are archived in `.veyra/`; `acceptance.json` records the proof.
2. NativeService explicit selection/grant → daemon → the same native task → independent Verifier → persisted Result passed for Run `2a1b73bb-2081-46e0-9300-027facaee4f8`. `daemon-dispatch.json` contains the canonical result and verifier event reference. A different unapproved native ID and a duplicate dispatch were refused. `OPENAI_API_KEY` was absent in execution.
3. Deterministic tests cover exact-ID continuation across Runs, response/event races, foreign ID/root rejection, occupied tasks, human approval, cancellation, content-script authority denial, scoped grants, page navigation during Bind and refresh persistence. Discovery and idle popup tests add no timers or background list scan.
4. Chromium 149 rendered both Chinese/English task selection and selected-task states at 320–460 px without page errors. Screenshots: `output/playwright/gui/codex-task-picker-zh-CN.png` and `codex-task-selected-zh-CN.png` (UI fixtures, not real ChatGPT execution proof).

The existing-task browser fixture additionally drives the actual built Side Panel → `connectNative` → installed stdio host → coordinator → app-server protocol fixture. It checks two distinct Runs retain one native ID, with actual Verifier evidence and persisted reviews, plus refresh/worker/idle recovery. This complements the real native continuation above; it does not turn the simulated ChatGPT page into real-account proof.

The existing user installation points to `apps/chatgpt-extension/dist`, and its allowlisted native launcher points to `apps/cli/dist/native-host.js`. These paths remain fixed. Build identity is recorded in `dist/build-info.json`; the CLI's packaged extension must match it. Reload the installed extension after updating these generated assets. No repeated `ve setup`, manual registration, pairing JSON or API key is needed for an already installed native host.

Final gates completed on September 11–12, 2026:

- `pnpm lint`, `pnpm format:check`, `pnpm check`, `pnpm test` (2,213 tests) and `pnpm build` passed.
- Extension unit tests (198), `smoke:browser`, `smoke:native-browser`, `smoke:conversation-browser`, `smoke:startup` and `smoke:panel` passed.
- The existing-task browser fixture made exactly two executions and two confirmed returns to the same simulated conversation; both reviews persisted. The selected native ID was preserved after refresh and coordinator sleep. No new thread/fork occurred.
- With 3,000 old turns and 60 seconds idle, the existing-task fixture recorded **zero DOM queries**, 0.0672 seconds of page task time, and one inspection for a mutation burst. Normalization, draft, attachment, streaming and navigation regressions remained intact.
- Startup fault injection ran only on a temporary extension copy: ten real extension reloads, all three UI surfaces, delayed/missing storage and recovery. Historical error ID/count stayed unchanged; there were no new Chrome runtime errors.
- Installed-directory build identity: `4267e61d3fd940b9329cbb1a477441dd7c88047a13285d85e091c442f0a094f8`. Both extension distributions match; all eleven JS/CSS/HTML artifact hashes were checked.

The actual **确认旧代码已删除** task remains unbound pending release of its desktop writer. None of the gates above claims simultaneous desktop takeover or a real ChatGPT run in that user project.

Run the development proofs using:

```sh
node --import tsx plugins/codex/test/manual-conversation-smoke.ts /absolute/path/to/codex
node --import tsx apps/cli/test/manual-conversation-dispatch.ts /path/printed/by/the/previous/proof
```

These proofs create only isolated fixture work, not tasks in the user's selected project. The generic P0.12 reliability evidence remains separate. P0.13–P0.15 are still frozen.

## Task-first selector follow-up

The default selector now requires an existing Codex task, even if an earlier Project is remembered. Advanced direct-Project selection clears the native target, and returning to task selection clears the Project target. Both paths retain their existing authorization and execution contracts; no polling or engine changes were introduced.

Verification for this follow-up:

- `pnpm lint`, `pnpm format:check`, `pnpm check`, `pnpm test` (2,214 tests) and `pnpm build` passed; extension tests passed (199).
- `smoke:panel` passed in Chinese and English: read-only task-derived folder, no default Project dropdown/recent list, hidden-target refusal, explicit Advanced switching, keyboard return, no registered Project prerequisite, HTTP fallback and 320–460 px layouts. Screenshots remain in `output/playwright/gui/`.
- `smoke:conversation-browser` passed against the built extension in isolated Chromium: exactly two executions and two confirmed returns, one selected native task, persisted pass/fail reviews, extension reload, page refresh and coordinator idle recovery. The simulated ChatGPT/executor fixture does not prove a real-account loop or desktop writer takeover.
- With 3,000 old turns, 60 seconds idle produced zero DOM queries and 0.0472 seconds of page task time; a mutation burst caused one inspection. Fourteen normalization/safety cases passed.
- Current build identity: `456eed251dc4dd9f313cc56e469b0506853b078f4d43bd9750cb6efe265eb828`. The installed `apps/chatgpt-extension/dist` and CLI-packaged extension match, including all eleven artifact hashes. Reload the extension to activate the updated selector.

Logs: `output/playwright/acceptance/task-first-binding-2026-09-12/`. Native writer ownership limits and the outstanding real ChatGPT acceptance gate are unchanged.

## Shared local native service — experimental, September 12

The selected desktop task was confirmed idle/completed, while its writer lock was still held by the desktop's native process. Therefore a second stdio server cannot implement the intended simultaneous desktop + Veyra experience. Rebinding or clearing extension errors cannot release that ownership.

Veyra now supports an **explicitly configured private Unix WebSocket** using the public [app-server protocol](https://learn.chatgpt.com/docs/app-server). Both clients must connect to the **same** native service. This is a local experimental transport, not desktop private IPC, an MCP migration, an API-key provider or a public tunnel. The existing owned stdio path remains the default until the desktop migration is verified.

- `ve setup --codex-socket /absolute/private/codex.sock` persists the local choice in the existing private installation file. `ve setup --codex-stdio` reverses that choice. Normal setup/grant renewal preserves it. Setting a socket does not itself prove the desktop has joined it or a selected task is ready.
- Browser requests and handoffs cannot select a socket. The host reads trusted installation state on each request; the lazy coordinator re-reads it at execution admission. Active executions retain their original connection.
- Only a current-user-owned socket and private parent directory are accepted. TCP URLs, relative paths, symlink endpoints and unsafe permissions fail closed. No fallback process starts if this connection fails.
- Metadata/root and idle status are checked before resume and immediately before submission. A missing/unknown status is unavailable. A running task is not intentionally steered.
- Ownership is confirmed by the native turn ID and first user message's `clientId`, matching the Veyra Run ID. Other-client input or ambiguous admission stops observation without replay or takeover. Cancellation/timeout sends `turn/interrupt` only for that confirmed turn, then requires its terminal event; an interrupt response alone is insufficient. Unconfirmed stopping is reported explicitly and may require inspection in Codex.
- The native API's `turn/start` can steer an already-active turn and has no atomic “start only if idle” option on this verified version. The idle check does **not** guarantee an atomic exclusion of a simultaneous desktop send. Detected races fail closed; simultaneous manual desktop input and automatic Veyra dispatch into one task remain unsupported. Do not claim safe concurrent editing from the two-client proof.
- Resume does not overwrite shared task settings. A Veyra turn explicitly requests workspace-write sandboxing for the bound directory, disabled network access and on-request approval. Native approval requests are never answered automatically. Those native turn policies can remain sticky for subsequent desktop turns.
- There is no reconnection loop or idle polling. Connections exist for a bounded request/active execution, with an operation deadline and bounded cancellation confirmation; otherwise they close. Browser scanning/timers and shared execution protocols are unchanged.

### Verified native evidence

Native `0.154.0-alpha.6.1`, existing login, no `OPENAI_API_KEY`; durable fixture `~/Projects/veyra-proofs/shared-adapter-TiAQyj`:

| Check                                                                                                          | Evidence                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same task with two independent clients; Veyra reconnects between turns                                         | Native task `01a093b7-d3bb-7e52-8641-9e2f6b9f8762`; Runs `e192cac8-7eaf-4229-8849-5960cf0c6f63`, `579ffad3-cc46-49be-a680-aebe68db8be6`; both completed and the other client received both results |
| Actual Veyra cancellation                                                                                      | Run `90fb4887-44e6-4a37-8774-f8f224cfd19d`; native idle confirmed, other client still connected                                                                                                    |
| Already-running task                                                                                           | Dispatch refused; only the fixture owner interrupted its own task                                                                                                                                  |
| NativeService authorization → coordinator → exact shared native task → independent Verifier → persisted Result | Run `8c4dc237-4e25-48e3-a2a4-817f23616478`; Verifier evidence persisted; duplicate dispatch refused; observer connection remained usable                                                           |

`shared-adapter-evidence.json`, `round-0.json`, `round-1.json`, `cancel.json`, `shared-dispatch-evidence.json` and `shared-dispatch-result.json` record the outcomes. `.veyra/` contains the normal handoff, execution/session and verifier evidence. The fixture owns an isolated Registry, socket and server; its processes were stopped. No turn was submitted to `etf-quant-monitor` and no user project source was changed. An earlier standalone transport probe also completed two native turns in `shared-native-bx6nND`; these are native proofs, **not** real ChatGPT acceptance.

Reproduce with explicit development commands:

```sh
pnpm exec tsx plugins/codex/test/manual-shared-conversation.ts /durable/proof-parent /absolute/path/to/codex
pnpm exec tsx apps/cli/test/manual-shared-dispatch.ts /passed/shared-adapter-fixture /absolute/path/to/codex
```

### Remaining desktop migration gate

Further inspection of desktop `26.908.31457` corrected the earlier migration proposal: **setting `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1` alone is insufficient on this build**. That branch requires empty configuration overrides, while the desktop always supplies its local plugin override. Restarting normally therefore still launches a separate stdio server. Do not ask the user to repeat that restart as a fix.

The installed code also accepts `CODEX_APP_SERVER_WS_URL` before selecting stdio. Its bundled WebSocket client accepts a Unix URL. A read-only probe with `ws+unix://localhost/absolute/private/socket:/rpc` completed the public native handshake and `thread/read` for the exact selected task/root against a fresh owned socket server, with `includeTurns: false`, zero turn submissions and no desktop changes. The `localhost` hostname matters on this build: its connection helper otherwise selects a SOCKS proxy. The probe's process/socket were stopped and removed. `desktop-url-proof.json` and `desktop-restart-preflight.json` in the local research directory record the result and installed archive identity.

This is **version-specific experimental evidence**, not a published desktop configuration contract or proof that the desktop has adopted the socket. Actual activation still requires checking other active tasks, preparing a private native service, configuring Veyra to that same socket, and restarting the desktop with the explicit socket URL. Restart affects other desktop tasks and requires explicit approval. Never patch the app archive, remove native writer locks or kill another task to force attachment. After restart, verify shared-service identity and the exact selected task with metadata-only checks before attempting a controlled run. Rollback removes the launch environment override and uses `ve setup --codex-stdio`; stop the shared service only after confirming it has no active work.

The current desktop has **not** been restarted or migrated. The actual ChatGPT → selected desktop task → same ChatGPT return remains **unverified**, and P0.13–P0.15 remain frozen.

Completed implementation gates: all five repository checks (2,234 tests), 199 extension tests, `smoke:browser` and `smoke:conversation-browser`. The 19 shared-transport regressions cover busy/unknown/moved targets, frame limits, response identity, ownership races, cancellation, timeout, unresolved approval and terminal-event confirmation. On Chromium `153.0.8010.12`, both browser fixtures performed exactly two executions/two returns with persisted pass/fail reviews; the Native Messaging fixture also preserved the selected task and review across extension reload, cold worker, page refresh and actual coordinator idle shutdown. Each 3,000-turn/60-second idle test made **zero DOM queries**; page task time was 0.0525 / 0.053 seconds, with one mutation-burst inspection and all 14 normalization/safety cases passing.

Logs are in `~/Projects/veyra-proofs/shared-native-research-20260912/`. The first browser attempt lacked the installed Playwright browser binary; installing that test-only dependency resolved the environment blocker. User Chrome profiles were not used. Both extension distributions retain build `456eed251dc4dd9f313cc56e469b0506853b078f4d43bd9750cb6efe265eb828`, with all eleven artifact hashes verified. CLI/native adapter builds were updated; the existing installation's socket setting was not changed. The migration must establish a fresh native host/coordinator connection to load those builds; clearing Chrome's error list is not a verification step.
