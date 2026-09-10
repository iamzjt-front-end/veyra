# GUI productization acceptance — updated 2026-09-10

GUI-1–GUI-6 implement the shared design system, Chrome Side Panel, tiny popup launcher, local Control Center and run evidence/Diff views. This delivery stops for the first **user visual review**. P0.12 remains blocked on repaired real ChatGPT Pro re-acceptance; P0.13–P0.15 were not started. Deterministic screenshots and native-host fixtures do not constitute a real ChatGPT account or model proof.

## Open the UI

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm ui:dev
```

Open `http://127.0.0.1:4173`. This independent gallery renders the same UI components with clearly labelled, fixed example data. No Project, ChatGPT account, Codex session or API key is accessed. Routes include:

- `/side-panel/unbound`, `/side-panel/idle`, `/side-panel/running`, `/side-panel/verification`, `/side-panel/completed`, `/side-panel/failed` and all attention states;
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

For an existing installation, keep its loaded directory: open `chrome://extensions`, click Veyra **Reload**, then refresh the target ChatGPT conversation to replace the old content script. The fixed extension ID remains `meibodpmcjcjdpfaaejdpiclijnpcclh`; no new account credentials are needed. For a first installation, enable Developer Mode and Load unpacked the **dist directory itself**, not the source or repository root. Run `ve setup` once if the local Native Host has not yet been registered.

On an existing `https://chatgpt.com/c/...` conversation, open Veyra's popup → **Open Veyra**. The Side Panel shows the selected Project/path and whether this conversation is bound. Bind explicitly once; confirmed native bindings restore after refresh. Pause/Unbind remain immediate controls, and View run exposes cancellation/evidence. Existing uncertain sends do not auto-retry. Diagnostics retains raw state and the HTTP fallback.

