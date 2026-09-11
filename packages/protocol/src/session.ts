import { isJsonValue } from "./json.js";
import {
  isProjectDescriptor,
  isProjectId,
  type ProjectDescriptor,
  type ProjectId,
} from "./project.js";

/** Explicit routing metadata only. Native conversation history stays with the native client. */
export interface NativeConversation {
  id: string;
  title: string;
  root: string;
}
export function isNativeConversation(value: unknown): value is NativeConversation {
  if (!isJsonValue(value) || !value || typeof value !== "object" || Array.isArray(value))
    return false;
  return (
    Object.keys(value).length === 3 &&
    isSessionId(value.id) &&
    typeof value.title === "string" &&
    value.title.trim().length > 0 &&
    value.title.length <= 512 &&
    typeof value.root === "string" &&
    value.root.startsWith("/") &&
    value.root.length <= 4096 &&
    ![...value.root].some((character) => character.charCodeAt(0) < 32)
  );
}

/** An optional native locator, not a credential or a copy of native conversation state. */
export interface NativeSessionReference {
  version: 1;
  kind: "session";
  provider: string;
  id: string;
  projectId: ProjectId;
  runId: string;
  createdAt: string;
}
/** Explicit Project/session selection for a configured native adapter. Absence stays ephemeral. */
export interface NativeSessionRequest {
  project: ProjectDescriptor;
  resume?: NativeSessionReference;
}
export function isSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
  );
}
export function isNativeSessionReference(value: unknown): value is NativeSessionReference {
  if (!isJsonValue(value) || !value || typeof value !== "object" || Array.isArray(value))
    return false;
  return (
    Object.keys(value).length === 7 &&
    Object.keys(value).every((key) =>
      ["version", "kind", "provider", "id", "projectId", "runId", "createdAt"].includes(key),
    ) &&
    value.version === 1 &&
    value.kind === "session" &&
    typeof value.provider === "string" &&
    /^[a-z][a-z0-9-]{0,63}$/.test(value.provider) &&
    isSessionId(value.id) &&
    isSessionId(value.runId) &&
    isProjectId(value.projectId) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    new Date(value.createdAt).toISOString() === value.createdAt
  );
}
export function isNativeSessionRequest(value: unknown): value is NativeSessionRequest {
  if (!isJsonValue(value) || !value || typeof value !== "object" || Array.isArray(value))
    return false;
  return (
    Object.keys(value).every((key) => ["project", "resume"].includes(key)) &&
    isProjectDescriptor(value.project) &&
    (value.resume === undefined ||
      (isNativeSessionReference(value.resume) && value.resume.projectId === value.project.id))
  );
}
