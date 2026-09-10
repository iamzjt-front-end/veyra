import { isJsonValue } from "./json.js";
import {
  isProjectDescriptor,
  isProjectId,
  type ProjectDescriptor,
  type ProjectId,
} from "./project.js";
import {
  isProjectHandoff,
  isProjectExecutionResult,
  isProjectReview,
  isProjectExecutionStatus,
  type ProjectExecutionStatus,
  type ProjectReview,
  type ProjectHandoff,
  type ProjectExecutionResult,
} from "./project-state.js";

export const MAX_DAEMON_REQUEST_BYTES = 256 * 1024;
export const MAX_DAEMON_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface RegisteredProject {
  project: ProjectDescriptor;
  status: "available" | "stale";
  reason?: "unavailable_path" | "identity_changed" | "invalid_metadata";
}
export interface DaemonInfo {
  version: 1;
  id: string;
  owner: { pid: number; host: string; startedAt: string };
  registryRoot: string;
  socketPath: string;
  startedAt: string;
}
export interface DaemonRunView {
  version: 1;
  projectId: ProjectId;
  runId: string;
  status: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled" | "interrupted";
  executionStatus?: ProjectExecutionStatus;
  createdAt: string;
  updatedAt: string;
  error?: { code: string; message: string };
}
export interface DaemonRunSummary extends DaemonRunView {
  goal: string;
}
export interface ProjectRunLocator {
  projectId: ProjectId;
  runId: string;
}
export interface DaemonOperations {
  health: { input: undefined; output: DaemonInfo };
  stop: { input: undefined; output: { stopping: true } };
  "projects.list": { input: undefined; output: RegisteredProject[] };
  "projects.get": { input: { projectId: ProjectId }; output: RegisteredProject };
  "projects.register": { input: { path: string }; output: RegisteredProject };
  "runs.dispatch": {
    input: { projectId: ProjectId; handoff: ProjectHandoff };
    output: DaemonRunView;
  };
  "runs.list": {
    input: { projectId: ProjectId; limit: number };
    output: { runs: DaemonRunSummary[]; hasMore: boolean };
  };
  "runs.get": { input: ProjectRunLocator; output: DaemonRunView };
  "runs.wait": { input: ProjectRunLocator & { waitMs: number }; output: DaemonRunView };
  "runs.cancel": { input: ProjectRunLocator; output: DaemonRunView };
  "handoffs.get": { input: ProjectRunLocator; output: ProjectHandoff };
  "results.get": { input: ProjectRunLocator; output: ProjectExecutionResult | null };
  "reviews.get": { input: ProjectRunLocator; output: ProjectReview | null };
  "reviews.submit": { input: ProjectRunLocator & { review: ProjectReview }; output: ProjectReview };
}
export type DaemonMethod = keyof DaemonOperations;
export type DaemonRequest<M extends DaemonMethod = DaemonMethod> = M extends DaemonMethod
  ? { version: 1; method: M } & (DaemonOperations[M]["input"] extends undefined
      ? { params?: never }
      : { params: DaemonOperations[M]["input"] })
  : never;
export type DaemonResponse<M extends DaemonMethod = DaemonMethod> =
  | { version: 1; ok: true; result: DaemonOperations[M]["output"] }
  | { version: 1; ok: false; error: { code: string; message: string } };

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, names: string[]) =>
  Object.keys(value).every((name) => names.includes(name));
