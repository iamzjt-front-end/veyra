# Veyra Local Control Center

A private React/Vite surface for local Project and run evidence, sharing `@veyraoss/ui` with the Chrome Side Panel. Production data comes from the existing Project/Daemon tool API; fixtures are confined to `dev/` and tests.

After `ve setup`, use `ve open`. The CLI starts a loopback-only GUI server and lazily connects the coordinator. A one-use, 60-second invitation establishes an eight-hour HttpOnly/SameSite session; the URL invitation is immediately removed. No API key, manual port or pairing JSON is needed. The Side Panel's run details can open a Project-scoped session through Native Messaging.

The server enforces exact Host/Origin, CSRF, Project scope/root, installation and grant revocation. It exposes evidence reads and cancellation of an existing run, with no dispatch, arbitrary shell/file access or approval override. Signing out revokes the browser session. Saved Project evidence and active coordinator runs survive the GUI closing.

Meaningful filesystem changes are batched into SSE notifications. There is no heartbeat or fixed UI polling. Hidden/closed pages detach; reconnects use three bounded retries. The GUI server shuts down after 60 seconds without an open subscriber. Lists return the latest 20 native handoff runs per Project; historical optional-provider workflows are outside this initial view.

Development screenshots: `pnpm --filter @veyraoss/control-center smoke:gui` (set `CHROMIUM_EXECUTABLE` when using an existing Chromium). Browser tests use disposable Projects, never personal ChatGPT conversations or native credentials. This does not complete real P0.12 acceptance.

Run Detail shows the saved handoff/result and matching verification/review evidence. Unified diff previews cap source data at 32 KiB, 128 files, 1,600 parsed lines and 640 rendered lines for the selected file; unchanged context folds and binary contents stay hidden. Current workspace diffs include pre-existing edits and are labelled accordingly. Artifact references can be copied; the GUI does not open arbitrary filesystem paths. A recorded review must match both the run and result before it is displayed.
