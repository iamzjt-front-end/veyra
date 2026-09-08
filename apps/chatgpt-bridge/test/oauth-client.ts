import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const callback = "https://chatgpt.com/connector_platform_oauth_redirect";
export async function register(localUrl: string) {
  const response = await fetch(`${localUrl}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "test",
      redirect_uris: [callback],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    }),
  });
  assert.equal(response.status, 201);
  return (await response.json()) as { client_id: string };
}
export async function authorize(
  localUrl: string,
  pairingCode: string,
  scopes = "veyra:read veyra:write",
  resource = `${localUrl}/mcp`,
) {
  const client = await register(localUrl);
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    client_id: client.client_id,
    response_type: "code",
    redirect_uri: callback,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    scope: scopes,
    resource,
    state: "fixture-state",
  });
  const response = await fetch(`${localUrl}/authorize?${query}`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(!html.includes(pairingCode));
  const transaction = /name="transaction" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(transaction);
  const approved = await fetch(`${localUrl}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: localUrl },
    body: new URLSearchParams({ transaction, pairingCode }),
    redirect: "manual",
  });
  assert.equal(approved.status, 303);
  const location = new URL(approved.headers.get("location") ?? "");
  assert.equal(location.searchParams.get("state"), "fixture-state");
  const code = location.searchParams.get("code");
  assert.ok(code);
  const params = {
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    code_verifier: verifier,
    redirect_uri: callback,
    resource,
  };
  return { client, params, transaction };
}
export async function token(localUrl: string, params: Record<string, string>) {
  return fetch(`${localUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
}
export async function connect(localUrl: string, pairingCode: string, scopes?: string) {
  const grant = await authorize(localUrl, pairingCode, scopes);
  const response = await token(localUrl, grant.params);
  assert.equal(response.status, 200);
  const { access_token } = (await response.json()) as { access_token: string };
  const client = new Client({ name: "fake-chatgpt-proof", version: "0.1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${localUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${access_token}` } },
    }),
  );
  return { client, accessToken: access_token, clientId: grant.client.client_id };
}
