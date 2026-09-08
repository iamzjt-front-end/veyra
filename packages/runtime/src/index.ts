import type { AgentAdapter, AgentInput, AgentResult, AgentRunOptions } from "@veyraoss/protocol";
export { createDeadline } from "./deadline.js";
export { readProjectInstructions } from "./project-instructions.js";
export { acquireLocalLock, LocalLockError, type LocalLockOptions, type LocalLock } from "./lock.js";
export {
  currentProcessOwner,
  inspectProcessOwner,
  isProcessOwner,
  type ProcessOwner,
  type ProcessLiveness,
} from "./owner.js";
export {
  LocalWorkspaceManager,
  type PreparedWorkspace,
  type WorkspacePolicy,
} from "./workspace.js";
export { WorkspaceError, type WorkspaceLease } from "./workspace-lease.js";
export {
  collectSecretValues,
  createSecretRedactor,
  isSecretField,
  type SecretRedactor,
} from "./secrets.js";

export interface AgentRuntime {
  runAgent(
    adapter: AgentAdapter,
    input: AgentInput,
    options?: AgentRunOptions,
  ): Promise<AgentResult>;
}

/** Adapters receive ephemeral controls and use the appropriate process or API lifecycle. */
export class LocalAgentRuntime implements AgentRuntime {
  async runAgent(
    adapter: AgentAdapter,
    input: AgentInput,
    options?: AgentRunOptions,
  ): Promise<AgentResult> {
    return adapter.run(input, options);
  }
}

export {
  DEFAULT_MAX_OUTPUT_BYTES,
  ProcessExecutionError,
  type ProcessRequest,
  type ProcessResult,
  type ProcessRunner,
  runProcess,
} from "./process.js";
