# Command execution safety

Veyra separates configured verification from an agent's own tool execution. Both can affect the host. Neither a successful agent claim nor an approval at one workflow node grants unrestricted permission to later operations.

## Command sources

| Source                                   | Execution path                             | Authority and evidence                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved workflow `command.run`             | Core → Verifier → Runtime → explicit shell | The operator trusts the configured workflow; `verification.started/completed.commandSource` is `workflow`. Results are deterministic exit/output evidence.      |
| Direct `ShellVerifier.verify` caller     | Verifier → Runtime → explicit shell        | The embedding application owns authorization; source is `caller` unless it explicitly identifies trusted workflow configuration.                                |
| Provider response or `commandsRun` claim | Agent result and context only              | Untrusted reported data. Core never turns these strings into verifier commands or a replacement workflow. They are not independent evidence that a command ran. |
| A native coding agent's tools            | Provider adapter → Runtime → native CLI    | Native provider permissions apply. Veyra does not intercept each tool call, parse every nested shell command or automatically approve native requests.          |

`ShellVerifier` accepts only `workflow` or `caller` as `commandSource`; an explicitly supplied provider/agent source is rejected before spawning. This label records the caller's provenance declaration, not a sandbox or authentication capability. Trusted in-process code can call the low-level runtime directly. Plugin code runs with the host's privileges and must be trusted separately.

Saved command arrays stay literal throughout Core scheduling and resume. Goals, routed inputs, planner instructions, reviewer fixes and provider command claims are never interpolated into them. A user may deliberately copy a proposed command into a workflow after reviewing it; that creates a new configured command, not an automatic execution path from model output.

## Shell and host permissions

`runProcess({ executable, args })` uses `shell: false`. Provider prompts travel as bounded stdin data or explicit native arguments; Core does not build shell commands from those prompts. Applications that need literal arguments should use this Runtime API with an argument array, and check exit status and cancellation.

Workflow `command.run` strings deliberately opt into shell syntax: `/bin/sh -c` on POSIX and `cmd.exe /d /s /c` on Windows. Operators author quoting, pipes, expansion and redirection in that configuration. Verifier does not quote the whole string into a different command or substitute Veyra context variables. Environment overrides are separate runtime values, never appended to command text. CLI verification output identifies these as workflow shell commands using host permissions.

Shell commands, project scripts, dependencies, Git hooks and native tools run as the invoking user with their inherited environment. A literal `pnpm test` can execute a project script that an agent has edited. A command-source label authenticates neither that script nor its transitive dependencies. Review the project and effective command implementation, keep credentials scoped, and use an independently enforced container/OS boundary when untrusted execution requires containment. [Worktrees](WORKSPACES.md) separate working files; they do not provide that containment.

## High-risk approval policy

Workflow authors must put an explicit human gate before operations whose intended effect includes deleting user data, rewriting shared Git history, publishing packages/releases, deploying to production, accessing or exporting credentials, creating paid resources, or expanding filesystem/network/permission scope beyond the agreed task. A broad goal, planner proposal, reviewer pass, retry or previous approval for another operation does not authorize these effects.

Use the existing declarative policy to protect a configured operation:

```yaml
version: 1
name: reviewed-deployment
start: verify
policy:
  approval:
    before: [deploy]
steps:
  verify:
    type: command
    run: [pnpm test]
    next: deploy
  deploy:
    type: command
    run: [./scripts/deploy.sh]
```

This example requires a project-owned deployment script and is not run by default tests. The workflow pauses before `deploy`; use `ve status` to inspect the pending operation and run evidence, review the script and target, then explicitly approve or reject the exact pending approval ID. Declining stops the protected operation. `--non-interactive` never supplies approval. Retry transitions back into a protected operation pass through its policy gate again. A gate before an agent authorizes only the reviewed task; the agent must still stop for additional native permissions or newly discovered high-risk work.

For a parallel/consensus group, gate the owning group before its children start; leaf policy gates inside a concurrently scheduled group are rejected by workflow validation. Nested workflows retain their own saved gates. An explicit `human` node is also available for project-specific decision messages and rejection branches. See [approvals](APPROVALS.md) and [execution policies](WORKFLOWS.md#workflow-execution-policies).

Policy-generated approvals include `context.operation` with the protected step ID/type and a literal configured-operation preview. Command previews identify `commandSource: workflow`; agent/group previews show declared bindings/instructions/children. Previews are capped at 8,192 characters and explicitly flag truncation. Inspect the full saved workflow and all referenced scripts/child steps before approving a truncated or indirect operation. CLI status renders this same saved context; future surfaces can consume it without reimplementing approval logic.

Risk classification is an authoring policy based on intended effects. Veyra enforces declared workflow gates; it does not claim a shell-risk classifier that can discover every destructive command or side effect. Ungated configured commands run as authorized workflow configuration. `approval.requiredFor` in project configuration remains reserved metadata and does not insert gates; use `policy.approval.before` or explicit human nodes for enforcement. Never rely on an unimplemented automatic classifier or a prompt instruction as a security boundary.

## Native permission visibility

An adapter may return `AgentDescriptor.permissions` with its declared invocation mode, source (`adapter-argument` or `native-configuration`), optional sandbox flag and optional count of explicit native tool allow rules. Core validates and persists this with `agent.selected`; `ve doctor --json` includes it in provider descriptors. Doctor and run text output render the known controls and explicitly state that additional native policy was not inspected. No credential/config files are read to guess effective permissions.

| Adapter     | Known invocation controls                                                  | Remaining native authority                                                                                                                                |
| ----------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI   | `--sandbox workspace-write`                                                | Approval mode is reported as unknown/native configuration; the adapter does not pass a bypass flag. Planned SDK mode declares no implemented permissions. |
| Claude Code | `--permission-mode default`; explicit `allowedTools` count when configured | Native rules, user/project policy and authentication still apply. Tool rule text is not copied into descriptor events.                                    |
| Gemini CLI  | `--approval-mode default`                                                  | Native policy and interactive permission requirements still apply.                                                                                        |
| OpenCode    | No permission override; mode reported as unknown/native configuration      | The native configuration determines access; headless permission rejection is normalized to `needs_input`.                                                 |

Missing permission metadata means undeclared, not unrestricted or safe. The mode describes flags Veyra supplies where known; it does not assert that every tool is allowed or prove a complete effective policy. A configuration-only or local readiness probe does not test permission to mutate a particular resource. Veyra never changes native permission mode in response to a rejected tool request. Surface the pause, review the native policy, and resume only after the operator resolves it.

Default tests use disposable fixtures and fake provider results. They verify command provenance, rejection before spawning, literal shell-text forwarding, non-execution of malicious-looking provider/goal strings, approval/rejection before a real fixture effect, bounded operation previews and native permission metadata matching existing adapter arguments. Real provider authorization remains subject to the separately recorded live-smoke blockers.
