import type { JsonValue } from "./index.js";
import {
  isProjectHandoff,
  isProjectExecutionResult,
  isProjectReview,
  MAX_PROJECT_ENVELOPE_BYTES,
  type ProjectHandoff,
  type ProjectExecutionResult,
  type ProjectReview,
} from "./project-state.js";

export type ProjectInterchange = ProjectHandoff | ProjectExecutionResult | ProjectReview;
export class ProjectEnvelopeError extends Error {
  readonly code = "invalid_project_envelope";
  constructor() {
    super("Invalid, unsupported or oversized Project interchange envelope.");
  }
}
function validate(value: unknown): asserts value is ProjectInterchange {
  if (!isProjectHandoff(value) && !isProjectExecutionResult(value) && !isProjectReview(value))
    throw new ProjectEnvelopeError();
}
function ordered(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(ordered);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key] as JsonValue)]),
    );
  return value;
}
/** Sort object keys, preserve ordered tasks/lists, validate before invoking any serialization. */
export function serializeProjectEnvelope(value: unknown): string {
  validate(value);
  return JSON.stringify(ordered(value as unknown as JsonValue));
}
export function parseProjectEnvelope(source: string): ProjectInterchange {
  if (
    typeof source !== "string" ||
    new TextEncoder().encode(source).length > MAX_PROJECT_ENVELOPE_BYTES
  )
    throw new ProjectEnvelopeError();
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new ProjectEnvelopeError();
  }
  validate(value);
  return value;
}
