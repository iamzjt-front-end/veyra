import type { AgentAdapter, AgentInput, AgentResult } from "@veyra/protocol";

export interface AgentRuntime {
  runAgent(adapter: AgentAdapter, input: AgentInput): Promise<AgentResult>;
}

/**
 * Minimal runtime boundary for v0.1.
 *
 * Process spawning, cancellation, timeout handling, stream forwarding, and
 * working-directory isolation will be implemented here rather than in core.
 */
export class LocalAgentRuntime implements AgentRuntime {
  async runAgent(adapter: AgentAdapter, input: AgentInput): Promise<AgentResult> {
    return adapter.run(input);
  }
}
