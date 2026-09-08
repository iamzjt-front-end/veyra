import type {
  ArtifactRef,
  JsonObject,
  JsonValue,
  StepOutput,
  VeyraEvent,
  EvidenceReference,
  ContextProvenance,
} from "@veyra/protocol";
import { resolveStepInputs, type StepInputReference } from "@veyra/workflow";

/** Recent outputs only; complete evidence remains in the persisted event log. */
export class RunContext {
  readonly #steps = new Map<string, JsonObject>();
  readonly #artifacts = new Map<string, ArtifactRef>();
  readonly #artifactSteps = new Map<string, string>();
  #omittedSteps = 0;
  #omittedArtifacts = 0;
  readonly #referencedSteps: Set<string>;
  readonly #outputs = new Map<string, JsonObject>();
  readonly #workflowInputs?: JsonObject;
  readonly #origins = new Map<string, EvidenceReference>();
  readonly #artifactOrigins = new Map<string, EvidenceReference>();
  readonly #workflowOrigin?: EvidenceReference;

  constructor(
    referencedSteps: Iterable<string> = [],
    workflowInputs?: JsonObject,
    workflowOrigin?: EvidenceReference,
  ) {
    this.#referencedSteps = new Set(referencedSteps);
    this.#workflowInputs =
      workflowInputs === undefined ? undefined : structuredClone(workflowInputs);
    this.#workflowOrigin =
      workflowOrigin === undefined ? undefined : structuredClone(workflowOrigin);
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
      if (event.type === "consensus.completed" && event.judge?.outputEventId) {
        const output = byId.get(event.judge.outputEventId);
        if (output) this.addEvent(output);
      }
      this.addEvent(event);
    }
  }

  fork(excludedSteps: readonly string[] = []): RunContext {
    const excluded = new Set(excludedSteps);
    const copy = new RunContext(this.#referencedSteps, this.#workflowInputs, this.#workflowOrigin);
    // Values are private immutable snapshots; input() clones before exposing them.
    for (const [key, value] of this.#steps) if (!excluded.has(key)) copy.#steps.set(key, value);
    for (const [key, value] of this.#outputs) if (!excluded.has(key)) copy.#outputs.set(key, value);
    for (const [key, value] of this.#origins) if (!excluded.has(key)) copy.#origins.set(key, value);
    for (const [key, value] of this.#artifacts)
      if (!excluded.has(this.#artifactSteps.get(key) ?? "")) {
        copy.#artifacts.set(key, value);
        copy.#artifactSteps.set(key, this.#artifactSteps.get(key) as string);
        const origin = this.#artifactOrigins.get(key);
        if (origin) copy.#artifactOrigins.set(key, origin);
      }
    copy.#omittedSteps = this.#omittedSteps;
    copy.#omittedArtifacts = this.#omittedArtifacts;
    return copy;
  }

  addEvent(event: VeyraEvent) {
    const origin = evidenceReference(event, "");
    if (origin) this.#origins.set(origin.stepId, origin);
    if (event.type === "agent.completed") {
      const result = event.result;
      const artifacts = [...(result.artifacts ?? []), ...(event.payload ? [event.payload] : [])];
      this.add(
        event.stepId,
        {
          type: "agent",
          outcome: result.status === "success" ? (result.outcome ?? "success") : result.status,
          summary: result.summary,
          ...(result.data ? { data: result.data } : {}),
          ...(artifacts.length ? { artifacts: artifacts as unknown as JsonValue[] } : {}),
        },
        artifacts,
      );
    } else if (event.type === "verification.completed") {
      const output: StepOutput = {
        type: "command",
        outcome: event.success ? "success" : "failure",
        results: event.results,
        artifacts: [
          ...event.results.flatMap((item) => item.artifacts ?? []),
          ...(event.payload ? [event.payload] : []),
        ],
      };
      this.add(event.stepId, output as unknown as JsonObject, output.artifacts);
    } else if (event.type === "consensus.completed") {
      this.add(event.stepId, {
        type: "consensus",
        outcome: event.outcome,
        mode: event.mode,
        ...(event.quorum !== undefined ? { quorum: event.quorum } : {}),
        reviews: event.reviews as unknown as JsonValue[],
        verification: event.verification as unknown as JsonValue[],
        ...(event.judge ? { judge: event.judge as unknown as JsonObject } : {}),
        ...(event.reason ? { reason: event.reason } : {}),
      });
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
    for (const id of this.#origins.keys())
      if (!this.#steps.has(id) && !this.#referencedSteps.has(id)) this.#origins.delete(id);
    for (const artifact of artifacts) {
      if (Buffer.byteLength(JSON.stringify(artifact)) > 1024) {
        this.#omittedArtifacts++;
        continue;
      }
      this.#artifacts.delete(artifact.id);
      this.#artifacts.set(artifact.id, structuredClone(artifact));
      this.#artifactSteps.set(artifact.id, stepId);
      const origin = this.#origins.get(stepId);
      if (origin) this.#artifactOrigins.set(artifact.id, origin);
      else this.#artifactOrigins.delete(artifact.id);
      while (this.#artifacts.size > 16) {
        const oldest = this.#artifacts.keys().next().value as string;
        this.#artifacts.delete(oldest);
        this.#artifactSteps.delete(oldest);
        this.#artifactOrigins.delete(oldest);
        this.#omittedArtifacts++;
      }
    }
  }

  source(stepId: string, path: string): EvidenceReference | undefined {
    const origin = this.#origins.get(stepId);
    return origin ? { ...origin, path } : undefined;
  }

  input(
    references?: Record<string, StepInputReference>,
    additional: EvidenceReference[] = [],
  ): {
    context: JsonObject;
    artifacts: ArtifactRef[];
  } {
    // Include escaped keys/strings in the actual byte budget, not just raw string lengths.
    while (Buffer.byteLength(JSON.stringify(Object.fromEntries(this.#steps))) > 48 * 1024) {
      this.#steps.delete(this.#steps.keys().next().value as string);
      this.#omittedSteps++;
    }
    const provenance: ContextProvenance = {
      version: 1,
      contentTrust: "untrusted",
      evidence: [],
      unknownPaths: [],
      omitted: 0,
    };
    const include = (path: string, origin?: EvidenceReference) => {
      const ref = origin ? { ...origin, path } : undefined;
      if (
        Buffer.byteLength(JSON.stringify(ref ?? path)) > 1024 ||
        Buffer.byteLength(JSON.stringify(provenance)) +
          Buffer.byteLength(JSON.stringify(ref ?? path)) >
          16 * 1024 ||
        provenance.evidence.length + provenance.unknownPaths.length >= 128
      ) {
        provenance.omitted++;
      } else if (ref) provenance.evidence.push(ref);
      else provenance.unknownPaths.push(path);
    };
    for (const id of this.#steps.keys())
      include(`/context/steps/${pointer(id)}`, this.#origins.get(id));
    for (const [name, reference] of Object.entries(references ?? {})) {
      const origin = this.#origins.get(reference.from);
      include(
        `/context/inputs/${pointer(name)}`,
        origin ? { ...origin, selector: reference.path } : undefined,
      );
    }
    for (const [index, id] of [...this.#artifacts.keys()].entries())
      include(`/artifacts/${index}`, this.#artifactOrigins.get(id));
    if (this.#workflowInputs !== undefined)
      include("/context/workflowInputs", this.#workflowOrigin);
    for (const ref of additional) include(ref.path, ref);
    return structuredClone({
      context: {
        steps: Object.fromEntries(this.#steps),
        omittedSteps: this.#omittedSteps,
        omittedArtifacts: this.#omittedArtifacts,
        provenance: provenance as unknown as JsonObject,
        ...(this.#workflowInputs !== undefined ? { workflowInputs: this.#workflowInputs } : {}),
        ...(references
          ? { inputs: resolveStepInputs(references, (id) => this.#outputs.get(id)) }
          : {}),
      },
      artifacts: [...this.#artifacts.values()],
    });
  }
}

/** Origin is derived from the authoritative event, never from claims in its payload. */
export function evidenceReference(event: VeyraEvent, path: string): EvidenceReference | undefined {
  if (!event.eventId || !event.sequence || !("stepId" in event) || !event.stepId) return undefined;
  const source =
    event.type === "agent.completed"
      ? "agent"
      : event.type === "verification.completed"
        ? "verifier"
        : event.type === "approval.resolved"
          ? "human"
          : [
                "consensus.completed",
                "subworkflow.completed",
                "subworkflow.started",
                "router.selected",
                "parallel.completed",
              ].includes(event.type)
            ? "workflow"
            : undefined;
  if (!source) return undefined;
  return {
    path,
    source,
    runId: event.runId,
    stepId: event.stepId,
    eventId: event.eventId,
    sequence: event.sequence,
    ...("attemptId" in event && event.attemptId ? { attemptId: event.attemptId } : {}),
  };
}
const pointer = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");

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
