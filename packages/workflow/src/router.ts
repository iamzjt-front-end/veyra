import type { JsonValue } from "@veyra/protocol";
import { resolveNextStep, type WorkflowStep } from "./index.js";

export class RouterError extends Error {
  constructor(
    readonly code: "invalid_route" | "unmatched_route",
    message: string,
  ) {
    super(message);
    this.name = "RouterError";
  }
}

export interface RouteDecision {
  route: string;
  target: string;
  selection: "static" | "input";
}

/** Select only a configured destination; labels never become executable step IDs or code. */
export function resolveRoute(step: WorkflowStep, selected?: JsonValue): RouteDecision {
  const route = typeof step.route === "string" ? step.route : selected;
  if (
    step.type !== "router" ||
    typeof route !== "string" ||
    !route.trim() ||
    [...route].length > 128
  )
    throw new RouterError(
      "invalid_route",
      "Router selection must be a non-empty string of at most 128 characters.",
    );
  const target = resolveNextStep(step, { status: route });
  if (!target)
    throw new RouterError(
      "unmatched_route",
      "Router selection has no declared matching route or next fallback.",
    );
  return { route, target, selection: typeof step.route === "string" ? "static" : "input" };
}
