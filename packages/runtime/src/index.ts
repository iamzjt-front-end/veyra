import type { AgentAdapter, AgentInput, AgentResult, AgentRunOptions } from "@veyra/protocol";
export { createDeadline } from "./deadline.js";

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
