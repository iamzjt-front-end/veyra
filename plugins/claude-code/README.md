# @veyra/claude-code

Status: **implemented and deterministically verified; live smoke blocked by native provider request timeouts**. See [M4.4](../../docs/TODO.md#m44--claude-code-executor) for evidence and the unblock command.

Executor adapter for the installed Claude Code CLI, with native authentication, structured JSON results and permission-denial handling. Process lifecycle, streams, cancellation, timeout, and working-directory concerns belong in `@veyra/runtime`.

See [configuration, permissions and smoke testing](../../docs/CLAUDE-CODE.md). The default tests use an injected runtime and require no login or network.
