import type { ArtifactRef, EvidenceReference } from "./index.js";
import { isJsonValue } from "./json.js";
import { isEvidenceReference } from "./provenance.js";
import { isProjectId, type ProjectId } from "./project.js";
import { isNativeSessionReference, type NativeSessionReference } from "./session.js";

export const MAX_PROJECT_STATE_BYTES = 256 * 1024;
export const MAX_PROJECT_ENVELOPE_BYTES = 64 * 1024;

/** Producer labels describe provenance, not authority to execute embedded instructions. */
export interface ProjectProvenance {
  role: "planner" | "executor" | "reviewer" | "human" | "system";
  surface: string;
  actor: string;
  at: string;
  contentTrust: "untrusted";
}
export interface ProjectDecision {
  id: string;
  summary: string;
  rationale: string;
  provenance: ProjectProvenance;
}
export interface ProjectPlan {
  id: string;
  revision: number;
  summary: string;
  tasks: { id: string; description: string }[];
  acceptanceCriteria: string[];
  provenance: ProjectProvenance;
}
export interface ProjectContext {
  goal: string;
  constraints: string[];
  decisions: ProjectDecision[];
  plan?: ProjectPlan;
  currentTask?: string;
}
interface ProjectEnvelope {
  version: 1;
  id: string;
  projectId: ProjectId;
  runId: string;
  provenance: ProjectProvenance;
}
export interface ProjectHandoff extends ProjectEnvelope {
  kind: "handoff";
  context: ProjectContext;
  references?: ProjectInputReference[];
  /** Selects existing host-owned command steps. This is not authority to execute shell text. */
  requestedVerification?: ProjectVerificationRequest[];
}
export type ProjectInputReference =
  | { kind: "file"; path: string; startLine?: number; endLine?: number }
  | { kind: "artifact"; runId: string; id: string; summary?: string };
export interface ProjectVerificationRequest {
  id: string;
  kind: "test" | "lint" | "typecheck" | "build" | "shell" | "benchmark";
  description?: string;
}
/** Reuses existing artifact IDs/producer metadata without copying arbitrary artifact payloads. */
export type ProjectArtifactReference = Pick<ArtifactRef, "id" | "kind" | "path" | "producer">;
/** Execution lifecycle only; a completed invocation can produce negative verification/review. */
export type ProjectExecutionStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "paused"
  | "interrupted";
export function isProjectExecutionStatus(value: unknown): value is ProjectExecutionStatus {
  return [
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
    "timed_out",
    "paused",
    "interrupted",
  ].includes(String(value));
}
export interface ProjectExecutionResult extends ProjectEnvelope {
  kind: "result";
  handoffId: string;
  status: "completed" | "failed" | "cancelled";
  /** Optional for historical envelopes. status remains the conservative aggregate outcome. */
  executionStatus?: ProjectExecutionStatus;
  summary: string;
  changedFiles: string[];
  evidence: EvidenceReference[];
  artifacts: ProjectArtifactReference[];
  session?: NativeSessionReference;
  diff?: { summary: string; source: "git" | "executor"; artifact?: ProjectArtifactReference };
  risks?: { code: string; summary: string; source: "executor" | "verifier" | "system" }[];
  verification?: {
    id: string;
    status: "passed" | "failed" | "not_run";
    evidence?: EvidenceReference;
  }[];
}
export interface ProjectReview extends ProjectEnvelope {
  kind: "review";
  resultId: string;
  handoffId?: string;
  verdict: "pass" | "fail" | "needs_input";
  summary: string;
  nextAction: "complete" | "repair" | "continue" | "wait";
  evidence: EvidenceReference[];
  findings?: { severity: "critical" | "warning" | "info"; description: string }[];
  /** Original bridge verdict, retained for Diagnostics, never approval authority. */
  sourceVerdict?: "PASS" | "FAIL" | "HUMAN_DECISION";
}
export interface ProjectSharedState {
  version: 1;
  projectId: ProjectId;
  revision: number;
  updatedAt: string;
  provenance: ProjectProvenance;
  context: ProjectContext;
  handoff?: ProjectHandoff;
  result?: ProjectExecutionResult;
  review?: ProjectReview;
}
export type ProjectStateUpdate = Omit<
  ProjectSharedState,
  "version" | "projectId" | "revision" | "updatedAt"