Do not change a binding while its run outcome is uncertain. The later real-account gate starts from the [installed-user re-acceptance steps](../apps/chatgpt-extension/README.md#已安装用户本次真实复验从这里开始), using the original disposable `veyra-pro-proof` Project. For this delivery, review the UI first.

## Screenshots and repeatability

Versioned baseline images: [`apps/dashboard/test/visual/baseline/`](../apps/dashboard/test/visual/baseline/). Generated review artifacts: `output/playwright/gui/` (ignored by Git).

| Surface             | Review images                                                                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Side Panel          | `side-panel-unbound.png`, `side-panel-idle.png`, `side-panel-running.png`, `side-panel-verification.png`, `side-panel-completed.png`, `side-panel-failed.png`, `side-panel-dark.png`                                   |
| Attention states    | `side-panel-paused.png`, `side-panel-cancelled.png`, `side-panel-disconnected.png`, `side-panel-no-projects.png`, `side-panel-project-missing.png`, `side-panel-codex-unavailable.png`, `side-panel-waiting-codex.png` |
| Control Center      | `control-center-overview.png`, `control-center-project.png`, `control-center-run.png`, `control-center-failed.png`, `control-center-settings.png`, `control-center-missing.png`, `control-center-empty.png`            |
| Dark Control Center | `control-center-dark.png`, `control-center-run-dark.png`                                                                                                                                                               |
| Popup               | `popup.png`                                                                                                                                                                                                            |

Each image above has a Simplified Chinese counterpart ending in `-zh.png`, for **48 screenshots** covering 24 layouts in two languages. The screenshots use Chromium **149.0.7827.55**, macOS, scale 1, fixed viewports (400×820 panel, 1440×980 GUI, 300×310 popup; full-page captures may be taller), en-US/UTC, time `2026-09-09T10:29:14Z`, disabled motion and bundled **Inter Variable / JetBrains Mono Variable 5.3.0**. Chinese glyphs use the local macOS CJK fallback. Only fixture visual tests use these fonts; production retains the design's system font stacks. The runner refuses a different recorded browser/platform rather than silently replacing baselines. Side Panel additionally checks 320/360/400/420/460px; Control Center checks 900/1440px.

The verified existing browser can be selected without downloading another one:

```sh
export CHROMIUM_EXECUTABLE='/Users/iamzjt/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
pnpm ui:test
```

`pnpm ui:test` writes `visual-report.json` and actual screenshots. Unexpected changes create a diff image and fail. Update only after examining the change with **`pnpm ui:update`**, then re-run `pnpm ui:test`; normal tests never rewrite baselines. This is a pinned local rendering baseline, not a claim of identical rasterization across operating systems.

The suite also exercises automated WCAG A/AA rules, keyboard focus/Enter/Escape, menu arrows, virtual-list Home/End, drawer dismissal, diff file/context navigation, reduced motion, no idle animation, and no external network. Automated accessibility checks complement the pending human visual review; they do not certify every assistive-technology interaction.

## Performance and boundaries

Large Project/run lists render at most **14 rows**, tested with **3,000** entries. Unified diff source is bounded to 32 KiB/128 files/1,600 parsed lines and a maximum 640 mounted lines for the selected file; unchanged context folds. Source is rendered as text, not executable markup. Saved verifier evidence and matching review identity are checked separately from Codex's summary. No fictional test count or ChatGPT approval is displayed. Current-workspace diff is labelled as including pre-existing edits.

A production-asset browser session against a real disposable local Daemon, with 36 Projects, measured **60 idle seconds: zero API requests, zero UI mutations, 0.0150s browser TaskDuration**. See `output/playwright/gui/control-center-performance.json`. This measures isolated main-thread work, not whole-machine CPU in the user's personal Chrome profile.

Stable idle has no UI polling, full conversation scan or repeating animation:

- Content script observes newly completed assistant turns; its 400ms completion debounce exists only after mutations. Real sends retain bounded button/echo deadlines.
- Popup and Side Panel use cached change notifications, coalesced for 100ms only when events arrive. Hidden surfaces stop refreshing; close removes listeners and pending work. Only a changed binding/run evidence identity causes a bounded evidence read.
- Active runs retain bounded backoff/long-wait behavior; completion, Pause/Cancel or Unbind clears active work. No run means no run timer.
- Control Center uses batched SSE (250ms after meaningful state events), closes it when hidden, and retries a broken stream at most three times (2/4/8s). There is no heartbeat or periodic refresh.
- Native ports close after a one-shot 5s idle deadline. GUI/coordinator have one-shot 60s idle shutdown deadlines; active Codex work is preserved.

The real MV3 browser fixture covers two executions and same-conversation handbacks, failed/passed Verifier evidence, native refresh/Unbind, HTTP pairing/revocation, 14 send-normalization/safety cases, 3,000 old turns, 60s idle and a 1,000-mutation burst. It uses a simulated ChatGPT page and executor, while exercising the real extension, transport, coordinator and Verifier. Native smoke also opens the real built Control Center from the Side Panel and verifies the matching Project/run.

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

All five baseline commands passed on the final GUI code (**2,016 tests**). The final browser checks below also passed, including **48 bilingual screenshots with zero differing pixels** and all captured automated WCAG A/AA checks. Native and HTTP 3,000-turn/60s idle fixtures issued zero DOM queries (TaskDuration 0.0191s / 0.0217s). They use the selected `CHROMIUM_EXECUTABLE`:

```sh
pnpm --filter @veyraoss/chatgpt-extension smoke:native-browser
pnpm --filter @veyraoss/chatgpt-extension smoke:browser
pnpm --filter @veyraoss/chatgpt-extension smoke:panel
pnpm --filter @veyraoss/control-center smoke:gui
pnpm ui:test
```

Localization regression also covers catalog parameter parity, unknown/prototype-like text, private preference files, failed saves, late reads, refresh/restoration, and no idle language timers. The real MV3 fixtures switch Diagnostics and Side Panel languages without changing binding records or execution count. The production GUI fixture switches from Chinese to English and restores English after refresh and a real local-server restart at a different port. These remain deterministic local tests; repaired real ChatGPT Pro re-acceptance is still pending.

Run the fixed visual comparison last because the other screenshot smoke scripts render ordinary system-font previews into the same output directory. Test-owned browser profiles, hosts, daemons and disposable Projects are cleaned up; no personal Chrome profile or ChatGPT credentials are accessed. Per-phase results and the outstanding real-account gate are recorded in [TODO](TODO.md).
