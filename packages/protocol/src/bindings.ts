import { isJsonValue } from "./json.js";
import { isProjectId, type ProjectId } from "./project.js";
import { isNativeSessionReference, type NativeSessionReference } from "./session.js";

/** A role selects a provider and invocation mode; it is not itself a provider. */
export interface ProjectRoleBinding {
  provider: string;
  mode: "native" | "api";
  executable?: string;
  model?: string;
  session?: NativeSessionReference;
}

/** Project-owned configuration only: no credentials, environment or native chat history. */
export interface ProjectBindings {
  version: 1;
  projectId: ProjectId;
  revision: number;
  updatedAt: string;
  roles: Record<string, ProjectRoleBinding>;
}

const name = (value: unknown) => typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const text = (value: unknown, max: number) =>
  typeof value === "string" &&
  value.trim() === value &&
  value.length > 0 &&
  value.length <= max &&
  ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

export function isProjectRoleBinding(value: unknown): value is ProjectRoleBinding {
  if (!isJsonValue(value) || !value || typeof value !== "object" || Array.isArray(value))
    return false;
  return (
    Object.keys(value).every((key) =>
      ["provider", "mode", "executable", "model", "session"].includes(key),
    ) &&
    name(value.provider) &&
    ["native", "api"].includes(String(value.mode)) &&
    (value.executable === undefined || (value.mode === "native" && text(value.executable, 4096))) &&
    (value.model === undefined || text(value.model, 256)) &&
    (value.session === undefined ||
      (value.mode === "native" &&
        isNativeSessionReference(value.session) &&
        value.session.provider === value.provider))
  );
}

export function isProjectBindings(value: unknown): value is ProjectBindings {
  if (!isJsonValue(value) || !value || typeof value !== "object" || Array.isArray(value))
    return false;
  return (
    Object.keys(value).length === 5 &&
    value.version === 1 &&
    isProjectId(value.projectId) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) > 0 &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    new Date(value.updatedAt).toISOString() === value.updatedAt &&
    !!value.roles &&
    typeof value.roles === "object" &&
    !Array.isArray(value.roles) &&
    Object.keys(value.roles).length <= 32 &&
    Object.entries(value.roles).every(
      ([role, binding]) =>
        name(role) &&
        isProjectRoleBinding(binding) &&
        (!binding.session || binding.session.projectId === value.projectId),
    ) &&
    new TextEncoder().encode(JSON.stringify(value)).length <= 16384
  );
}
