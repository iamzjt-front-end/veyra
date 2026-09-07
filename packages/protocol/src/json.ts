import type { JsonValue } from "./index.js";

/** Validate plain JSON data without invoking accessors or custom serialization methods. */
export function isJsonValue(value: unknown): value is JsonValue {
  const parents = new Set<object>();

  function visit(item: unknown): boolean {
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object" || item === null || parents.has(item)) return false;
    if (Object.getOwnPropertySymbols(item).length > 0) return false;
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (
      array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    )
      return false;
    parents.add(item);
    try {
      if (array) {
        if (Object.getOwnPropertyNames(item).length !== item.length + 1) return false;
        for (let index = 0; index < item.length; index++) {
          const property = Object.getOwnPropertyDescriptor(item, String(index));
          if (!property || !("value" in property) || !visit(property.value)) return false;
        }
        return true;
      }
      return Object.values(Object.getOwnPropertyDescriptors(item)).every(
        (property) => property.enumerable && "value" in property && visit(property.value),
      );
    } finally {
      parents.delete(item);
    }
  }

  return visit(value);
}
