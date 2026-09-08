import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  AccessDeniedError,
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
  UnsupportedGrantTypeError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

export const BRIDGE_SCOPES = ["veyra:read", "veyra:write"];
const digest = (value: string) => createHash("sha256").update(value).digest();
const nonce = () => randomBytes(32).toString("base64url");
interface Grant {
  clientId: string;
  params: AuthorizationParams;
  expires: number;
}

/** Single-user, process-lifetime pairing. OAuth protocol and PKCE validation stay in the SDK. */
export class BridgeAuth implements OAuthServerProvider {
  readonly #clients = new Map<string, OAuthClientInformationFull>();
  readonly #pending = new Map<string, Grant>();
  readonly #codes = new Map<string, Grant>();
  readonly #tokens = new Map<string, AuthInfo>();
  readonly #pairHash: Buffer;
  readonly clientsStore: OAuthRegisteredClientsStore;
  constructor(
    readonly resource: URL,
    pairingCode: string,
    readonly now = () => Date.now(),
  ) {
    if (pairingCode.length < 32)
      throw new Error("Bridge pairing code must have sufficient entropy.");
    this.#pairHash = digest(pairingCode);
    this.clientsStore = {
      getClient: (id) => {
        const client = this.#clients.get(id);
        return client ? structuredClone(client) : undefined;
      },
      registerClient: (client) => {
        if (
          this.#clients.size >= 16 ||
          client.token_endpoint_auth_method !== "none" ||
          !client.redirect_uris.length ||
          client.redirect_uris.length > 2 ||
          !client.redirect_uris.every(chatgptRedirect)
        )
          throw new InvalidClientMetadataError(
            "Use a public PKCE client and an exact ChatGPT OAuth callback.",
          );
        const registered: OAuthClientInformationFull = {
          client_id: nonce(),
          client_id_issued_at: Math.floor(this.now() / 1000),
          client_name: "Veyra ChatGPT connection",
          redirect_uris: [...client.redirect_uris],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code"],
          response_types: ["code"],
        };
        this.#clients.set(registered.client_id, registered);
        return structuredClone(registered);
      },
    };
  }
  async authorize(...[client, params, response]: Parameters<OAuthServerProvider["authorize"]>) {
    this.prune();
    this.target(params.resource);
    const scopes = params.scopes ?? [];
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge) || (params.state?.length ?? 0) > 1024)
      throw new AccessDeniedError("Invalid bounded authorization request.");
    if (!scopes.length || !scopes.every((scope) => BRIDGE_SCOPES.includes(scope)))
      throw new InvalidScopeError("Request Veyra read and/or write scopes.");
    if (
      !client.redirect_uris.includes(params.redirectUri) ||
      !chatgptRedirect(params.redirectUri) ||
      this.#pending.size >= 16
    )
      throw new AccessDeniedError("Authorization request is unavailable.");
    const transaction = nonce();
    this.#pending.set(transaction, {
      clientId: client.client_id,
      params: { ...params, scopes: [...scopes] },
      expires: this.now() + 180000,
    });
    response.setHeader("Cache-Control", "no-store");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'; base-uri 'none'",
    );
    response.setHeader("Referrer-Policy", "no-referrer");
    response
      .type("html")
      .send(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Authorize Veyra</title><h1>Authorize Veyra Project access</h1><p>This connection can ${scopes.includes("veyra:write") ? "dispatch and cancel native work, and read permitted results" : "read permitted Project state and results"} for the Projects selected when your local bridge started.</p><p>Only continue for the ChatGPT connection you are installing. Enter the bridge pairing code from the private file shown in your local terminal. This is not a Codex credential or API key.</p><form method="post" action="/approve"><input type="hidden" name="transaction" value="${transaction}"><label>Local pairing code <input name="pairingCode" type="password" required autocomplete="off" maxlength="128"></label><button type="submit">Authorize this connection</button></form></html>`,
      );
  }
  approve(transaction: string, pairingCode: string): URL {
    this.prune();
    const pending = this.#pending.get(transaction);
    if (
      !pending ||
      pairingCode.length > 128 ||
      !timingSafeEqual(digest(pairingCode), this.#pairHash)
    )
      throw new AccessDeniedError("Local authorization was not granted.");
    this.#pending.delete(transaction);
    if (this.#codes.size >= 16) throw new AccessDeniedError("Too many pending grants.");
    const code = nonce();
    this.#codes.set(code, { ...pending, expires: this.now() + 60000 });
    const redirect = new URL(pending.params.redirectUri);
    redirect.searchParams.set("code", code);
    if (pending.params.state) redirect.searchParams.set("state", pending.params.state);
    return redirect;
  }
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) {
    return this.grant(client, code).params.codeChallenge;
  }
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.target(resource);
    const grant = this.grant(client, code);
    if (redirectUri !== grant.params.redirectUri)
      throw new InvalidGrantError("Redirect does not match authorization.");
    this.#codes.delete(code);
    if (this.#tokens.size >= 32) throw new AccessDeniedError("Too many active bridge grants.");
    const token = nonce();
    const scopes = grant.params.scopes ?? [];
    this.#tokens.set(digest(token).toString("hex"), {
      token,
      clientId: client.client_id,
      scopes,
      expiresAt: Math.floor(this.now() / 1000) + 3600,
      resource: new URL(this.resource.href),
    });
    return { access_token: token, token_type: "Bearer", expires_in: 3600, scope: scopes.join(" ") };
  }
  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new UnsupportedGrantTypeError("Pair again for a new local grant.");
  }
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    this.prune();
    const info = token.length <= 128 ? this.#tokens.get(digest(token).toString("hex")) : undefined;
    if (!info || info.resource?.href !== this.resource.href)
      throw new InvalidTokenError("Bridge authorization is missing or expired.");
    return { ...info, scopes: [...info.scopes], resource: new URL(this.resource.href) };
  }
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    const key = digest(request.token).toString("hex");
    if (this.#tokens.get(key)?.clientId === client.client_id) this.#tokens.delete(key);
  }
  clear() {
    this.#clients.clear();
    this.#pending.clear();
    this.#codes.clear();
    this.#tokens.clear();
    this.#pairHash.fill(0);
  }
  private target(resource?: URL) {
    if (resource?.href !== this.resource.href)
      throw new InvalidTargetError("Authorization must target this Veyra MCP resource.");
  }
  private grant(client: OAuthClientInformationFull, code: string) {
    this.prune();
    const grant = this.#codes.get(code);
    if (!grant || grant.clientId !== client.client_id)
      throw new InvalidGrantError("Authorization code is invalid or expired.");
    return grant;
  }
  private prune() {
    for (const map of [this.#pending, this.#codes])
      for (const [key, value] of map) if (value.expires <= this.now()) map.delete(key);
    for (const [key, value] of this.#tokens)
      if ((value.expiresAt ?? 0) * 1000 <= this.now()) this.#tokens.delete(key);
  }
}

function chatgptRedirect(value: string) {
  try {
    const url = new URL(value);
    return (
      url.origin === "https://chatgpt.com" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.pathname === "/connector_platform_oauth_redirect" ||
        /^\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname))
    );
  } catch {
    return false;
  }
}
