export class ExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const fatalExecutionCodes = new Set([
  "run_cancelled",
  "event_sink_failed",
  "transition_limit",
  "failure_policy_stop",
  "budget_exceeded",
  "budget_hook_failed",
  "missing_budget_hook",
]);
