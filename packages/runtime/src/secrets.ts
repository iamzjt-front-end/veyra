import type { JsonValue } from "@veyra/protocol";

const marker = "[REDACTED]";
/** Credential values only; plural usage fields such as inputTokens are not secrets. */
export const isSecretField = (name: string): boolean =>
  /(?:api[_-]?key|token|password|passwd|secret|authorization|cookie|private[_-]?key)$|^(?:env|environment)$/i.test(
    name,
  );

/** Callers supply their environment explicitly; this module never reads global state or files. */
export function collectSecretValues(
  env: Readonly<Record<string, string | undefined>>,
  envNames: readonly string[] = [],
): string[] {
  const names = new Set([...Object.keys(env).filter(isSecretField), ...envNames]);
  return [
    ...new Set(
      [...names]
        .map((name) => env[name])
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  ].sort((a, b) => b.length - a.length);
}

export interface SecretRedactor {
  text(value: string): string;
  /** Input must be JSON data; callers retain responsibility for structural schema validation. */
  json(value: JsonValue, redactFields?: boolean): JsonValue;
}

export function createSecretRedactor(
  options: {
    values?: readonly string[];
    env?: Readonly<Record<string, string | undefined>>;
    envNames?: readonly string[];
  } = {},
): SecretRedactor {
  const variants = new Set<string>();
  for (const value of [
    ...(options.values ?? []),
    ...collectSecretValues(options.env ?? {}, options.envNames),
  ]) {
    if (!value) continue;
    variants.add(value);
    // Native JSONL can contain JSON inside a JSON string; both escaped forms matter.
    let encoded = value;
    for (let index = 0; index < 2; index++) {
      encoded = JSON.stringify(encoded).slice(1, -1);
      variants.add(encoded);
    }
    try {
      const urlEncoded = encodeURIComponent(value);
      variants.add(urlEncoded);
      variants.add(encodeURIComponent(urlEncoded));
    } catch {
      /* Invalid Unicode still has raw and JSON-escaped representations above. */
    }
  }
  const ordered = [...variants].sort((a, b) => b.length - a.length);
  const text = (value: string): string => {
    let safe = value;
    for (const secret of ordered)
      safe = safe
        .split(marker)
        .map((part) => part.split(secret).join(marker))
        .join(marker);
    return safe.replace(/\bBearer\s+[^\s"']+/gi, `Bearer ${marker}`);
  };
  const json = (value: JsonValue, redactFields = true): JsonValue => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map((item) => json(item, redactFields));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [
          name,
          redactFields && isSecretField(name) ? marker : json(item, redactFields),
        ]),
      );
    return value;
  };
  return { text, json };
}
