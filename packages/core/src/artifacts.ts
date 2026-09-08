import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { ArtifactRef, VeyraEvent } from "@veyra/protocol";

export const MAX_INLINE_EVENT_BYTES = 64 * 1024;
export const EVENT_PREVIEW_BYTES = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface EventArtifact extends ArtifactRef {
  kind: "event-payload";
  path: string;
  mediaType: "application/json";
  sizeBytes: number;
  createdAt: string;
  producer: NonNullable<ArtifactRef["producer"]>;
  metadata: { sha256: string; eventType: string };
}

export function eventArtifact(event: VeyraEvent, serialized: string): EventArtifact {
  if (!event.eventId || event.type === "event.stored")
    throw new Error("Expected a complete persisted event.");
  return {
    id: event.eventId,
    kind: "event-payload",
    path: `artifacts/${event.eventId}.json`,
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(serialized),
    createdAt: event.at,
    producer: {
      runId: event.runId,
      ...("stepId" in event && typeof event.stepId === "string" ? { stepId: event.stepId } : {}),
      ...("attemptId" in event && event.attemptId ? { attemptId: event.attemptId } : {}),
      ...("attempt" in event && event.attempt !== undefined ? { attempt: event.attempt } : {}),
      ...("parentStepId" in event && event.parentStepId
        ? { parentStepId: event.parentStepId }
        : {}),
    },
    metadata: { sha256: digest(serialized), eventType: event.type },
  };
}

export function isEventArtifact(value: unknown): value is EventArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as EventArtifact;
  return (
    Object.keys(ref).length === 8 &&
    typeof ref.id === "string" &&
    UUID.test(ref.id) &&
    ref.kind === "event-payload" &&
    ref.path === `artifacts/${ref.id}.json` &&
    ref.mediaType === "application/json" &&
    Number.isSafeInteger(ref.sizeBytes) &&
    ref.sizeBytes > 0 &&
    ref.sizeBytes <= 16 * 1024 * 1024 + 1 &&
    typeof ref.createdAt === "string" &&
    Number.isFinite(Date.parse(ref.createdAt)) &&
    Boolean(ref.producer) &&
    typeof ref.producer === "object" &&
    typeof ref.producer.runId === "string" &&
    (ref.producer.stepId === undefined || typeof ref.producer.stepId === "string") &&
    (ref.producer.attemptId === undefined || typeof ref.producer.attemptId === "string") &&
    (ref.producer.parentStepId === undefined || typeof ref.producer.parentStepId === "string") &&
    (ref.producer.attempt === undefined ||
      (Number.isSafeInteger(ref.producer.attempt) && ref.producer.attempt >= 0)) &&
    Boolean(ref.metadata) &&
    typeof ref.metadata === "object" &&
    Object.keys(ref.metadata).length === 2 &&
    typeof ref.metadata.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(ref.metadata.sha256) &&
    typeof ref.metadata.eventType === "string" &&
    ref.metadata.eventType !== "event.stored"
  );
}

/** Use bounded views for display; use LocalRunStore.readEvents() for complete execution evidence. */
export function eventView(event: VeyraEvent): VeyraEvent {
  if (!event.payload) return structuredClone(event);
  const { payload, ...original } = event;
  const decoder = new StringDecoder("utf8");
  const preview = decoder.write(
    Buffer.from(JSON.stringify(original)).subarray(0, EVENT_PREVIEW_BYTES),
  );
  return {
    type: "event.stored",
    runId: event.runId,
    at: event.at,
    eventId: event.eventId,
    sequence: event.sequence,
    eventType: original.type,
    artifact: structuredClone(payload),
    preview,
  };
}

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
