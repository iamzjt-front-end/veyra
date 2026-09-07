import type { AgentAdapter, AgentInput, AgentResult } from "@veyra/protocol";

export interface OpenAIAdapterOptions {
  model: string;
}

export class OpenAIAdapter implements AgentAdapter {
  readonly id = "openai";
  readonly provider = "openai";

  constructor(readonly options: OpenAIAdapterOptions) {}

  async run(_input: AgentInput): Promise<AgentResult> {
    throw new Error(
      `OpenAIAdapter(${this.options.model}) is scaffolded but not connected yet. Implement via the OpenAI Responses API.`,
    );
  }
}
