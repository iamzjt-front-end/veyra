import type { JsonObject } from "@veyra/protocol";
import { resolveRoute } from "@veyra/workflow";
import { ExecutionError } from "./execution-error.js";
import type { LeafOptions, LeafResult } from "./leaf.js";

export async function executeRouter(options: LeafOptions): Promise<LeafResult> {
  const { step, execution, context, record } = options;
  const reference = step.route && typeof step.route !== "string" ? step.route : undefined;
  const inputs = reference
    ? (context.input({ route: reference }).context.inputs as JsonObject)
    : undefined;
  const decision = resolveRoute(step, inputs?.route);
  const saved = await record({
    type: "router.selected",
    ...execution,
    ...decision,
    ...(reference ? { source: { stepId: reference.from, path: reference.path } } : {}),
    at: new Date().toISOString(),
  });
  if (saved.type !== "router.selected")
    throw new ExecutionError("invalid_event", "Stored router event type changed.");
  context.addEvent(saved);
  return { outcome: saved.route, outputEvent: saved };
}
