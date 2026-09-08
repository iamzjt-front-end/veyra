import type { AgentAdapter, AgentInput, AgentResult } from "@veyraoss/protocol";

/** Test-only adapter: records inputs and returns a fresh copy of a fixed response. */
export class FakeAgent implements AgentAdapter {
  readonly provider = "fake";
  readonly calls: AgentInput[] = [];
  readonly #result: AgentResult;

  constructor(
    result: AgentResult,
    readonly id = "fake-agent",
  ) {
    this.#result = structuredClone(result);
  }

  async run(input: AgentInput): Promise<AgentResult> {
    this.calls.push(structuredClone(input));
    return structuredClone(this.#result);
  }
}
