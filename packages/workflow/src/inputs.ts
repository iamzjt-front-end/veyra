import { isJsonValue, type JsonObject, type JsonValue } from "@veyra/protocol";
import type { StepInputReference } from "./index.js";

export const MAX_RESOLVED_INPUT_BYTES = 32 * 1024;
export class InputResolutionError extends Error {
  constructor(
    readonly code: "input_unavailable" | "input_too_large" | "invalid_input_reference",
    message: string,
  ) {
    super(message);
    this.name = "InputResolutionError";
  }
}

/** RFC 6901 only: no expressions, interpolation, wildcards, environment or filesystem lookup. */
export function pointerSegments(pointer: string): string[] {
  if (
    typeof pointer !== "string" ||
    [...pointer].length > 1024 ||
    (pointer !== "" && !pointer.startsWith("/")) ||
    /~(?:[^01]|$)/u.test(pointer)
  )
    throw new InputResolutionError(
      "invalid_input_reference",
      "Input path must be an RFC 6901 JSON Pointer of at most 1024 characters.",
    );
  const segments =
    pointer === ""
      ? []
      : pointer
          .slice(1)
          .split("/")
          .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (segments.length > 32)
    throw new InputResolutionError("invalid_input_reference", "Input path exceeds 32 segments.");
  return segments;
}

/** Preserve JSON types and fail explicitly rather than passing unresolved/truncated references. */
export function resolveStepInputs(
  references: Record<string, StepInputReference>,
  outputFor: (stepId: string) => JsonValue | undefined,
): JsonObject {
  const entries = Object.entries(references);
  if (entries.length > 16)
    throw new InputResolutionError(
      "invalid_input_reference",
      "A step can bind at most 16 named inputs.",
    );
  const resolved: [string, JsonValue][] = [];
  for (const [name, reference] of entries) {
    let value = outputFor(reference.from);
    if (!isJsonValue(value))
      throw new InputResolutionError(
        "input_unavailable",
        `Input '${name}' requires a persisted output from step '${reference.from}'.`,
      );
    for (const segment of pointerSegments(reference.path)) {
      if (
        value === null ||
        typeof value !== "object" ||
        (Array.isArray(value) && !/^(?:0|[1-9][0-9]*)$/.test(segment)) ||
        !Object.hasOwn(value, segment)
      )
        throw new InputResolutionError(
          "input_unavailable",
          `Input '${name}' cannot resolve its path in step '${reference.from}'.`,
        );
      value = (value as JsonObject)[segment] as JsonValue;
    }
    resolved.push([name, value]);
    if (Buffer.byteLength(JSON.stringify(Object.fromEntries(resolved))) > MAX_RESOLVED_INPUT_BYTES)
      throw new InputResolutionError(
        "input_too_large",
        "Resolved step inputs exceed 32 KiB; select a smaller field or an artifact reference.",
      );
  }
  return structuredClone(Object.fromEntries(resolved));
}
