import type { JsonValue } from "@veyra/protocol";

const marker = "[REDACTED]";
/** Credential values only; plural usage fields such as inputTokens are not secrets. */
export const isSecretField = (name: string): boolean =>
  /(?:api[_-]?key|token|password|passwd|secret|authorization|cookie|(?:private|secret|access)[_-]?key(?:[_-]?id)?|credentials?)$|^(?:env|environment)$/i.test(
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
  text(value: string, options?: { truncated?: boolean }): string;
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
  const partialValues = ordered.map((secret) => ({ secret, prefixes: prefixTable(secret) }));
  const text = (value: string, context: { truncated?: boolean } = {}): string => {
    let safe = value;
    // Retained process output is a prefix. Remove an incomplete known value at
    // that boundary before exact-value filtering, including encoded variants.
    if (context.truncated && !safe.endsWith(marker)) {
      let longest = 0;
      for (const { secret, prefixes } of partialValues) {
        if (safe.endsWith(secret)) {
          longest = Math.max(longest, secret.length);
          continue;
        }
        let matched = 0;
        const start = Math.max(0, safe.length - secret.length + 1);
        for (let index = start; index < safe.length; index++) {
          while (matched > 0 && safe[index] !== secret[matched])
            matched = prefixes[matched - 1] ?? 0;
          if (safe[index] === secret[matched]) matched++;
        }
        longest = Math.max(longest, matched);
      }
      if (longest) safe = `${safe.slice(0, -longest)}${marker}`;
    }
    for (const secret of ordered)
      safe = safe
        .split(marker)
        .map((part) => part.split(secret).join(marker))
        .join(marker);
    return redactPatterns(safe);
  };
  const json = (value: JsonValue, redactFields = true): JsonValue => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map((item) => json(item, redactFields));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [
          text(name),
          redactFields && isSecretField(name)
            ? marker
            : typeof item === "string" && value[`${name}Truncated`] === true
              ? text(item, { truncated: true })
              : json(item, redactFields),
        ]),
      );
    return value;
  };
  return { text, json };
}

function prefixTable(value: string): number[] {
  const prefixes = Array<number>(value.length).fill(0);
  for (let index = 1, matched = 0; index < value.length; index++) {
    while (matched > 0 && value[index] !== value[matched]) matched = prefixes[matched - 1] ?? 0;
    if (value[index] === value[matched]) matched++;
    prefixes[index] = matched;
  }
  return prefixes;
}

/** Conservative recognizable formats, not a claim to discover arbitrary credentials. */
function redactPatterns(value: string): string {
  return value
    .replace(
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|$)/g,
      marker,
    )
    .replace(/\bsk-(?:proj-|ant-[A-Za-z0-9]+-)?[A-Za-z0-9_-]{12,}/g, marker)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, marker)
    .replace(/\bAIza[A-Za-z0-9_-]{20,}/g, marker)
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, marker)
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, marker)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, marker)
    .replace(
      /\b((?:Proxy-)?Authorization\s*:\s*Basic)\s+[^\s"']+/gi,
      (_match, scheme: string) => `${scheme} ${marker}`,
    )
    .replace(/\bBearer\s+[^\s"']+/gi, `Bearer ${marker}`);
}