const text = (value: unknown, max = 512): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
const uuid = (value: unknown) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const date = (value: unknown) => text(value, 40) && Number.isFinite(Date.parse(value));
function json(value: unknown, max: number) {
  try {
    return isJsonValue(value) && new TextEncoder().encode(JSON.stringify(value)).length <= max;
  } catch {
    return false;
  }
}
export function isRegisteredProject(value: unknown): value is RegisteredProject {
  return (
    isJsonValue(value) &&
    object(value) &&
    keys(value, ["project", "status", "reason"]) &&
    isProjectDescriptor(value.project) &&
    (value.status === "available"
      ? value.reason === undefined
      : value.status === "stale" &&
        ["unavailable_path", "identity_changed", "invalid_metadata"].includes(String(value.reason)))
  );
}
export function isDaemonRunView(value: unknown): value is DaemonRunView {
  return (
    isJsonValue(value) &&
    object(value) &&
    keys(value, [
      "version",
      "projectId",
      "runId",
      "status",
      "executionStatus",
      "createdAt",
      "updatedAt",
      "error",
    ]) &&
    value.version === 1 &&
    isProjectId(value.projectId) &&
    uuid(value.runId) &&
    ["queued", "running", "paused", "completed", "failed", "cancelled", "interrupted"].includes(
      String(value.status),
    ) &&
    date(value.createdAt) &&
    date(value.updatedAt) &&
    (value.executionStatus === undefined || isProjectExecutionStatus(value.executionStatus)) &&
    (value.error === undefined ||
      (object(value.error) &&
        keys(value.error, ["code", "message"]) &&
        text(value.error.code, 128) &&
        text(value.error.message)))
  );
}
export function isDaemonRequest(value: unknown): value is DaemonRequest {
  if (
    !json(value, MAX_DAEMON_REQUEST_BYTES) ||
    !object(value) ||
    value.version !== 1 ||
    !keys(value, ["version", "method", "params"])
  )
    return false;
  if (["health", "stop", "projects.list"].includes(String(value.method)))
    return value.params === undefined;
  const params = value.params;
  if (!object(params)) return false;
  if (value.method === "projects.register")
    return keys(params, ["path"]) && text(params.path, 32768) && params.path.startsWith("/");
  if (!isProjectId(params.projectId)) return false;
  if (value.method === "projects.get") return keys(params, ["projectId"]);
  if (value.method === "runs.list")
    return (
      keys(params, ["projectId", "limit"]) &&
      Number.isInteger(params.limit) &&
      Number(params.limit) >= 1 &&
      Number(params.limit) <= 100
    );
  if (value.method === "runs.dispatch")
    return (
      keys(params, ["projectId", "handoff"]) &&
      isProjectHandoff(params.handoff) &&
      params.handoff.projectId === params.projectId &&
      uuid(params.handoff.runId)
    );
  if (!uuid(params.runId)) return false;
  if (value.method === "reviews.submit")
    return (
      keys(params, ["projectId", "runId", "review"]) &&
      isProjectReview(params.review) &&
      params.review.projectId === params.projectId &&
      params.review.runId === params.runId &&
      params.review.provenance.role === "reviewer"
    );
  if (value.method === "runs.wait")
    return (
      keys(params, ["projectId", "runId", "waitMs"]) &&
      Number.isSafeInteger(params.waitMs) &&
      Number(params.waitMs) >= 0 &&
      Number(params.waitMs) <= 30000
    );
  return (
    ["runs.get", "runs.cancel", "handoffs.get", "results.get", "reviews.get"].includes(
      String(value.method),
    ) && keys(params, ["projectId", "runId"])
  );
}
export function isDaemonResponse<M extends DaemonMethod>(
  value: unknown,
  method: M,
): value is DaemonResponse<M> {
  if (
    !json(value, MAX_DAEMON_RESPONSE_BYTES) ||
    !object(value) ||
    value.version !== 1 ||
    typeof value.ok !== "boolean"
  )
    return false;
  if (!value.ok)
    return (
      keys(value, ["version", "ok", "error"]) &&
      object(value.error) &&
      keys(value.error, ["code", "message"]) &&
      text(value.error.code, 128) &&
      text(value.error.message)
    );
  if (!keys(value, ["version", "ok", "result"])) return false;
  const result = value.result;
  if (method === "health")
    return (
      object(result) &&
      keys(result, ["version", "id", "owner", "registryRoot", "socketPath", "startedAt"]) &&
      result.version === 1 &&
      uuid(result.id) &&
      text(result.registryRoot, 32768) &&
      text(result.socketPath, 1024) &&
      date(result.startedAt) &&
      object(result.owner) &&
      keys(result.owner, ["pid", "host", "startedAt"]) &&
      Number.isSafeInteger(result.owner.pid) &&
      Number(result.owner.pid) > 0 &&
      text(result.owner.host, 1024) &&
      date(result.owner.startedAt)
    );
  if (method === "stop")
    return object(result) && keys(result, ["stopping"]) && result.stopping === true;
  if (method === "projects.list")
    return Array.isArray(result) && result.length <= 1000 && result.every(isRegisteredProject);
  if (method === "projects.get" || method === "projects.register")
    return isRegisteredProject(result);
  if (method === "runs.list")
    return (
      object(result) &&
      keys(result, ["runs", "hasMore"]) &&
      typeof result.hasMore === "boolean" &&
      Array.isArray(result.runs) &&
      result.runs.length <= 100 &&
      result.runs.every(isDaemonRunSummary)
    );
  if (method === "handoffs.get") return isProjectHandoff(result);
  if (method === "results.get") return result === null || isProjectExecutionResult(result);
  if (method === "reviews.get") return result === null || isProjectReview(result);
  if (method === "reviews.submit") return isProjectReview(result);
  return isDaemonRunView(result);
}

export function isDaemonRunSummary(value: unknown): value is DaemonRunSummary {
  if (!object(value) || !text(value.goal, 2048)) return false;
  const { goal: _goal, ...run } = value;
  return isDaemonRunView(run);
}
