import type { AgentAdapter, AgentInput, AgentResult } from "@veyra/protocol";

export interface CodexAdapterOptions {
  mode?: "cli" | "sdk";
  workingDirectory?: string;
}

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex";
  readonly provider = "codex";

  constructor(readonly options: CodexAdapterOptions = {}) {}

  async run(_input: AgentInput): Promise<AgentResult> {
    throw new Error(
      `CodexAdapter(${this.options.mode ?? "cli"}) is scaffolded but not connected yet.`,
    );
  }
}
