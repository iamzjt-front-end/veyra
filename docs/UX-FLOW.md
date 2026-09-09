# Veyra UX Flow

> **Setup once. Bind once. Then just talk.**

This document defines the target user interaction for Veyra's ChatGPT ↔ native Codex golden path. The current `prepare:live`, manual daemon start, JSON pairing-file selection and disposable proof flow are **developer acceptance tooling**, not the intended product experience.

## Product UX principle

A normal user should not need to understand or manually operate:

- daemon ports;
- pairing JSON files;
- `PROOF_DIR`;
- localhost health checks;
- Codex executable paths;
- extension reloads;
- run IDs;
- handoff JSON;
- verifier command IDs.

Those remain inspectable engineering details, not required interaction steps.

The target is:

```text
First time          Per project           Daily use
──────────          ───────────           ─────────
ve setup      →     ve init         →     Open ChatGPT
                                            ↓
                                      Click Veyra
                                            ↓
                                      Select/confirm Project
                                            ↓
                                           Bind
                                            ↓
                                        Just talk
```

## 1. First-time setup

The preferred first-time experience is one command:

```bash
ve setup
```

`ve setup` should:

1. detect the installed native Codex client;
2. confirm Codex native authentication/readiness without reading credentials;
3. install/register the browser-native Veyra bridge for the current OS/browser where supported;
4. verify the ChatGPT extension is installed, or open the install page/instructions;
5. establish a persistent local installation identity/grant;
6. verify Veyra can start its local coordinator on demand;
7. run a short doctor check;
8. finish with one clear result:

```text
Veyra is ready.
Codex      Ready
Chrome     Connected
ChatGPT    Extension installed
API key    Not required
```

The user should not manually choose a pairing JSON file during normal setup.

## 2. Preferred browser transport: Chrome Native Messaging

For the browser-extension path, the preferred production UX is **Chrome Native Messaging**, not a manually managed localhost HTTP pairing flow.

Target architecture:

```text
ChatGPT Web
    │
Veyra Extension
    │ chrome.runtime.connectNative
    ▼
Veyra Native Messaging Host
    │
    ├── starts/discovers local Veyra coordinator lazily
    └── talks to Project/Core/Runtime
             │
             ▼
        Native Codex
```

Benefits:

- no visible localhost port;
- no JSON pairing file;
- no CORS setup;
- no Cloudflare/ngrok/public tunnel;
- Chrome starts the native host only when needed;
- native host manifest can allow only the official Veyra extension ID;
- OS-user + extension identity provide a narrower local trust boundary;
- daemon/coordinator lifecycle can be hidden behind the bridge.

The existing loopback HTTP/pairing implementation remains valuable as deterministic test infrastructure and fallback transport. Do not delete it merely to implement Native Messaging.

## 3. Local coordinator lifecycle

The user should not run `ve daemon start` during normal use.

Preferred behavior:

- Veyra starts the coordinator lazily when the extension/CLI needs it;
- coordinator exits after a safe idle timeout when nothing owns an active run;
- active Codex runs prevent accidental shutdown;
- `ve daemon status/start/stop` remain advanced/debug commands;
- an optional background service may be offered later, but is not required for the happy path.

The extension should display simply:

```text
Veyra  ● Ready
```

not daemon implementation details unless the user opens Diagnostics.

## 4. Per-project setup

Inside a repository/project folder, one command:

```bash
ve init
```

should:

- initialize `.veyra/` if needed;
- register the Project globally;
- detect repository/tooling basics;
- bind native Codex as the default executor if ready;
- preserve existing Veyra configuration;
- avoid asking about optional API providers.

Expected result:

```text
✓ Veyra Project initialized
✓ Codex ready

Project: my-app
Path: ~/Projects/my-app
```

No additional daemon or pairing step should be necessary.

## 5. Daily ChatGPT flow

Normal use should require only the extension popup.

### Unbound conversation

```text
Veyra

● Ready

Project
[ my-app ▾ ]

[ Bind this conversation ]
```

Rules:

- default the picker to the most recently used/explicitly active Project where safe;
- never silently bind based on chat text/title;
- user confirms the Project once;
- show the absolute path in secondary text for disambiguation;
- if only one Project exists, preselect it but still require one explicit bind click.

### Bound conversation

```text
Veyra

● Connected
Project  my-app
Codex    Ready
Run      Idle

[ Pause ]  [ Unbind ]
```

The user then simply talks to ChatGPT normally.

No separate "detect daemon", "refresh readiness", "pair", or "enable automation" steps should appear in the normal flow.

## 6. Conversation binding persistence

A page refresh must not force the user to bind again.

After explicit binding, Veyra may remember:

```text
ChatGPT conversation id -> Veyra Project id
```

locally in extension storage.

Requirements:

