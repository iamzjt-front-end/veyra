# @veyraoss/claude-code

Status: **implemented and deterministically verified; live smoke blocked by native provider request timeouts**. See [M4.4](https://github.com/iamzjt-front-end/veyra/blob/main/docs/TODO.md#m44--claude-code-executor) for evidence and the unblock command.

Executor adapter for the installed Claude Code CLI, with native authentication, structured JSON results and permission-denial handling. Process lifecycle, streams, cancellation, timeout, and working-directory concerns belong in `@veyraoss/runtime`.

See [configuration, permissions and smoke testing](https://github.com/iamzjt-front-end/veyra/blob/main/docs/CLAUDE-CODE.md). The default tests use an injected runtime and require no login or network.

This package is a release candidate and is not published yet. See the [package strategy](https://github.com/iamzjt-front-end/veyra/blob/main/docs/PACKAGES.md).
