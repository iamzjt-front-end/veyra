import type { AgentInput, JsonValue, SerializedError } from "../src/index.js";

// Compiled by pnpm check; these deliberately invalid assignments never execute.
export function rejectedContractValues(input: AgentInput) {
  // @ts-expect-error Functions cannot cross the persisted JSON boundary.
  const callback: JsonValue = () => "invalid";
  // @ts-expect-error Native errors do not provide the stable error code contract.
  const error: SerializedError = new Error("invalid");
  // @ts-expect-error Cancellation belongs in AgentRunOptions, never persisted input.
  const signal: AgentInput = { ...input, signal: new AbortController().signal };
  return { callback, error, signal };
}
