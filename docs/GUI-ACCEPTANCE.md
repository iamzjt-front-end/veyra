# GUI productization acceptance — updated 2026-09-10

GUI-1–GUI-6 implement the shared design system, Chrome Side Panel, tiny popup launcher, local Control Center and run evidence/Diff views. The user has now demonstrated real ChatGPT Pro planning, native execution, independent verification, automatic same-conversation result return and ChatGPT review. The latest repair persists that review and separates execution, verification and review in the GUI. Its real-account re-test remains pending; P0.13–P0.15 were not started. Deterministic screenshots and native-host fixtures do not substitute for that re-test.

## Open the UI

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm ui:dev
```

Open `http://127.0.0.1:4173`. This independent gallery renders the same UI components with clearly labelled, fixed example data. No Project, ChatGPT account, Codex session or API key is accessed. Routes include:

- `/side-panel/unbound`, `/side-panel/idle`, `/side-panel/running`, `/side-panel/verification`, `/side-panel/completed`, `/side-panel/failed` and all attention states;
- `/side-panel/review-approved`, `/side-panel/review-changes`, `/side-panel/review-human` distinguish review verdicts from verification outcomes;
- `/control-center/overview`, `/control-center/project`, `/control-center/run`, `/control-center/failed`, `/control-center/settings`;
- `/popup`.

Use `?theme=dark` for dark previews. Ordinary previews use system fonts. The dev server listens only on loopback; stop it with Ctrl+C. It is a visual-development entry, not an onboarding requirement.

For actual registered local Projects, use **`ve open`** after the one-time `ve setup`. From this built source checkout, use `pnpm ve -- open`. The CLI opens an authenticated local session automatically; no port, daemon command or pairing file is needed. The Side Panel's **View run → Open Control Center** opens the corresponding Project/run through Native Messaging. A scoped invitation never expands that Project grant.

## Chinese / English interface

The GUI defaults to **简体中文**. Use the **语言 / Language** icon at the top of the Side Panel or Control Center, or in the popup footer, to select **English**. Control Center **设置 / Settings → 语言 / Language** and extension Diagnostics provide the same explicit choice. The preview gallery also supports language selection; `?lang=zh-CN` and `?lang=en` pin a fixture's language.

Side Panel, popup and Diagnostics share a trusted `chrome.storage.local` UI preference. The background sends cosmetic locale updates only to the current supported ChatGPT tab; only Veyra's own machine-message controls are repainted. The Control Center keeps its own preference at `<registryRoot>/ui-preferences.json` (0600), so it survives an ephemeral port change. Its authenticated endpoint retains the existing session, exact Origin/Host, CSRF and live revocation checks, and accepts only a valid locale field. Language changes add no polling or execution authority.

Buttons, statuses, workflow steps, empty/error explanations, verification labels, Diff controls, accessible names and Diagnostics are localized. Project names/goals, code, raw errors/logs and protocol values retain their source text; English task titles in the fixed examples are sample engineering data. Switching never changes binding/run identity, replays an unconfirmed delivery, or substitutes a translation for saved evidence. `.veyra/` remains engineering memory.

## Chrome installation and update

The extension is already built at:

```text
/Users/iamzjt/Desktop/my/myapp/veyra/apps/chatgpt-extension/dist
```

Repository-relative path: `apps/chatgpt-extension/dist/`. The CLI also ships an identical copy at `apps/cli/dist/browser-extension/`.

For the current review repair, keep the loaded directory: open `chrome://extensions`, click Veyra **Reload**, then refresh the original bound ChatGPT conversation. The confirmed binding restores without replaying bootstrap, old handoffs or old reviews. Request only a fresh review of the already returned result; no new execution or fixture repair is needed. The fixed extension ID remains `meibodpmcjcjdpfaaejdpiclijnpcclh`; no setup, pairing or new account credentials are needed for this update. For a first installation, enable Developer Mode and Load unpacked the **dist directory itself**, not the source or repository root. Run `ve setup` once if the local Native Host has not yet been registered.

On an existing `https://chatgpt.com/c/...` conversation, open Veyra's popup → **Open Veyra**. The Side Panel shows the selected Project/path and whether this conversation is bound. Bind explicitly once; confirmed native bindings restore after refresh. Pause/Unbind remain immediate controls, and View run exposes cancellation/evidence. Existing uncertain sends do not auto-retry. Diagnostics retains raw state and the HTTP fallback.