- restore only for the exact same ChatGPT conversation;
- never carry the binding to another conversation automatically;
- show the bound Project visibly after restore;
- allow immediate Unbind;
- do not store conversation content/history;
- if Project path/identity changed or the local bridge is not trusted, fail closed and ask for rebind.

Tab refresh/navigation within the same conversation should re-arm the content script automatically rather than permanently pausing the UX.

## 7. Project selection should be persistent and fast

The extension should remember:

- recent Projects;
- last explicitly used Project;
- per-conversation binding;

but Project identity/state remains owned by `.veyra/` and the Project registry.

The popup should not repeatedly require `Detect daemon / Refresh Project readiness`.

Use event-driven snapshots and refresh automatically when:

- extension opens;
- native host reconnects;
- Project registry changes;
- Codex readiness changes;
- run state changes.

A manual Refresh action can live under Diagnostics.

## 8. Hide machine plumbing from the conversation

Structured handoff/result blocks are necessary for the experimental bridge but should not dominate the human conversation.

For the browser bridge:

- continue using explicit canonical handoff/result markers for machine safety;
- after dispatch/receipt, visually collapse Veyra machine blocks into a small reversible status card where feasible;
- never delete or mutate persisted Project evidence;
- user can expand the raw structured payload when debugging.

Example collapsed UI:

```text
Veyra · Plan sent to Codex      ✓
Veyra · Codex result returned   ✓  tests 12/12
```

The normal visible conversation should remain focused on GPT's plan/review and the user's intent.

## 9. Automatic recovery

Common transient failures should self-heal without forcing setup from scratch.

Examples:

- extension service worker restarted -> reconnect native host;
- ChatGPT page refreshed -> restore same-conversation binding;
- coordinator stopped while idle -> restart lazily;
- Codex temporarily busy -> show Waiting, do not make user re-pair;
- native host updated -> reconnect;
- popup closed -> automation continues only for the explicitly bound conversation/run.

Require user action again only when security identity/scope actually changes.

## 10. Progressive disclosure

Default popup should show only:

```text
Veyra
● Ready / Working / Needs attention
Project
Run
Primary action
```

Move the following under **Diagnostics**:

- daemon/coordinator details;
- loopback/native transport;
- Project UUID;
- run UUID;
- Codex executable path/version;
- grant expiry;
- raw errors/log locations;
- manual refresh;
- pairing/debug controls.

Experimental/debug builds may expose more details, but product UX should follow this hierarchy.

## 11. Desired command surface

Primary commands:

```bash
ve setup          # one-time machine/browser/native setup
ve init           # initialize/register current Project
ve status         # simple current health/project/run status
ve doctor         # diagnostics when something is wrong
```

Advanced/debug commands remain available but should not be taught in the primary onboarding:

```bash
ve daemon ...
ve project ...
ve review ...
ve resume ...
```

## 12. Target end-to-end experience

### First day

```text
npm install -g <Veyra CLI>
ve setup
cd ~/Projects/my-app
ve init
```

Then install/enable the Veyra browser extension once if setup cannot automate the browser-store step.

### Every normal day after that

```text
1. Open ChatGPT.
2. Click Veyra.
3. Confirm/select Project and Bind (once per conversation).
4. Ask ChatGPT what you want.
5. Veyra coordinates Codex automatically.
```

No terminal is required after Project initialization unless the user wants diagnostics.

## 13. Acceptance criteria for UX simplification

Before calling the browser-bridge onboarding stable, demonstrate on a clean user profile:

- one `ve setup` flow;
- one `ve init` per Project;
- no manual daemon start;
- no pairing JSON selection in normal onboarding;
- no manual Codex executable path;
- no localhost URL/port exposed in primary UI;
- no manual readiness refresh in the happy path;
- one-click conversation binding;
- binding survives page refresh for the same conversation;
- no cross-conversation accidental binding;
- coordinator/host reconnects automatically;
- idle CPU is near zero;
- no `OPENAI_API_KEY` for the golden path;
- normal conversation remains readable, with machine payloads collapsed or clearly secondary;
- Diagnostics still exposes enough evidence to debug failures.

## 14. Implementation priority

Do not derail the P0 product proof by rebuilding unrelated providers/UI.

Recommended order:

1. finish the current real P0.12 transport proof;
2. implement one-command `ve setup`;
3. implement Chrome Native Messaging host + extension transport while retaining loopback fallback/tests;
4. lazy coordinator lifecycle;
5. persistent same-conversation Project binding;
6. simplify popup to Ready / Project / Bind / Run;
7. collapse machine handoff/result plumbing;
8. rerun P0.13–P0.15 product demo using the simplified happy path.

The final product metric is simple: **after initial setup, the user should not feel like they are operating Veyra. They should feel like ChatGPT and Codex simply know how to work together on the selected Project.**
