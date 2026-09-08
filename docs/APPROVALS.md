# Human approval gates

A `human` workflow node pauses execution before its successor. Core persists `approval.required` with a unique approval ID, the step's message, bounded prior context, and attempt identity, followed by paused run state and `run.paused`. The process can exit at this completed pause boundary.

```yaml
gate:
  type: human
  message: Approve the proposed change
  on:
    approved: execute
    rejected: declined

execute:
  type: agent
  agent: executor
  next: done

declined:
  type: end

done:
  type: end
```

The declaration supplies workflow step entries; the full document also needs `name`, `version`, and `start`. The explicit rejection branch in this example completes the declined path without executing the change.

## Core control API

```ts
const request = { runId, config, cwd: projectDirectory };
const pending = await engine.getPendingApproval(request);
// Show pending.message and pending.context to the user and obtain an explicit decision.
await engine.resolveApproval({
  ...request,
  approvalId: pending.approvalId,
  decision: userDecision, // "approved" or "rejected"
  comment: userComment,
});
// If the result is still paused, continue with the caller's already-created adapters.
const result = await engine.resume({ ...request, agents });
```

`getPendingApproval()` is read-only and returns the current ID, step, message, request timestamp, and context, or `null`. UI/API callers must require an explicit human decision. A plain `resume` refuses an unresolved gate; provider output cannot resolve it.

`resolveApproval()` requires the exact pending ID, validates the decision and optional comment (maximum 8 KiB), then saves `approval.resolved` and step completion with the decision. It advances to the approved/rejected target while keeping execution paused. It never starts an adapter or command. A subsequent `resume` performs execution from the saved successor; prior completed steps are not repeated. Approval and comment evidence is included in later bounded context.

For approval, an explicit `on.approved` wins over `next`; an approved leaf completes the run. Rejection requires an explicit `on.rejected` branch. Without one, rejection fails the run with `approval_rejected`, even if `next` exists. An approved branch with no matching route fails with `unhandled_approval`. Each newly entered gate gets a fresh ID; stale, duplicate, and mismatched decisions are refused.

Decisions are auditable through ID, run/step/attempt, decision, timestamp, and optional redacted comment. Approval does not reset retry budgets. A retry-exhaustion gate can route to a separate manual-resolution path, but approving it cannot silently replenish the exhausted step's budget.

## Boundaries

Workflow `policy.approval.before` lists standalone step IDs that require approval before each invocation. The Workflow graph compiles these into ordinary `human` gates with stable `@approval/<id>` identifiers (escaped inside child scopes). Every incoming control-flow edge and the workflow start pass through the gate; resolving it resumes the protected step while retaining the incoming repair outcome. Re-entering through a loop or resuming a protected agent after `needs_input` requires a fresh approval ID. Resuming an already approved pending group/subworkflow retains that invocation's approval. Rejection fails that scope without invoking the step. Approve a parallel/consensus group rather than an owned child. Explicit gate nodes remain available for custom messages or rejection branches. Generated-ID collisions are rejected before execution.

Gates inside subworkflows use qualified IDs such as `suite/gate` and the same approval API. Resolving a terminal child gate leaves the containing run paused; resume closes that child scope and follows the parent's success/failure branch. An unhandled child rejection becomes child failure and requires an explicit parent `on.failure` to recover. No provider executes during decision recording, and completed child work is retained across resume.

The same Core API serves CLI, TUI, and Dashboard. Config `approval.requiredFor` remains reserved for later operation-policy work; it does not automatically classify arbitrary provider commands. Use explicit `human` nodes or workflow `policy.approval.before` for step-level guarantees. Installed coding agents retain their own command/sandbox permission system.

Competing decisions are serialized within one engine instance. The existing single-writer boundary still applies across engines/processes; project locking is a later hardening task. Decision events and the new state are persisted before subscriber notification. If notification fails, `approval_recorded_notification_failed` tells the caller that the decision is already saved; refresh state instead of resubmitting it.

State and events are separate durable writes. An interruption inside approval resolution may leave an incomplete control boundary that requires inspection; Core refuses a missing final pause boundary rather than replaying the gated action. Automated reconciliation of partially written transitions remains the crash-recovery TODO. Approval histories without IDs or with inconsistent required/resolved pairs are refused.

Integration tests cover approve/resume, rejection branches, rejection without a branch, consecutive gates, stale/duplicate decisions, competing submissions, comment redaction, subscriber failure, and a real fixture action after a separate writer process exits at its gate.

Policy-generated gates now include a bounded `context.operation` preview of the protected command/agent/group. CLI status shows it with the saved approval. `truncated: true` means the full saved workflow and referenced scripts must be inspected before a decision. The [command safety policy](COMMAND-SAFETY.md) defines high-risk effects, source boundaries and native permission limits.
