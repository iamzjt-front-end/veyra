# Handoff observation repair — September 12, 2026

## Actual reported task

The reported Run `6240df1c-f180-4b99-a717-757633c19b1e` did **not** reach the local execution archive. The selected Project had its configuration files but no matching handoff, run or result. Veyra's own extension routing record retained the exact ChatGPT conversation and native task, with `phase: armed`, `count: 0`, the matching `nextRunId`, and no detection/admission checkpoint. The native task remained idle with its earlier completed turn.

This locates this incident before local dispatch. It does not prove which live DOM condition prevented detection. No old handoff was replayed and no turn was submitted to the user's research Project during diagnosis.

## Reproduced defects and repair

- A `.result-streaming` flag in an earlier turn blocked a newly completed handoff. Generation checks now ignore a flag only when it belongs to a provably earlier turn. Actual stop controls, current/newer turns and unknown wrappers still block both observation and result insertion. The watcher maintains signals from mutation records; it does not scan the document per token or while idle.
- Restored observation recognized the old Send selector and Enter but missed a trusted submit from the current composer form. It now recognizes that form submission and its submit button. Synthetic events and other forms cannot reopen the observation boundary.
- A same-document worker/coordinator reconnect discarded the in-progress reply by rebuilding the observer's historical-ID snapshot. Restore now preserves the watcher for the same binding and document epoch. A genuine refresh still requires a fresh send and never replays history.
- A healthy native login was presented as sufficient readiness for an existing desktop task. Idle status refresh/cold-worker recovery now also checks the explicitly selected task's writer/root availability. Failure does not become a login or bridge-disconnection error. Checks are cached for 30 seconds on requested refreshes; no timer, background task listing or active-run writer probe is added. Native dispatch still performs its own admission checks.

The page reports bounded states: waiting for a new send, waiting for ChatGPT, responding, awaiting completion confirmation, plain reply without a handoff, protocol detected, unsupported layout, or invalid protocol. Side Panel and Diagnostics localize these states. Unknown observation cannot appear Ready, including subsequent cached snapshots. Reports contain only a phase and an optional current message ID, never body text; they are excluded from durable bindings.

## Verification boundary

All five repository checks passed: `pnpm lint`, `pnpm format:check`, `pnpm check`, `pnpm test` (**2,249 tests**) and `pnpm build`. Extension tests passed (**214**), including reconnect during an in-progress reply, cold/cached unknown states, native writer readiness, trusted form submission and result insertion with historical streaming flags.

On Chromium `153.0.8010.12`, `smoke:conversation-browser` and `smoke:browser` each completed exactly **two executions and two confirmed same-conversation returns**, with persisted pass/fail reviews. Earlier replies deliberately retained streaming styles throughout dispatch, return and review. The Native Messaging fixture also retained the exact selected native task across extension reload, page refresh, cold worker and actual coordinator idle shutdown. No bootstrap or execution was replayed.

Both browser fixtures measured **zero DOM queries** across 60 seconds idle with 3,000 old turns; page task time was 0.076 / 0.073 seconds, and a mutation burst caused one inspection. Fourteen send-integrity/safety cases passed. `smoke:startup` exercised ten real MV3 reloads and all three extension surfaces: historical error IDs/counts stayed unchanged and no new runtime errors occurred. `smoke:panel` verified the new bilingual states at 320–460 px without overflow or page errors. These tests use isolated browser profiles and registry roots, not the user's account.

Build `c850d0028869123a5c637cabd76027639d6ba8554e81fdbfdb094c789fac2539` matches across both distributions, with all eleven artifact hashes verified. Logs and `build-verification.json` are in `~/Projects/veyra-proofs/handoff-repair-20260912/`; screenshots are in `output/playwright/gui/side-panel-observation-*.png` and `side-panel-native-task-unavailable-*.png`.

The actual selected ChatGPT → desktop task → same-conversation return remains open. A simulated ChatGPT browser, a native metadata read, or a clean extension error list cannot close that gate. Personal-browser tab discovery/opening repeatedly timed out; native UI inspection first showed another conversation, and the subsequent attempt to load the verified extension was blocked by the Mac lock screen. No personal extension reload was confirmed, no new task was sent and the old handoff was not replayed.

The installed extension directory remains `apps/chatgpt-extension/dist`; the native launcher remains `apps/cli/dist/native-host.js`. The CLI-packaged extension must have identical build identity and artifact hashes. Browser tests own disposable profiles and isolated registries; they never use the personal Chrome profile.

## Separate desktop transport issue

The actual desktop still launches a separate stdio native server. At `2026-09-12T11:25:03Z`, a fresh bounded exact-target availability probe again returned `already has an active writer`. It used metadata-only read/resume, submitted zero turns and stopped its owned process. `native-task-check.json` records the result; the Project still has no run archive. Generic login or binding metadata does not prove the desktop shares Veyra's writer. The previous proposed `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1` migration was incomplete: the installed desktop's nonempty configuration overrides prevent that branch. The corrected, version-specific findings and remaining activation gate are in [Codex conversation binding](CODEX-CONVERSATION-BINDING.md#remaining-desktop-migration-gate).

Keep P0.13–P0.15 frozen. Do not make the user repeatedly resend a task to compensate for an unverified live integration.
