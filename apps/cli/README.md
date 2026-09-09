# @veyraoss/cli

The Veyra command-line application, exposed as ve.

This package is a release candidate in the Veyra monorepo; it is not published yet. See the [installation guide](https://github.com/iamzjt-front-end/veyra/blob/main/docs/INSTALLATION.md) for setup, upgrades, removal and isolated npm installation verification, the [package strategy](https://github.com/iamzjt-front-end/veyra/blob/main/docs/PACKAGES.md) for scope ownership and release gates, and the [project documentation](https://github.com/iamzjt-front-end/veyra#development) for usage and development.

Product onboarding: `ve setup` once, `ve init` per Project, then ChatGPT → Veyra → Project → Bind. The CLI ships the experimental unpacked Chrome extension and a macOS/Linux Native Messaging host. Setup prints the extension directory and real native readiness; Chrome installation remains explicit. The host lazily starts the coordinator; diagnostics retain `ve daemon` and loopback pairing. Default init preserves existing config and binds native Codex without optional API agents. See [UX Flow](https://github.com/iamzjt-front-end/veyra/blob/main/docs/UX-FLOW.md).
