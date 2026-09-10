# @veyraoss/cli

The Veyra command-line application, exposed as ve.

This package is a release candidate in the Veyra monorepo; it is not published yet. See the [installation guide](https://github.com/iamzjt-front-end/veyra/blob/main/docs/INSTALLATION.md) for setup, upgrades, removal and isolated npm installation verification, the [package strategy](https://github.com/iamzjt-front-end/veyra/blob/main/docs/PACKAGES.md) for scope ownership and release gates, and the [project documentation](https://github.com/iamzjt-front-end/veyra#development) for usage and development.

Product onboarding: `ve setup` once, `ve init` per Project, then ChatGPT → Veyra → Project → Bind. The CLI ships the experimental unpacked Chrome extension and a macOS/Linux Native Messaging host. Setup prints the extension directory and real native readiness; Chrome installation remains explicit. The host lazily starts the coordinator; diagnostics retain `ve daemon` and loopback pairing. Default init preserves existing config and binds native Codex without optional API agents. See [UX Flow](https://github.com/iamzjt-front-end/veyra/blob/main/docs/UX-FLOW.md).

On macOS, the Native Messaging host reuses enabled static system HTTP/HTTPS proxies when Chrome lacks explicit proxy environment variables. This keeps native Codex connected on machines whose browser uses a proxy configured in System Settings. The probe is local, runs once per host startup, preserves loopback/system bypass entries, and does not write global settings or read credentials. Explicit environment proxy choices take precedence; PAC and credential discovery are unsupported. Native execution has a bounded 15-minute ceiling; trusted verification checks retain separate deadlines. A timeout does not automatically retry the task.
