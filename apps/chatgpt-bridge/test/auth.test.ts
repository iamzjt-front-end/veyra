import { randomBytes } from "node:crypto";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { expect, it } from "vitest";
import { BridgeAuth } from "../src/auth.js";
import { callback } from "./oauth-client.js";

async function fixture() {
  let now = 1000000;
  const pairing = randomBytes(32).toString("base64url");
  const resource = new URL("http://127.0.0.1:3180/mcp");
  const auth = new BridgeAuth(resource, pairing, () => now);
  const client = await auth.clientsStore.registerClient?.({
    redirect_uris: [callback],
    token_endpoint_auth_method: "none",
  });
  if (!client) throw new Error("Missing client");
  const pending = async () => {
    let html = "";
    const response = {
      setHeader() {},
      type() {
        return {
          send(value: string) {
            html = value;
          },
        };
      },
    };
    await auth.authorize(
      client,
      {
        codeChallenge: "a".repeat(43),
        redirectUri: callback,
        resource,
        scopes: ["veyra:read", "veyra:write"],
        state: "fixture",
      },
      response as unknown as Parameters<OAuthServerProvider["authorize"]>[2],
    );
    const transaction = /name="transaction" value="([^"]+)"/.exec(html)?.[1];
    if (!transaction) throw new Error("Missing transaction");
    expect(html).not.toContain(pairing);
    return transaction;
  };
  const grant = async () => {
    const location = auth.approve(await pending(), pairing);
    const code = location.searchParams.get("code");
    if (!code) throw new Error("Missing code");
    return code;
  };
  return {
    auth,
    pairing,
    resource,
    client,
    pending,
    grant,
    advance(ms: number) {
      now += ms;
    },
  };
}

it("requires the private pairing code and expires abandoned browser approvals", async () => {
  const f = await fixture();
  const transaction = await f.pending();
  expect(() => f.auth.approve(transaction, "wrong")).toThrow("not granted");
  f.advance(180000);
  expect(() => f.auth.approve(transaction, f.pairing)).toThrow("not granted");
  f.auth.clear();
});

it("expires authorization codes and tokens and rejects tokens after process state is cleared", async () => {
  const f = await fixture();
  const expired = await f.grant();
  f.advance(60000);
  await expect(f.auth.challengeForAuthorizationCode(f.client, expired)).rejects.toThrow("expired");
  const code = await f.grant();
  const token = await f.auth.exchangeAuthorizationCode(
    f.client,
    code,
    undefined,
    callback,
    f.resource,
  );
  expect(await f.auth.verifyAccessToken(token.access_token)).toMatchObject({
    clientId: f.client.client_id,
    scopes: ["veyra:read", "veyra:write"],
  });
  f.advance(3600000);
  await expect(f.auth.verifyAccessToken(token.access_token)).rejects.toThrow("expired");
  const next = await f.auth.exchangeAuthorizationCode(
    f.client,
    await f.grant(),
    undefined,
    callback,
    f.resource,
  );
  f.auth.clear();
  await expect(f.auth.verifyAccessToken(next.access_token)).rejects.toThrow("expired");
  expect(await f.auth.clientsStore.getClient(f.client.client_id)).toBeUndefined();
});

it("bounds unapproved requests and rejects cross-client code redemption", async () => {
  const f = await fixture();
  const code = await f.grant();
  await expect(
    f.auth.challengeForAuthorizationCode({ ...f.client, client_id: "other" }, code),
  ).rejects.toThrow("invalid");
  for (let count = 0; count < 16; count++) await f.pending();
  await expect(f.pending()).rejects.toThrow("unavailable");
  f.auth.clear();
});