>;

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const text = (value: unknown, max = 8192): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= max &&
  !value.includes("\0");
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const date = (value: unknown) =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const list = (value: unknown, check: (item: unknown) => boolean, max = 100): value is unknown[] =>
  Array.isArray(value) && value.length <= max && value.every(check);
const relativePath = (value: unknown) =>
  text(value, 4096) &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !value.includes(":") &&
  value.split("/").every((part) => part && part !== "." && part !== "..");
function boundedJson(value: unknown, max = MAX_PROJECT_STATE_BYTES): boolean {
  try {
    return isJsonValue(value) && new TextEncoder().encode(JSON.stringify(value)).length <= max;
  } catch {
    return false;
  }
}
function provenance(value: unknown): value is ProjectProvenance {
  return (
    object(value) &&
    keys(value, ["role", "surface", "actor", "at", "contentTrust"]) &&
    ["planner", "executor", "reviewer", "human", "system"].includes(String(value.role)) &&
    id(value.surface) &&
    text(value.actor, 256) &&
    date(value.at) &&
    value.contentTrust === "untrusted"
  );
}
function context(value: unknown): value is ProjectContext {
  if (
    !object(value) ||
    !keys(value, ["goal", "constraints", "decisions", "plan", "currentTask"]) ||
    !text(value.goal) ||
    !list(value.constraints, (item) => text(item, 4096)) ||
    !list(
      value.decisions,
      (item) =>
        object(item) &&
        keys(item, ["id", "summary", "rationale", "provenance"]) &&
        id(item.id) &&
        text(item.summary, 4096) &&
        text(item.rationale, 4096) &&
        provenance(item.provenance),
    )
  )
    return false;
  if (
    new Set(value.decisions.map((item) => (item as ProjectDecision).id)).size !==
    value.decisions.length
  )
    return false;
  if (value.plan !== undefined) {
    const plan = value.plan;
    if (
      !object(plan) ||
      !keys(plan, ["id", "revision", "summary", "tasks", "acceptanceCriteria", "provenance"]) ||
      !id(plan.id) ||
      !Number.isSafeInteger(plan.revision) ||
      Number(plan.revision) < 1 ||
      !text(plan.summary) ||
      !list(
        plan.tasks,
        (task) =>
          object(task) &&
          keys(task, ["id", "description"]) &&
          id(task.id) &&
          text(task.description, 4096),
      ) ||
      !plan.tasks.length ||
      new Set(plan.tasks.map((task) => (task as { id: string }).id)).size !== plan.tasks.length ||
      !list(plan.acceptanceCriteria, (item) => text(item, 4096)) ||
      !plan.acceptanceCriteria.length ||
      !provenance(plan.provenance)
    )
      return false;
  }
  return (
    value.currentTask === undefined ||
    (id(value.currentTask) &&
      object(value.plan) &&
      Array.isArray(value.plan.tasks) &&
      value.plan.tasks.some((task: { id: string }) => task.id === value.currentTask))
  );
}
const envelopeKeys = ["version", "kind", "id", "projectId", "runId", "provenance"];
function envelope(value: unknown): value is Record<string, unknown> {
  return (
    object(value) &&
    value.version === 1 &&
    id(value.id) &&
    isProjectId(value.projectId) &&
    id(value.runId) &&
    provenance(value.provenance)
  );
}
function evidence(value: unknown, runId: unknown): boolean {
  return list(
    value,
    (item) =>
      isEvidenceReference(item) &&
      item.runId === runId &&
      item.path.length <= 4096 &&
      [item.runId, item.stepId, item.eventId].every(id) &&
      (item.attemptId === undefined || id(item.attemptId)) &&
      (item.selector === undefined || item.selector.length <= 1024),
    128,
  );
}
function artifact(value: unknown, runId: unknown): boolean {
  if (
    !object(value) ||
    !keys(value, ["id", "kind", "path", "producer"]) ||
    !id(value.id) ||
    !id(value.kind) ||
    (value.path !== undefined && !relativePath(value.path))
  )
    return false;
  if (value.producer === undefined) return true;
  const producer = value.producer;
  return (
    object(producer) &&
    keys(producer, ["runId", "stepId", "attemptId", "attempt", "parentStepId"]) &&
    producer.runId === runId &&
    ["stepId", "attemptId", "parentStepId"].every(
      (key) => producer[key] === undefined || id(producer[key]),
    ) &&
    (producer.attempt === undefined ||
      (Number.isSafeInteger(producer.attempt) && Number(producer.attempt) >= 1))
  );
}
function inputReference(value: unknown): boolean {
  if (!object(value)) return false;
  if (value.kind === "artifact")
    return (
      keys(value, ["kind", "runId", "id", "summary"]) &&
      id(value.runId) &&
      id(value.id) &&
      (value.summary === undefined || text(value.summary, 2048))
    );
  return (
    value.kind === "file" &&
    keys(value, ["kind", "path", "startLine", "endLine"]) &&
    relativePath(value.path) &&
    (value.startLine === undefined ||
      (Number.isSafeInteger(value.startLine) && Number(value.startLine) > 0)) &&
    (value.endLine === undefined ||
      (value.startLine !== undefined &&
        Number.isSafeInteger(value.endLine) &&
        Number(value.endLine) >= Number(value.startLine)))
  );
}
function verificationRequests(value: unknown): boolean {
  return (
    list(
      value,
      (request) =>
        object(request) &&
        keys(request, ["id", "kind", "description"]) &&
        id(request.id) &&
        ["test", "lint", "typecheck", "build", "shell", "benchmark"].includes(
          String(request.kind),
        ) &&
        (request.description === undefined || text(request.description, 2048)),
      32,
    ) && new Set(value.map((item) => (item as ProjectVerificationRequest).id)).size === value.length
  );
}
export function isProjectHandoff(value: unknown): value is ProjectHandoff {
  return (
    boundedJson(value, MAX_PROJECT_ENVELOPE_BYTES) &&
    envelope(value) &&
    keys(value, [...envelopeKeys, "context", "references", "requestedVerification"]) &&
    value.kind === "handoff" &&
    context(value.context) &&
    (value.references === undefined || list(value.references, inputReference, 128)) &&
    (value.requestedVerification === undefined || verificationRequests(value.requestedVerification))
  );
}
export function isProjectExecutionResult(value: unknown): value is ProjectExecutionResult {
  return (
    boundedJson(value, MAX_PROJECT_ENVELOPE_BYTES) &&
    envelope(value) &&
    keys(value, [
      ...envelopeKeys,
      "handoffId",
      "status",
      "executionStatus",
      "summary",
      "changedFiles",
      "evidence",
      "artifacts",
      "session",
      "diff",
      "risks",
      "verification",
    ]) &&
    value.kind === "result" &&
    id(value.handoffId) &&
    ["completed", "failed", "cancelled"].includes(String(value.status)) &&
    (value.executionStatus === undefined || isProjectExecutionStatus(value.executionStatus)) &&
    text(value.summary) &&
    list(value.changedFiles, relativePath, 256) &&
    evidence(value.evidence, value.runId) &&
    list(value.artifacts, (item) => artifact(item, value.runId), 128) &&
    (value.diff === undefined ||
      (object(value.diff) &&
        keys(value.diff, ["summary", "source", "artifact"]) &&
        text(value.diff.summary, 4096) &&
        ["git", "executor"].includes(String(value.diff.source)) &&
        (value.diff.artifact === undefined || artifact(value.diff.artifact, value.runId)))) &&
    (value.risks === undefined ||
      list(
        value.risks,
        (risk) =>
          object(risk) &&
          keys(risk, ["code", "summary", "source"]) &&
          id(risk.code) &&
          text(risk.summary, 2048) &&
          ["executor", "verifier", "system"].includes(String(risk.source)),
        32,
      )) &&
    (value.verification === undefined ||
      (list(
        value.verification,
        (check) =>
          object(check) &&
          keys(check, ["id", "status", "evidence"]) &&
          id(check.id) &&
          ["passed", "failed", "not_run"].includes(String(check.status)) &&
          (check.status === "not_run"
            ? check.evidence === undefined
            : evidence([check.evidence], value.runId) &&
              (check.evidence as EvidenceReference).source === "verifier" &&
              (check.evidence as EvidenceReference).stepId === check.id) &&
          (check.status !== "failed" || value.status !== "completed") &&
          (check.status !== "not_run" || value.status !== "completed"),
        32,
      ) &&
        new Set(value.verification.map((item) => (item as { id: string }).id)).size ===
          value.verification.length)) &&
    (value.session === undefined ||
      (isNativeSessionReference(value.session) &&
        value.session.projectId === value.projectId &&
        value.session.runId === value.runId))
  );
}
export function isProjectReview(value: unknown): value is ProjectReview {
  return (
    boundedJson(value, MAX_PROJECT_ENVELOPE_BYTES) &&
    envelope(value) &&
    keys(value, [
      ...envelopeKeys,
      "resultId",
      "handoffId",
      "verdict",
      "summary",
      "nextAction",
      "evidence",
      "findings",
      "sourceVerdict",
    ]) &&
    value.kind === "review" &&
    id(value.resultId) &&
    (value.handoffId === undefined || id(value.handoffId)) &&
    ["pass", "fail", "needs_input"].includes(String(value.verdict)) &&
    text(value.summary) &&
    ["complete", "repair", "continue", "wait"].includes(String(value.nextAction)) &&
    evidence(value.evidence, value.runId) &&
    (value.findings === undefined ||
      list(
        value.findings,
        (finding) =>
          object(finding) &&
          keys(finding, ["severity", "description"]) &&
          ["critical", "warning", "info"].includes(String(finding.severity)) &&
          text(finding.description, 4096),
        64,
      )) &&
    (value.sourceVerdict === undefined ||
      (value.sourceVerdict === "PASS" && value.verdict === "pass") ||
      (value.sourceVerdict === "FAIL" && value.verdict === "fail") ||
      (value.sourceVerdict === "HUMAN_DECISION" && value.verdict === "needs_input"))
  );
}
export function isProjectReviewForResult(
  review: unknown,
  result: unknown,
): review is ProjectReview {
  return (
    isProjectReview(review) &&
    isProjectExecutionResult(result) &&
    review.projectId === result.projectId &&
    review.runId === result.runId &&
    review.resultId === result.id &&
    (review.handoffId === undefined || review.handoffId === result.handoffId)
  );
}
/** Link a result to the exact requested checks, not just to matching producer labels. */
export function isProjectResultForHandoff(
  result: unknown,
  handoff: unknown,
): result is ProjectExecutionResult {
  return (
    isProjectExecutionResult(result) &&
    isProjectHandoff(handoff) &&
    result.projectId === handoff.projectId &&
    result.runId === handoff.runId &&
    result.handoffId === handoff.id &&
    (!handoff.requestedVerification ||
      (result.verification?.length === handoff.requestedVerification.length &&
        handoff.requestedVerification.every(
          (check, index) => result.verification?.[index]?.id === check.id,
        )))
  );
}
export function isProjectSharedState(value: unknown): value is ProjectSharedState {
  if (
    !boundedJson(value) ||
    !object(value) ||
    !keys(value, [
      "version",
      "projectId",
      "revision",
      "updatedAt",
      "provenance",
      "context",
      "handoff",
      "result",
      "review",
    ]) ||
    value.version !== 1 ||
    !isProjectId(value.projectId) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    !date(value.updatedAt) ||
    !provenance(value.provenance) ||
    !context(value.context)
  )
    return false;
  if (
    value.handoff !== undefined &&
    (!isProjectHandoff(value.handoff) || value.handoff.projectId !== value.projectId)
  )
    return false;
  if (
    value.result !== undefined &&
    (!isProjectResultForHandoff(value.result, value.handoff) ||
      value.result.projectId !== value.projectId)
  )
    return false;
  if (
    value.review !== undefined &&
    (!isProjectReviewForResult(value.review, value.result) ||
      value.review.projectId !== value.projectId)
  )
    return false;
  return true;
}
