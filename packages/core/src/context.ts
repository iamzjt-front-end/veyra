import type { ArtifactRef, JsonObject, JsonValue, StepOutput, VeyraEvent } from "@veyra/protocol";
import { resolveStepInputs, type StepInputReference } from "@veyra/workflow";

/** Recent outputs only; complete evidence remains in the persisted event log. */
export class RunContext {
  readonly #steps = new Map<string, JsonObject>();
  readonly #artifacts = new Map<string, ArtifactRef>();
  #omittedSteps = 0;
  #omittedArtifacts = 0;
  readonly #referencedSteps: Set<string>;
  readonly #outputs = new Map<string, JsonObject>();

  constructor(referencedSteps: Iterable<string> = []) {
    this.#referencedSteps = new Set(referencedSteps);
  }

  addEvent(event: VeyraEvent) {
    if (event.type === "agent.completed") {
      const result = event.result;
      this.add(
        event.stepId,
        {
          type: "agent",
          outcome: result.status === "success" ? (result.outcome ?? "success") : result.status,
          summary: result.summary,
          ...(result.data ? { data: result.data } : {}),
          ...(result.artifacts ? { artifacts: result.artifacts as unknown as JsonValue[] } : {}),
        },
        result.artifacts,
      );
    } else if (event.type === "verification.completed") {
      const output: StepOutput = {
        type: "command",
        outcome: event.success ? "success" : "failure",
        results: event.results,
        artifacts: event.results.flatMap((item) => item.artifacts ?? []),
      };
      this.add(event.stepId, output as unknown as JsonObject, output.artifacts);
    } else if (event.type === "approval.resolved") {
      this.add(event.stepId, {
        type: "human",
        outcome: event.decision,
        ...(event.comment !== undefined ? { comment: event.comment } : {}),
      });
    }
  }

  add(stepId: string, value: JsonObject, artifacts: ArtifactRef[] = []) {
    // Only explicitly referenced step outputs survive the recent-context eviction window.
    if (this.#referencedSteps.has(stepId)) this.#outputs.set(stepId, structuredClone(value));
    this.#steps.delete(stepId);
    this.#steps.set(stepId, compact(value));
    while (this.#steps.size > 8) {
      this.#steps.delete(this.#steps.keys().next().value as string);
      this.#omittedSteps++;
    }
    for (const artifact of artifacts) {
      if (Buffer.byteLength(JSON.stringify(artifact)) > 1024) {
        this.#omittedArtifacts++;
        continue;
      }
      this.#artifacts.delete(artifact.id);
      this.#artifacts.set(artifact.id, structuredClone(artifact));
      while (this.#artifacts.size > 16) {
        this.#artifacts.delete(this.#artifacts.keys().next().value as string);
        this.#omittedArtifacts++;
      }
    }
  }

  input(references?: Record<string, StepInputReference>): {
    context: JsonObject;
    artifacts: ArtifactRef[];
  } {
    // Include escaped keys/strings in the actual byte budget, not just raw string lengths.
    while (Buffer.byteLength(JSON.stringify(Object.fromEntries(this.#steps))) > 48 * 1024) {
      this.#steps.delete(this.#steps.keys().next().value as string);
      this.#omittedSteps++;
    }
    return structuredClone({
      context: {
        steps: Object.fromEntries(this.#steps),
        omittedSteps: this.#omittedSteps,
        omittedArtifacts: this.#omittedArtifacts,
        ...(references
          ? { inputs: resolveStepInputs(references, (id) => this.#outputs.get(id)) }
          : {}),
      },
      artifacts: [...this.#artifacts.values()],
    });
  }
}

function compact(value: JsonObject): JsonObject {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) <= 6144) return structuredClone(value);
  const result: JsonObject = { truncated: true };
  for (const field of ["type", "outcome", "summary"]) {
    const item = value[field];
    if (typeof item === "string") result[field] = excerpt(item, 512);
  }
  // Quote an excerpt explicitly instead of silently truncating a structured value in place.
  result.preview = excerpt(json, 3072);
  return result;
}

function excerpt(value: string, bytes: number): string {
  return Buffer.byteLength(value) <= bytes
    ? value
    : `${Buffer.from(value).subarray(0, bytes).toString("utf8")}…`;
}
