import type { JsonValue } from "@veyra/protocol";

const secretField =
  /(?:api[_-]?key|token|password|secret|authorization|cookie)$|^(?:env|environment)$/i;

export function redactor(env: NodeJS.ProcessEnv) {
  const secrets = Object.entries(env)
    .filter(([key, value]) => secretField.test(key) && value)
    .map(([, value]) => value as string);
  const text = (input: string): string => {
    let result = input;
    for (const secret of secrets) {
      const encoded = JSON.stringify(secret).slice(1, -1);
      for (const representation of [JSON.stringify(encoded).slice(1, -1), encoded, secret])
        result = result.split(representation).join("[REDACTED]");
    }
    return result.replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
  };
  const json = (value: JsonValue): JsonValue => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(json);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          secretField.test(key) ? "[REDACTED]" : json(item),
        ]),
      );
    return value;
  };
  return { text, json };
}
