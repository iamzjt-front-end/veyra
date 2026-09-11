import { serializeProjectEnvelope, type ProjectHandoff } from "@veyraoss/protocol";
import type { Binding } from "./contracts.js";
import { BUILD_ID } from "./build-info.js";

export type BridgeStage =
  "detected" | "validated" | "accepted" | "completed" | "delivered" | "reviewed";
export interface BridgeCheckpoint {
  stage: BridgeStage;
  at: string;
  buildId: string;
  runId: string;
  reference?: string;
}
/** Routing/delivery receipts only; no model text, command output or conversation history. */
export function checkpoint(
  binding: Binding,
  stage: BridgeStage,
  reference?: string,
  runId = binding.runId ?? binding.nextRunId,
) {
  if (binding.checkpoints?.some((entry) => entry.stage === stage && entry.runId === runId)) return;
  binding.checkpoints = [
    ...(binding.checkpoints ?? []),
    {
      stage,
      at: new Date().toISOString(),
      buildId: BUILD_ID,
      runId,
      ...(reference ? { reference: reference.slice(0, 128) } : {}),
    },
  ].slice(-30);
}
export async function handoffFingerprint(handoff: ProjectHandoff): Promise<string> {
  const bytes = new TextEncoder().encode(serializeProjectEnvelope(handoff));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
