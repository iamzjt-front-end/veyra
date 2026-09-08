import { createServer } from "node:http";
import { once } from "node:events";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  mcpAuthRouter,
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ErrorRequestHandler } from "express";
import { BridgeAuth, BRIDGE_SCOPES } from "./auth.js";
import { BridgeTools, type BridgeToolsOptions } from "./tools.js";

export async function startBridge(
  options: BridgeToolsOptions & {
    port?: number;
    publicUrl?: string;
    pairingCode: string;
  },
) {
  // Validate before acquiring a listening socket so rejected startup cannot leak a server.
  if (options.pairingCode.length < 32 || options.pairingCode.length > 128)
    throw new Error("Bridge pairing code must be 32–128 characters.");
  const tools = new BridgeTools(options);
  const external = options.publicUrl ? new URL(options.publicUrl) : undefined;
  if (
    external &&
    (external.protocol !== "https:" ||
      external.username ||
      external.password ||
      external.search ||
      external.hash ||
      external.pathname !== "/")
  )
    throw new Error(
      "Public Bridge URL must be an HTTPS origin without credentials, path or query.",
    );
  const app = createMcpExpressApp({
    allowedHosts: ["127.0.0.1", "localhost", ...(external ? [external.hostname] : [])],
  });
  app.disable("x-powered-by");
  const server = createServer(app);
  server.maxConnections = 32;
  server.requestTimeout = 35000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.listen(options.port ?? 3180, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Bridge did not bind loopback.");
  const localUrl = `http://127.0.0.1:${address.port}`;
  const issuer = external ?? new URL(localUrl);
  const resource = new URL("/mcp", issuer);
  const auth = new BridgeAuth(resource, options.pairingCode);
  const active = new Set<McpServer>();
  app.use((request, response, next) => {
    const origin = request.headers.origin;
    response.setHeader("Cache-Control", "no-store");
    if (origin && origin !== issuer.origin && origin !== localUrl) {
      response.status(403).json({ error: "origin_forbidden" });
      return;
    }
    next();
  });
  // Advertise precisely the proof's capabilities instead of the SDK router's refresh default.
  app.get("/.well-known/oauth-authorization-server", (_request, response) =>
    response.json({
      ...createOAuthMetadata({ provider: auth, issuerUrl: issuer, scopesSupported: BRIDGE_SCOPES }),
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
    }),
  );
  app.use(
    mcpAuthRouter({
      provider: auth,
      issuerUrl: issuer,
      resourceServerUrl: resource,
      scopesSupported: BRIDGE_SCOPES,
      resourceName: "Veyra authorized Projects",
    }),
  );
  let approvalWindow = Date.now();
  let approvals = 0;
  app.post("/approve", async (request, response) => {
    if (!request.headers.origin || !request.is("application/x-www-form-urlencoded")) {
      response.status(403).json({ error: "approval_requires_local_pairing_form" });
      return;
    }
    if (Date.now() - approvalWindow > 60000) {
      approvals = 0;
      approvalWindow = Date.now();
    }
    if (++approvals > 20) {
      response.status(429).json({ error: "too_many_approval_attempts" });
      return;
    }
    try {
      let source = "";
      for await (const chunk of request) {
        source += String(chunk);
        if (Buffer.byteLength(source) > 4096) throw new Error("Oversized approval");
      }
      const form = new URLSearchParams(source);
      if (
        form.size !== 2 ||
        form.getAll("transaction").length !== 1 ||
        form.getAll("pairingCode").length !== 1
      )
        throw new Error("Invalid approval");
      response.redirect(
        303,
        auth.approve(form.get("transaction") ?? "", form.get("pairingCode") ?? "").href,
      );
    } catch {
      response.status(403).json({ error: "local_authorization_denied" });
    }
  });
  const authenticated = requireBearerAuth({
    verifier: auth,
    requiredScopes: ["veyra:read"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
  });
  app.post("/mcp", authenticated, async (request, response) => {
    if (active.size >= 8) {
      response.status(429).json({ error: "bridge_busy" });
      return;
    }
    const mcp = tools.server(request.auth?.scopes ?? []);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    active.add(mcp);
    response.once("close", () => {
      active.delete(mcp);
      void mcp.close().catch(() => {});
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch {
      if (!response.headersSent) response.status(500).json({ error: "bridge_request_failed" });
      await mcp.close().catch(() => {});
      active.delete(mcp);
    }
  });
  app.all("/mcp", authenticated, (_request, response) =>
    response.status(405).setHeader("Allow", "POST").end(),
  );
  const rejectMalformed: ErrorRequestHandler = (error, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    // Do not echo parser input or development stack traces to the transport or logs.
    const oversized =
      typeof error === "object" && error !== null && "status" in error && error.status === 413;
    response
      .status(oversized ? 413 : 400)
      .json({ error: oversized ? "request_too_large" : "invalid_request" });
  };
  app.use(rejectMalformed);
  let closing: Promise<void> | undefined;
  return {
    localUrl,
    mcpUrl: resource.href,
    stop() {
      closing ??= (async () => {
        const closed = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        server.closeAllConnections();
        await Promise.allSettled([...active].map((mcp) => mcp.close()));
        active.clear();
        auth.clear();
        await closed;
      })();
      return closing;
    },
  };
}