Do not change a binding while its run outcome is uncertain. Existing native users follow the reconnect re-test instructions in the [Native Messaging guide](../apps/chatgpt-extension/README.md#native-messaging-产品流程), using the original disposable `veyra-pro-proof` Project; first-time/HTTP migration instructions follow separately. Real ChatGPT Pro acceptance is still required.

## Screenshots and repeatability

Versioned baseline images: [`apps/dashboard/test/visual/baseline/`](../apps/dashboard/test/visual/baseline/). Generated review artifacts: `output/playwright/gui/` (ignored by Git).

| Surface             | Review images                                                                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Side Panel          | `side-panel-unbound.png`, `side-panel-idle.png`, `side-panel-running.png`, `side-panel-verification.png`, `side-panel-completed.png`, `side-panel-failed.png`, `side-panel-dark.png`                                   |
| Attention states    | `side-panel-paused.png`, `side-panel-cancelled.png`, `side-panel-disconnected.png`, `side-panel-no-projects.png`, `side-panel-project-missing.png`, `side-panel-codex-unavailable.png`, `side-panel-waiting-codex.png` |
| Review outcomes     | `side-panel-review-approved.png`, `side-panel-review-changes.png`, `side-panel-review-human.png`                                                                                                                       |
| Control Center      | `control-center-overview.png`, `control-center-project.png`, `control-center-run.png`, `control-center-failed.png`, `control-center-settings.png`, `control-center-missing.png`, `control-center-empty.png`            |
| Dark Control Center | `control-center-dark.png`, `control-center-run-dark.png`                                                                                                                                                               |
| Popup               | `popup.png`                                                                                                                                                                                                            |

Each image above has a Simplified Chinese counterpart ending in `-zh.png`, for **54 screenshots** covering 27 layouts in two languages. The screenshots use Chromium **149.0.7827.55**, macOS, scale 1, fixed viewports (400×820 panel, 1440×980 GUI, 300×310 popup; full-page captures may be taller), en-US/UTC, time `2026-09-09T10:29:14Z`, disabled motion and bundled **Inter Variable / JetBrains Mono Variable 5.3.0**. Chinese glyphs use the local macOS CJK fallback. Only fixture visual tests use these fonts; production retains the design's system font stacks. The runner refuses a different recorded browser/platform rather than silently replacing baselines. Side Panel additionally checks 320/360/400/420/460px; Control Center checks 900/1440px.

The verified existing browser can be selected without downloading another one:

```sh
export CHROMIUM_EXECUTABLE='/Users/iamzjt/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
pnpm ui:test
```

`pnpm ui:test` writes `visual-report.json` and actual screenshots. Unexpected changes create a diff image and fail. Update only after examining the change with **`pnpm ui:update`**, then re-run `pnpm ui:test`; normal tests never rewrite baselines. This is a pinned local rendering baseline, not a claim of identical rasterization across operating systems.

The suite also exercises automated WCAG A/AA rules, keyboard focus/Enter/Escape, menu arrows, virtual-list Home/End, drawer dismissal, diff file/context navigation, reduced motion, no idle animation, and no external network. Automated accessibility checks complement the pending human visual review; they do not certify every assistive-technology interaction.

## Performance and boundaries

Large Project/run lists render at most **14 rows**, tested with **3,000** entries. Unified diff source is bounded to 32 KiB/128 files/1,600 parsed lines and a maximum 640 mounted lines for the selected file; unchanged context folds. Source is rendered as text, not executable markup. Saved verifier evidence and matching review identity are checked separately from Codex's summary. No fictional test count or ChatGPT approval is displayed. Current-workspace diff is labelled as including pre-existing edits.

A production-asset browser session against a real disposable local Daemon, with 36 Projects, measured **60 idle seconds: zero API requests, zero UI mutations, 0.0127s browser TaskDuration** in the review repair. See `output/playwright/gui/control-center-performance.json`. This measures isolated main-thread work, not whole-machine CPU in the user's personal Chrome profile.

Stable idle has no UI polling, full conversation scan or repeating animation:

- Content script observes newly completed assistant turns; its 400ms completion debounce exists only after mutations. Real sends retain bounded button/echo deadlines.
- Popup and Side Panel use cached change notifications, coalesced for 100ms only when events arrive. The first requested snapshot after worker eviction rehydrates connection/readiness once instead of treating a lost memory cache as disconnection. Hidden surfaces stop refreshing; close removes listeners and pending work. Only a changed binding/run evidence identity causes a bounded evidence read.
- Active runs retain bounded backoff/long-wait behavior; completion, Pause/Cancel or Unbind clears active work. No run means no run timer.
- Control Center uses batched SSE (250ms after meaningful state events), closes it when hidden, and retries a broken stream at most three times (2/4/8s). There is no heartbeat or periodic refresh.
- Native ports close after a one-shot 5s idle deadline. A dropped handshake or allowlisted read may schedule one 200ms recovery delay; mutations, invalid replies, authorization failures and timeouts never replay. GUI/coordinator have one-shot 60s idle shutdown deadlines; active Codex work is preserved.

The real MV3 browser fixture covers two executions and same-conversation handbacks, failed/passed Verifier evidence, native refresh/Unbind, HTTP pairing/revocation, 14 send-normalization/safety cases, 3,000 old turns, 60s idle and a 1,000-mutation burst. It uses a simulated ChatGPT page and executor, while exercising the real extension, transport, coordinator and Verifier. Both transports now persist a review for each result: failed verification with review approval, then passed verification with changes requested. Native smoke verifies the canonical verdict in the Side Panel, the real built Control Center and after refresh, without resubmission. Idle DOM queries remain zero (native 0.0417s / HTTP 0.0360s TaskDuration).

The 2026-09-10 reconnect regression also stops the actual coordinator through its normal 60-second idle deadline, evicts the extension worker twice and verifies its globals were lost. A snapshot restores the same binding without manual Reconnect; a subsequent new handoff wakes a cold worker/coordinator without replaying bootstrap or old work. Reusing a Stop control through attribute changes also completes dispatch. Native and HTTP browser checks passed with zero idle DOM queries (TaskDuration 0.0249s / 0.0237s). All five baseline commands passed with **2,030 tests**, including **86 extension tests**. Real Pro Reload/re-acceptance remains pending; this does not mark P0.12 complete.

The subsequent real Ready-without-dispatch report exposed ChatGPT's `section[data-testid="conversation-turn-…"]` layout with its completion toolbar in a separate nested branch. The shared page/watcher lookup now supports that observed layout and legacy articles while requiring completion within the same turn. Complete planner instructions clarify task ID strings, structured decisions and top-level verification requests; invalid data is rejected with localized Diagnostics. Read-only inspection recognizes the original live handoff and rejects its malformed schema without executing it. Both Chromium transport fixtures pass two executions/handbacks, failure/pass evidence, 14 send/safety cases and 3,000 mixed old turns with zero DOM queries during 60 idle seconds (native 0.0604s / HTTP 0.0348s TaskDuration). All five baseline commands pass with **2,040 tests**, including **96 extension tests**; both extension asset directories contain the same 14 files. No GUI layout or visual baseline changed. Reload/refresh and a one-time explicit rebind are needed to deliver the corrected planner template to the existing conversation; real P0.12 remains pending.

The latest missing-receiver report is fixed by a single, read-only preparation recovery on explicit Bind/Resume. The native browser fixture actually reloads the extension, confirms `Receiving end does not exist`, and successfully binds to the same page without refreshing it. It still passes worker/coordinator idle recovery and two execution/result handbacks. Attachment is restricted to the active conversation and Chrome main-document ID; invalidated content instances are disposed, uncertain writes are never replayed, and known pre-send errors show a direct Chinese/English remedy. **121 extension tests / 2,065 total tests** and all five baseline commands pass. Both browser transports retain 14 safety cases and zero DOM queries during 60 idle seconds with 3,000 old turns (native **0.0357s** / HTTP **0.0291s** TaskDuration). The same 14 assets are rebuilt in both extension directories; no periodic timer was added. The native harness configures Developer Mode only in its disposable Chrome profile. Bilingual error rendering is tested; no visual baseline was regenerated. Real ChatGPT Pro re-acceptance remains required after Reload and explicit Bind on the currently unbound conversation.

The GUI server binds only 127.0.0.1 and checks Host/Origin, one-use invitation, HttpOnly/SameSite session, CSRF, Project root/scope and live installation/grant revocation. It exposes bounded evidence reads and cancellation, with no dispatch, shell, arbitrary file access or approval override. Sign-out clears the browser snapshot; `.veyra/` remains the source of engineering memory. API providers remain optional, and no native credentials or full conversation history are collected.

## Verification commands

Each GUI phase runs the repository baseline before its focused commit:

```sh
pnpm lint
pnpm format:check
pnpm check
pnpm test
pnpm build
```

All five baseline commands passed on the review repair (**2,165 tests**, including 161 extension tests). The browser checks below also passed, including **54 bilingual screenshots with zero differing pixels** and all captured automated WCAG A/AA checks. Native and HTTP 3,000-turn/60s idle fixtures issued zero DOM queries (TaskDuration 0.0417s / 0.0360s). They use the selected `CHROMIUM_EXECUTABLE`:

```sh
pnpm --filter @veyraoss/chatgpt-extension smoke:native-browser
pnpm --filter @veyraoss/chatgpt-extension smoke:browser
pnpm --filter @veyraoss/chatgpt-extension smoke:panel
pnpm --filter @veyraoss/control-center smoke:gui
pnpm ui:test
```

Localization regression also covers catalog parameter parity, unknown/prototype-like text, private preference files, failed saves, late reads, refresh/restoration, and no idle language timers. The real MV3 fixtures switch Diagnostics and Side Panel languages without changing binding records or execution count. The production GUI fixture switches from Chinese to English and restores English after refresh and a real local-server restart at a different port. These remain deterministic local tests; repaired real ChatGPT Pro re-acceptance is still pending.

Run the fixed visual comparison last because the other screenshot smoke scripts render ordinary system-font previews into the same output directory. Test-owned browser profiles, hosts, daemons and disposable Projects are cleaned up; no personal Chrome profile or ChatGPT credentials are accessed. Per-phase results and the outstanding real-account gate are recorded in [TODO](TODO.md).
