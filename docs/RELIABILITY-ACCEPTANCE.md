# Browser bridge reliability acceptance — 2026-09-11

The user-approved reliability scope is complete. P0.13–P0.15 remain frozen. This
record separates actual account execution from offline browser regressions.

## Installed environment

- Actual personal Chrome **152.0.7977.83**, extension
  `meibodpmcjcjdpfaaejdpiclijnpcclh`, loaded from the repository's
  `apps/chatgpt-extension/dist`.
- Verified build ID:
  `c5d8cc4e17080f03f1dc04f80f47c08708f1dad67da3daa40874fb64f7a3201c`.
  All installed artifact SHA-256 values match `build-info.json`.
- Actual native Codex **0.154.0-alpha.6.1** reports `Logged in using ChatGPT`.
  The bridge/test supplied no API key, tunnel or public bridge server.
- A new durable Project, outside OS temporary directories, has its own source,
  checks and `.veyra/` evidence. The new dedicated ChatGPT Pro conversation was
  explicitly bound once. Other conversations and credentials were not inspected.
- Natural-language test requests were submitted through the current composer.
  Handoffs, execution, verification, result messages and review persistence were
  handled automatically by the production bridge. No execution result was pasted
  back manually, and no review archive was written by the test driver.

## Three consecutive real successes

| Run                                    | Operation                                             | Independent checks     | Actual same-conversation delivery marker | Persisted review                              |
| -------------------------------------- | ----------------------------------------------------- | ---------------------- | ---------------------------------------- | --------------------------------------------- |
| `3d262c45-de64-408b-ab40-5095a253599a` | Fix only `src/message.js`                             | test/build/diff passed | `a5ef2a39-7adf-4ad0-9d06-31168bd6c963`   | `977f327f-d851-4916-a88e-eb6b001ca612` — PASS |
| `f7528000-3527-469b-9cb9-f8dd2424d54d` | Read-only recheck                                     | test/build/diff passed | `c0226900-6646-4252-bbe1-8211ea705f6c`   | `3199250c-e6c3-4182-baca-8b4278e9e4ba` — PASS |
| `5e075548-ca03-4a70-8eca-c4de174353b7` | Read-only recheck after extension reload/page refresh | test/build/diff passed | `47a41f23-bd34-44e8-b474-91e5191b964e`   | `e151cd42-a78c-4bbb-b3d6-eeb39bfecab5` — PASS |

Each Run has exactly one `agent.started`. Every verification reference resolves to
its own persisted `verification.completed` event, with real exit codes and
untruncated output. Each user result message contains its unique marker and exact
Run/Result IDs. The actual new assistant review matches the saved review summary
and Result association. Protected files remain unchanged; the sole source diff
is the authorized greeting repair. Read-only rounds report no new changed files.

All six bridge checkpoints survive restoration. Reload/refresh did not send a new
binding message or replay the existing runs. The local coordinator was observed
idle-stopped and then restarted on demand; the same binding continued. Private
`bridge-acceptance/` records retain the exact conversation/message identities,
artifact hashes, Chrome error counters and assertion results without publishing
the account's conversation URL or a transcript in this repository.

## Negative evidence and discovered defects

- Preflight Run `4e6017de-cf8c-47bb-81c7-c2f5a338f194` genuinely records test
  failure and build/diff success. It exposed two additional defects: compact
  `FAIL + human` was rejected, and React could mount an old review after the
  initial identity snapshot. That preflight review was replayed during hydration;
  its original evidence is retained and **excluded** from the three successes.
  The bridge now maps FAIL/human to the existing fail/wait contract and starts
  restored observation closed until a fresh send boundary.
- Run `3fd01c17-6f87-4509-b45d-057ab0fbe582` was stopped through the installed
  extension's Cancel control. The canonical result has status/executionStatus
  `cancelled`; native process evidence records `SIGTERM` and termination reason
  `cancelled`. No Verifier step ran afterwards. The waiting child command had
  already ended when cancellation reached the still-running native process;
  this proves native-run cancellation, not killing that child mid-sleep.
  Explicit Stop suppresses automatic handback/review, while preserving all local
  evidence. Core's internal failed terminal event retains `run_cancelled`; it is
  not reported to the bridge as an ordinary test failure.
- The original personal Chrome `storage.local` error remains **ID 2, occurrence
  1**, unchanged across reloads. ID 4 (`sendMessage`, popup) and ID 5 (`click`,
  diagnostics) came from diagnostic-driver expressions in the wrong context or
  targeting a nonexistent diagnostic control. They are classified separately;
  neither is used as evidence of a new product exception. Error records were
  retained during verification; clearing a badge was not a passing criterion.
  After archiving those three identified entries, they were cleared and the
  actual extension reloaded once more. The actual popup started normally and
  Chrome reported **zero runtime errors**. Both before/after counter records are
  retained privately.

## Regression verification

- Extension: **193 tests passed**. Lost dispatch replies reconcile matching
  archived handoff fingerprints and Run identity using reads only. Missing,
  conflicting or uncertain evidence does not retry writes. Build/receiver,
  navigation, unbind races, review reconciliation and explicit human Resume are
  covered without granting native/Core approvals.
- `smoke:native-browser`, `smoke:browser`, `smoke:startup` passed in isolated
  Chromium **149.0.7827.55**. These are offline fixtures, distinct from the real
  account runs above. They cover reload, cold worker/coordinator restoration,
  failure/success evidence, review persistence and exact one-time handback.
- `smoke:panel` passed for 13 states at 320/360/400/420/460px, including keyboard
  focus and Escape handling. Screenshots remain in the ignored local
  `output/playwright/gui` directory.
- Both transports pass 14 real DOM normalization/safety cases, delayed historical
  hydration, trusted click/Enter boundaries, 3,000 old turns, 60 wall-clock idle
  seconds with **0 DOM queries**, and one check after a 1,000-mutation burst.
  Idle main-thread task deltas were 0.0671s (native) and 0.0465s (HTTP); these are
  fixture measurements, not a whole-machine CPU claim.
- Startup smoke first records the actual unsafe storage exception in a copied
  fixture bundle, upgrades to production, then reloads ten times. The historical
  error ID/count stays unchanged and no new production errors appear. Delayed and
  permanently unavailable extension APIs recover or fail closed without an
  uncaught exception. Popup close removes listeners and pending refresh work.
- Repository `pnpm lint`, `pnpm format:check`, `pnpm check`, `pnpm test`
  (**2,197 passed**) and `pnpm build` passed. CLI-packaged extension assets match
  the installed build. Independent proof inspection confirms protected-file
  hashes and real test/build success.

Idle retains no recurring DOM or UI poll. Active Runs alone use bounded
1/2/4/8/15-second backoff; completed/stopped Runs remove it. Event debounces and
the daemon's one-shot idle shutdown remain. All test-owned processes/profiles
are closed; the durable Project and account evidence are kept for inspection.
