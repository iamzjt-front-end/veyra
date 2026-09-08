import { isJsonValue } from "./json.js";

declare const projectId: unique symbol;
export type ProjectId = string & { readonly [projectId]: true };

/** Identity/locator metadata only. Workflow state and native credentials are not metadata. */
export interface ProjectDescriptor {
  version: 1;
  id: ProjectId;
  name: string;
  root: string;
  createdAt: string;
}

export function isProjectId(value: unknown): value is ProjectId {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
  );
}

export function isProjectDescriptor(value: unknown): value is ProjectDescriptor {
  if (!isJsonValue(value) || !value || typeof value !== "object" || Array.isArray(value))
    return false;
  return (
    Object.keys(value).length === 5 &&
    value.version === 1 &&
    isProjectId(value.id) &&
    typeof value.name === "string" &&
    value.name.trim() === value.name &&
    value.name.length > 0 &&
    value.name.length <= 256 &&
    ![...value.name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    typeof value.root === "string" &&
    value.root.startsWith("/") &&
    value.root.length <= 32768 &&
    !value.root.includes("\0") &&
    (value.root === "/" || !value.root.endsWith("/")) &&
    !value.root
      .split("/")
      .slice(1)
      .some((part) => part === "." || part === ".." || (!part && value.root !== "/")) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    new Date(value.createdAt).toISOString() === value.createdAt
  );
}
