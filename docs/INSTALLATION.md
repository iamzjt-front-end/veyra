# Installation

Veyra's public CLI is `ve`, supplied by `@veyraoss/cli`. The official packages are currently **unpublished release candidates**. Use a source checkout today; the registry commands below become available after the first explicitly approved public release. Local installation verification does not publish anything.

## Requirements

- Node.js >=20 as declared by the packages; CI verifies Node.js 22 on macOS and Linux. See the [platform policy](PLATFORMS.md) for exact targets and the unsupported native Windows status.
- npm for global installation. The standard verification presets use pnpm; development pins pnpm 10.15.1. Enable pnpm with `corepack enable` when Corepack is available, or follow [pnpm installation](https://pnpm.io/10.x/installation).
- Install and authenticate native coding-agent CLIs separately when your workflow needs them. API agents use environment variables. See [authentication](AUTHENTICATION.md); installing Veyra does not install provider executables or grant model access.

## Use the checkout now

Follow the [development setup](../README.md#development), then run:

```sh
pnpm ve -- version
pnpm ve -- doctor
pnpm ve -- setup
```

From a project folder, run `node /absolute/path/to/veyra/apps/cli/dist/index.js init` once to register it and bind native Codex. In the checkout itself use `pnpm ve -- init`. Default init preserves existing configuration. `ve init --config` / `--workflow` / `--model` retain explicit optional-workflow initialization; `--force` is an explicit replacement. Follow [UX Flow](UX-FLOW.md) and the [native browser guide](../apps/chatgpt-extension/README.md#native-messaging-产品流程). See the [CLI reference](CLI.md).

## Install after the first approved release

```sh
npm install --global @veyraoss/cli@latest
ve version
ve doctor
ve setup
```

This installs the `ve` executable and its exact-version official dependencies. There is no `veyra` executable. Run `ve setup` once, then `ve init` in each project and bind it explicitly in ChatGPT. Native Codex uses its existing login; optional API-provider credentials are not required. Doctor reports missing pnpm with setup guidance and a missing configuration with `ve init` guidance. Providers are optional until a project workflow requires them. A missing explicit `--config` is an error. Checks do not create configuration/run state, install tools or make a model request; native providers may perform bounded local version/authentication probes.

If the shell cannot find `ve`, inspect `npm prefix --global` and put its `bin` directory on `PATH` on macOS/Linux. For npm permission errors, use a user-managed Node installation or user-owned prefix as described in [npm's global installation guide](https://docs.npmjs.com/downloading-and-installing-packages-globally/).

## Upgrade and uninstall

After releases are available, upgrade to the current stable version with:

```sh
npm install --global @veyraoss/cli@latest
ve version
ve doctor
```

For reproducibility, replace `latest` with an exact published version. Read the [changelog](../CHANGELOG.md) and [version compatibility policy](VERSIONING.md) first. Built-in packages upgrade as a fixed set; update explicit plugin version pins in project configuration accordingly. Before upgrading a paused run, check the release's state/protocol compatibility notes. Installation does not migrate saved runs automatically.

To remove the global CLI:

```sh
npm uninstall --global @veyraoss/cli
```

Project `veyra.yaml`, `.veyra/` history and separately installed native agents remain in place. See [npm uninstall](https://docs.npmjs.com/uninstalling-packages-and-dependencies/) and Veyra's [history retention](ARTIFACTS-RETENTION.md) for separate management of local run data.

Homebrew distribution is deferred until the public npm installation path is stable. There is no official tap or formula yet.

## Verify installation without publishing

From the checkout:

```sh
pnpm installation:check
```

This builds and packs all fourteen release candidates, then uses real npm to install those tarballs together into a disposable global prefix outside the repository. Supplying the complete local package set permits installation before registry publication. The script checks `ve version`, all four bundled presets and doctor output with no pnpm/provider executables on the test `PATH`. It then installs pnpm 10.15.1 into that same temporary prefix, verifies readiness, uninstalls the packages and checks that the `ve` link is gone. Configuration and run state must remain absent throughout.

This separate check needs public npm registry access for third-party dependencies and pnpm. It does not load npm credentials or provider environment variables, invoke package publication, or modify the user's global prefix. Its temporary prefix, cache, configuration and consumer are removed even on failure. Default `pnpm test` remains offline with respect to providers and npm; its [tarball tests](TESTING.md#end-to-end-cli-scenarios) check package contents and isolated imports independently.
