# Platform support

Veyra's verified local targets are macOS and Linux with Node.js 22 and pnpm 10.15.1. CI runs the frozen install and all five baseline checks independently on `macos-15` (arm64) and `ubuntu-24.04` (x64), using explicit OS labels rather than a moving `latest` label. The [workflow](../.github/workflows/ci.yml) records the actual Node version and architecture. Runner images still receive updates; the [GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) describes their specifications.

The package engine remains `>=20`; that declaration does not mean every Node version or OS distribution has been tested. Use Node.js 22 for the verified baseline. Node.js 20 is upstream end-of-life; consult the [Node release schedule](https://nodejs.org/en/about/previous-releases) when selecting a maintained runtime. Intel macOS, ARM Linux, other Linux distributions and WSL2 do not yet have dedicated verification jobs. Provider executables have their own installation/platform requirements and live-smoke status; passing offline CI does not prove a provider login or live model call.

## Windows policy

Native Windows is **not currently a supported target**. Keep the isolated Windows implementations and their tests, but do not advertise end-to-end Windows support based on mocks. Current unit tests verify selection of `ComSpec`/`cmd.exe /d /s /c` and PID-scoped `taskkill.exe /T /F`, including failed tree cleanup. They do not verify native command quoting, npm `.cmd` shims, console signals, symlink privileges, filesystem durability or process descendants on Windows.

Before claiming native Windows support, add a Windows CI job with a frozen install and the full baseline, run real CLI cancellation and timeout against a child/grandchild tree, verify paths/drive roots and Git worktrees, exercise native provider executable discovery, and resolve or explicitly document platform-specific skips. Repository cleanup scripts currently use POSIX `rm`; WSL2 is a possible development environment, but it has not been verified here and is not a substitute for native Windows evidence.

## Execution and filesystem contracts

- Runtime invokes an executable and argument array with `shell: false`. Spaces, Unicode and shell punctuation in paths/arguments remain literal. Configure an actual executable; Runtime does not translate shell scripts or Windows batch shims automatically.
- Verifier deliberately executes trusted workflow shell text through `/bin/sh -c` on macOS/Linux. It does not select the user's interactive `$SHELL`; Bash/Zsh extensions, aliases and startup files are not portable workflow commands. Use quoted paths and Node scripts for logic that must run unchanged across hosts. Command output is evidence, never a source of new executable commands.
- macOS/Linux cancellation uses a separate process group: SIGTERM, a bounded grace period, then SIGKILL. Tests cover a leader exiting before a descendant, ignored SIGTERM, repeated CLI signals, timeouts and persisted cancellation reasons. A descendant creating a separate session can escape this group. Windows uses forceful tree termination and has no equivalent graceful-signal guarantee. See [cancellation](CANCELLATION.md) and [Runtime](RUNTIME.md).
- State and worktrees use Node path APIs and canonical paths; tests cover spaces/Unicode, subdirectories, symlink refusal, leases, atomic records and process-death recovery. The supported storage boundary is a local filesystem under a cooperating OS user. Directory sync is performed on POSIX; the Windows branch omits it. Network filesystems and cross-host locking are outside the [locking contract](LOCKING.md).

## Reproducing verification

From a checkout on either verified target:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm check
pnpm test
pnpm build
```

Use the recorded Corepack version in the workflow if your installed Corepack cannot verify the pinned pnpm release. The default suite uses fake providers and isolated temporary workspaces, including real shell, Git and process-tree checks. See [testing conventions](TESTING.md) and the per-task evidence in [TODO](TODO.md#m69--cross-platform-support).
