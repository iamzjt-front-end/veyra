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
  readonly #workflowInputs?: JsonObject;

  constructor(referencedSteps: Iterable<string> = [], workflowInputs?: JsonObject) {
    this.#referencedSteps = new Set(referencedSteps);
    this.#workflowInputs =
      workflowInputs === undefined ? undefined : structuredClone(workflowInputs);
  }

  /** Replay joined child outputs in declaration order, independent of completion timing. */
  restore(events: readonly VeyraEvent[]): void {
    const byId = new Map(events.map((event) => [event.eventId, event]));
    for (const event of events) {
      if ("parentStepId" in event && event.parentStepId !== undefined) continue;
      if (event.type === "parallel.completed" || event.type === "parallel.paused") {
        for (const child of event.results) {
          const output = child.outputEventId ? byId.get(child.outputEventId) : undefined;
          if (output) this.addEvent(output);
        }
      }
      this.addEvent(event);
    }
  }

  fork(): RunContext {
    const copy = new RunContext(this.#referencedSteps, this.#workflowInputs);
    // Values are private immutable snapshots; input() clones before exposing them.
    for (const [key, value] of this.#steps) copy.#steps.set(key, value);
    for (const [key, value] of this.#outputs) copy.#outputs.set(key, value);
    for (const [key, value] of this.#artifacts) copy.#artifacts.set(key, value);
    copy.#omittedSteps = this.#omittedSteps;
    copy.#omittedArtifacts = this.#omittedArtifacts;
    return copy;
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
    } else if (event.type === "subworkflow.completed") {
      this.add(event.stepId, {
        type: "subworkflow",
        outcome: event.success ? "success" : "failure",
        ...(event.outputs ? { outputs: event.outputs } : {}),
        ...(event.error ? { error: event.error as unknown as JsonObject } : {}),
      });
    } else if (event.type === "router.selected") {
      this.add(event.stepId, {
        type: "router",
        outcome: event.route,
        target: event.target,
        selection: event.selection,
      });
    } else if (event.type === "parallel.completed") {
      const output: StepOutput = {
        type: "parallel",
        outcome: event.success ? "success" : "failure",
        results: event.results,
      };
      this.add(event.stepId, output as unknown as JsonObject);
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
        ...(this.#workflowInputs !== undefined ? { workflowInputs: this.#workflowInputs } : {}),
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
