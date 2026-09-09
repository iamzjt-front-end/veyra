import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  isProjectId,
  MAX_DAEMON_REQUEST_BYTES,
  type JsonValue,
  type ProjectDescriptor,
  type ProjectId,
} from "@veyraoss/protocol";
import { createSecretRedactor } from "@veyraoss/runtime";
import { projectTool, type LocalToolClient } from "./project-tool.js";
import { DaemonError, writePrivate } from "./files.js";

/** Opt-in local transport. No browser/DOM or provider-specific behavior belongs here. */
export interface LoopbackOptions {
  port: number;
  origin: string;
  projectIds: readonly ProjectId[];
  inspectProject?: (project: ProjectDescriptor) => Promise<{
    ready: boolean;
    message: string;
    checks: { id: string }[];
  }>;
}
export interface LoopbackHandle {
  url: string;
  pairingFile: string;
  stop(): Promise<void>;
}
export async function startLoopback(
  options: LoopbackOptions,
  client: LocalToolClient,
  directory: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<LoopbackHandle> {
  if (
    !Number.isInteger(options.port) ||
    (options.port !== 0 && (options.port < 1024 || options.port > 65535)) ||
    !/^chrome-extension:\/\/[a-p]{32}$/.test(options.origin) ||
    !options.projectIds.length ||
    options.projectIds.length > 8 ||
    !options.projectIds.every(isProjectId)
  )
    throw new DaemonError(
      "invalid_loopback_options",
      "Select a local port, exact extension origin and one to eight Project UUIDs.",
    );
  const allowed = new Set(options.projectIds);
  const token = randomBytes(32).toString("hex");
  const code = randomBytes(32).toString("hex");
  const pairingExpiresAt = Date.now() + 10 * 60 * 1000;
  let expiresAt = 0;
  let paired = false;
  let revoked = false;
  const redactor = createSecretRedactor({ env, values: [token, code] });
  const pairingFile = join(directory, `loopback-${randomUUID()}.json`);
  let url = "";
  let active = 0;
  let stopped = false;
  const pending = new Set<Promise<void>>();
  const authenticated = (request: IncomingMessage, revocationOnly = false) => {
    const received = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    return (
      paired &&
      (revocationOnly || (!revoked && Date.now() < expiresAt)) &&
      received.length === expected.length &&
      timingSafeEqual(received, expected)
    );
  };
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const reply = (status: number, value: unknown) => {
      const safe = redactor.json(JSON.parse(JSON.stringify(value)) as JsonValue);
      let source = JSON.stringify(safe);
      if (Buffer.byteLength(source) > 256 * 1024) {
        status = 413;
        source = JSON.stringify({
          ok: false,
          error: {
            code: "result_too_large",
            message: "Inspect this Project's saved evidence locally.",
          },
        });
      }
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(source);
    };
    if (
      stopped ||
      request.headers.host !== new URL(url).host ||
      (request.headers.origin !== undefined && request.headers.origin !== options.origin)
    ) {
      reply(403, {
        ok: false,
        error: { code: "origin_forbidden", message: "Local extension origin required." },
      });
      return;
    }
    if (request.headers.origin === options.origin) {
      response.setHeader("Access-Control-Allow-Origin", options.origin);
      response.setHeader("Vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      if (request.headers.origin !== options.origin) {
        reply(403, { ok: false });
        return;
      }
      response.setHeader("Access-Control-Allow-Methods", "GET, POST");
      response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      response.writeHead(204).end();
      return;
    }
    // Discovery reveals no registry, Project data, token or native login information.
    if (request.method === "GET" && request.url === "/health") {
      reply(200, { service: "veyra-daemon", version: 1 });
      return;
    }
    if (request.url !== "/pair" && !authenticated(request, request.url === "/grant/revoke")) {
      reply(401, {
        ok: false,
        error: {
          code: "pairing_required",
          message:
            "Pair locally; the grant is absent, expired or revoked. Restart the daemon to pair again.",
        },
      });
      return;
    }
    if (active >= 8) {
      reply(429, { ok: false, error: { code: "busy", message: "Local transport is busy." } });
      return;
    }
    active++;
    const work = (async () => {
      try {
        if (
          request.method !== "POST" ||
          !["/rpc", "/pair", "/grant/revoke"].includes(request.url ?? "") ||
          request.headers["content-type"] !== "application/json"
        )
          throw new DaemonError("invalid_request", "Use the versioned local JSON tool API.");
        const body = await readBody(request);
        if (request.url === "/pair") {
          const value = body as { version?: unknown; code?: unknown } | null;
          if (
            !value ||
            typeof value !== "object" ||
            value.version !== 1 ||
            Object.keys(value).some((key) => !["version", "code"].includes(key)) ||
            typeof value.code !== "string" ||
            !/^[a-f0-9]{64}$/.test(value.code) ||
            paired ||
            revoked ||
            stopped ||
            Date.now() >= pairingExpiresAt ||
            !timingSafeEqual(Buffer.from(value.code), Buffer.from(code))
          )
            throw new DaemonError(
              "pairing_invalid",
              "Pairing invitation is invalid, expired or already used.",
            );
          // Consume before awaiting I/O so simultaneous requests cannot exchange the code twice.
          paired = true;
          expiresAt = Date.now() + 8 * 60 * 60 * 1000;
          await unlink(pairingFile);
          // The grant is returned only here; normal responses must continue redacting it.
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              ok: true,
              data: {
                version: 1,
                url,
                origin: options.origin,
                token,
                expiresAt,
                projectIds: [...allowed],
              },
            }),
          );
          return;
        }
        const requireGrant = () => {
          if (stopped || !authenticated(request))
            throw new DaemonError("grant_unavailable", "Local grant expired or was revoked.");
        };
        if (request.url === "/grant/revoke") {
          if (
            !body ||
            typeof body !== "object" ||
            Object.keys(body).length !== 1 ||
            (body as { version?: unknown }).version !== 1
          )
            throw new DaemonError("invalid_request", "Use a versioned grant revocation request.");
          revoked = true;
          reply(200, { ok: true, data: { revoked: true } });
          return;
        }
        requireGrant();
        const data = await projectTool(body, {
          client,
          allowed: (id) => allowed.has(id),
          authorize: requireGrant,
          inspectProject: options.inspectProject,
          env,
        });
        requireGrant();
        reply(200, { ok: true, data });
      } catch (error) {
        reply(400, {
          ok: false,
          error: {
            code: error instanceof DaemonError ? error.code : "operation_failed",
            message:
              error instanceof DaemonError
                ? error.message
                : "Local operation failed; inspect the Project locally.",
          },
        });
      } finally {
        active--;
      }
    })();
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => response.destroy());
  });
  server.maxConnections = 16;
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.setTimeout(35000, (socket) => socket.destroy());
  let shutdown: Promise<void> | undefined;
  const stop = () =>
    (shutdown ??= (async () => {
      stopped = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.allSettled(pending);
      await unlink(pairingFile).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    })());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback address");
    url = `http://127.0.0.1:${address.port}`;
    await writePrivate(
      pairingFile,
      JSON.stringify({
        version: 1,
        url,
        origin: options.origin,
        code,
        expiresAt: pairingExpiresAt,
        projectIds: [...allowed],
      }),
    );
    return { url, pairingFile, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  const timer = setTimeout(() => request.destroy(), 5000);
  try {
    for await (const chunk of request) {
      size += Buffer.byteLength(chunk);
      if (size > MAX_DAEMON_REQUEST_BYTES)
        throw new DaemonError("invalid_request", "Request exceeds the local payload limit.");
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    clearTimeout(timer);
  }
}
