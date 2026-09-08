import { afterEach, describe, expect, it, vi } from "vitest";
import { collectSecretValues, createSecretRedactor, isSecretField } from "../src/index.js";

afterEach(() => vi.unstubAllEnvs());

describe("explicit runtime secret redaction", () => {
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
