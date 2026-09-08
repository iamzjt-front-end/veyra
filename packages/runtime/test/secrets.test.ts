import { afterEach, describe, expect, it, vi } from "vitest";
import { collectSecretValues, createSecretRedactor, isSecretField } from "../src/index.js";
import { patternSecrets } from "../../../test/helpers/secret-fixtures.js";

afterEach(() => vi.unstubAllEnvs());

describe("explicit runtime secret redaction", () => {
  it.each(patternSecrets)("masks an unknown recognizable credential shape %#", (secret) => {
    const redactor = createSecretRedactor();
    expect(redactor.text(`diagnostic ${secret} end`)).toBe("diagnostic [REDACTED] end");
    expect(redactor.json({ [secret]: secret })).toEqual({ "[REDACTED]": "[REDACTED]" });
  });

  it("masks complete, escaped and incomplete private-key blocks plus Basic authorization headers", () => {
    const redactor = createSecretRedactor();
    for (const kind of ["", "RSA ", "EC ", "OPENSSH ", "ENCRYPTED "]) {
      const block = `-----BEGIN ${kind}PRIVATE KEY-----\nfixture only\n-----END ${kind}PRIVATE KEY-----`;
      expect(redactor.text(`before ${block} after`)).toBe("before [REDACTED] after");
      expect(redactor.text(JSON.stringify(block).slice(1, -1))).toBe("[REDACTED]");
      expect(redactor.text(block.split("-----END")[0] as string)).toBe("[REDACTED]");
    }
    expect(redactor.text("Authorization: Basic Zml4dHVyZTpvbmx5")).toBe(
      "Authorization: Basic [REDACTED]",
    );
    expect(redactor.text("Basic setup; sk-example; tokenBudget=100; ordinary documentation")).toBe(
      "Basic setup; sk-example; tokenBudget=100; ordinary documentation",
    );
  });

  it("removes known truncated suffixes before they become log excerpts, including overlapping and encoded values", () => {
    const secret = 'fixture/cut-"credential';
    const escaped = JSON.stringify(secret).slice(1, -1);
    const redactor = createSecretRedactor({ values: [secret, "fixture", "abcabc"] });
    for (const value of [
      secret,
      escaped,
      JSON.stringify(escaped).slice(1, -1),
      encodeURIComponent(secret),
    ])
      for (const length of [1, Math.floor(value.length / 2), value.length - 1, value.length])
        expect(redactor.text(`before ${value.slice(0, length)}`, { truncated: true })).toBe(
          "before [REDACTED]",
        );
    expect(redactor.text("abcabc", { truncated: true })).toBe("[REDACTED]");
    expect(redactor.text("before [REDACTED]", { truncated: true })).toBe("before [REDACTED]");
    expect(redactor.json({ stderr: secret.slice(0, 14), stderrTruncated: true })).toEqual({
      stderr: "[REDACTED]",
      stderrTruncated: true,
    });
    const repeated = createSecretRedactor({ values: [`${"a".repeat(30000)}b`] });
    expect(repeated.text("a".repeat(29999), { truncated: true })).toBe("[REDACTED]");
  });

  it("collects access keys and explicitly named nonstandard variables and redacts payload keys", () => {
    const env = {
      AWS_ACCESS_KEY_ID: "fixture-id",
      AWS_SECRET_ACCESS_KEY: "fixture-access",
      CUSTOM_MATERIAL: "fixture-material",
    };
    expect(collectSecretValues(env, ["CUSTOM_MATERIAL"])).toEqual(
      expect.arrayContaining(Object.values(env)),
    );
    const redactor = createSecretRedactor({ env, envNames: ["CUSTOM_MATERIAL"] });
    expect(
      redactor.json({
        "name-fixture-material": "public",
        credentials: "unknown",
        usage: { inputTokens: 3 },
      }),
    ).toEqual({
      "name-[REDACTED]": "public",
      credentials: "[REDACTED]",
      usage: { inputTokens: 3 },
    });
  });
  it("collects standard token/key variables plus explicitly named credentials without reading ambient env", () => {
    vi.stubEnv("OPENAI_API_KEY", "ambient-credential");
    const env = {
      OPENAI_API_KEY: "long-fixture-key",
      GITHUB_TOKEN: "fixture-token",
      CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth",
      APP_PASSWORD: "fixture-pass",
      SIGNING_PRIVATE_KEY: "fixture-private",
      ODD_CREDENTIAL: "custom-secret",
      PATH: "not-secret",
      EMPTY_TOKEN: "",
      DUP_API_KEY: "fixture-token",
    };
    expect(collectSecretValues(env, ["ODD_CREDENTIAL"])).toEqual(
      expect.arrayContaining([
        "long-fixture-key",
        "fixture-token",
        "fixture-oauth",
        "fixture-pass",
        "fixture-private",
        "custom-secret",
      ]),
    );
    expect(collectSecretValues(env, ["ODD_CREDENTIAL"])).toHaveLength(6);
    expect(collectSecretValues({})).toEqual([]);
    expect(createSecretRedactor().text("ambient-credential")).toBe("ambient-credential");
  });

  it("redacts overlapping raw, JSON-escaped, double-escaped and URL-encoded values", () => {
    const secret = 'fixture/secret+"quoted\\line\nvalue';
    const encoded = JSON.stringify(secret).slice(1, -1);
    const variants = [
      secret,
      encoded,
      JSON.stringify(encoded).slice(1, -1),
      encodeURIComponent(secret),
      encodeURIComponent(encodeURIComponent(secret)),
    ];
    const redact = createSecretRedactor({ values: ["fixture", secret, "REDACTED"] });
    for (const value of variants)
      expect(redact.text(`prefix ${value} suffix`)).toBe("prefix [REDACTED] suffix");
    expect(redact.text(redact.text(variants.join(" ")))).toBe(
      variants.map(() => "[REDACTED]").join(" "),
    );
  });

  it("masks bearer diagnostics and credential fields while preserving usage and caller data", () => {
    const input = {
      note: "Bearer unknown-token",
      nested: [
        {
          apiKey: "private",
          auth_token: "private",
          env: { SECRET: "private" },
          private_key: "private",
          ordinary: "public",
        },
      ],
      usage: { inputTokens: 5, outputTokens: 2, reasoningTokens: 1 },
      empty: null,
    };
    const snapshot = structuredClone(input);
    const redact = createSecretRedactor();
    expect(redact.json(input)).toEqual({
      note: "Bearer [REDACTED]",
      nested: [
        {
          apiKey: "[REDACTED]",
          auth_token: "[REDACTED]",
          env: "[REDACTED]",
          private_key: "[REDACTED]",
          ordinary: "public",
        },
      ],
      usage: input.usage,
      empty: null,
    });
    expect(input).toEqual(snapshot);
    expect(redact.json({ token: { type: "end" } }, false)).toEqual({ token: { type: "end" } });
  });

  it.each([
    "GITHUB_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "AWS_SESSION_TOKEN",
    "PRIVATE_KEY",
    "passwd",
    "api-key",
    "authorization",
    "environment",
  ])("recognizes credential field %s", (name) => {
    expect(isSecretField(name)).toBe(true);
  });
  it.each([
    "apiKeyEnv",
    "maxOutputTokens",
    "inputTokens",
    "totalTokens",
    "tokenBudget",
    "model",
    "timeoutMs",
  ])("preserves non-secret field %s", (name) => {
    expect(isSecretField(name)).toBe(false);
  });
  it("snapshots the supplied values and handles non-URL-encodable Unicode safely", () => {
    const env = { CUSTOM_TOKEN: "fixture-original" };
    const values = ["fixture-second", "\ud800"];
    const redact = createSecretRedactor({ env, values });
    env.CUSTOM_TOKEN = "changed";
    values[0] = "changed";
    expect(redact.text("fixture-original fixture-second \ud800 changed")).toBe(
      "[REDACTED] [REDACTED] [REDACTED] changed",
    );
  });
});
