import type { AgentDescriptor, AgentReadiness, AgentRequirements } from "./index.js";
import { isJsonValue } from "./json.js";

const object = (value: unknown): value is Record<string, unknown> =>
  isJsonValue(value) && value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, limit = 128): value is string =>
  typeof value === "string" && value.trim().length > 0 && [...value].length <= limit;
const list = (value: unknown, predicate: (item: unknown) => boolean): value is string[] =>
  Array.isArray(value) &&
  value.length <= 64 &&
  value.every(predicate) &&
  new Set(value).size === value.length;
const capability = (value: unknown) =>
  text(value) && /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/.test(value);

export function isAgentRequirements(value: unknown): value is AgentRequirements {
  return (
    object(value) &&
    Object.keys(value).every((key) => ["role", "capabilities"].includes(key)) &&
    (value.role === undefined || text(value.role)) &&
    (value.capabilities === undefined || list(value.capabilities, capability))
  );
}

export function isAgentDescriptor(value: unknown): value is AgentDescriptor {
  return (
    object(value) &&
    Object.keys(value).every((key) =>
      [
        "schemaVersion",
        "id",
        "provider",
        "adapterVersion",
        "model",
        "roles",
        "capabilities",
        "permissions",
      ].includes(key),
    ) &&
    value.schemaVersion === 1 &&
    text(value.id) &&
    text(value.provider) &&
    text(value.adapterVersion) &&
    (value.model === undefined || text(value.model, 512)) &&
    list(value.roles, (item) => text(item)) &&
    list(value.capabilities, capability) &&
    (value.permissions === undefined ||
      (object(value.permissions) &&
        Object.keys(value.permissions).every((key) =>
          ["mode", "source", "sandbox", "toolAllowRules"].includes(key),
        ) &&
        text(value.permissions.mode) &&
        ["adapter-argument", "native-configuration"].includes(value.permissions.source as string) &&
        (value.permissions.sandbox === undefined || text(value.permissions.sandbox)) &&
        (value.permissions.toolAllowRules === undefined ||
          (Number.isSafeInteger(value.permissions.toolAllowRules) &&
            (value.permissions.toolAllowRules as number) >= 0 &&
            (value.permissions.toolAllowRules as number) <= 1024))))
  );
}

export function isAgentReadiness(value: unknown): value is AgentReadiness {
  return (
    object(value) &&
    Object.keys(value).every((key) => ["status", "scope", "message", "version"].includes(key)) &&
    ["ready", "unavailable", "unknown"].includes(value.status as string) &&
    ["configuration", "local", "remote"].includes(value.scope as string) &&
    text(value.message, 4096) &&
    (value.version === undefined || text(value.version))
  );
}
