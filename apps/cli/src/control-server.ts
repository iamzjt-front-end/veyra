import { readUiLocale, writeUiLocale, validInterfaceLocale } from "./ui-preferences.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { projectTool, type LocalToolClient } from "@veyraoss/daemon";
import {
  isDaemonRequest,
  isProjectId,
  type ProjectDescriptor,
  type ProjectId,
  type JsonValue,
} from "@veyraoss/protocol";
import { createSecretRedactor } from "@veyraoss/runtime";
import { nativeProjectReadiness } from "./native-project-readiness.js";

const secret = () => randomBytes(32).toString("hex");
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const equal = (a: unknown, b: string) =>
  typeof a === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
interface Access {
  requireGrant: boolean;
  scopes: Map<ProjectId, string>;
  expires: number;
  csrf: string;
}
interface Invitation {
  requireGrant: boolean;
  scopes: Map<ProjectId, string>;
  expires: number;
  route: string;
}
export interface ControlServerOptions {
  assets: string;
  registryRoot: string;
  client: () => Promise<LocalToolClient>;
  authorize: (grants?: ReadonlyMap<ProjectId, string>) => Promise<void>;
  inspect?: (project: ProjectDescriptor) => ReturnType<typeof nativeProjectReadiness>;
  idleMs?: number;
}
/** Local GUI transport. Its session grants cannot introduce projects, shell commands or approval decisions. */
export async function startControlServer(options: ControlServerOptions) {
  const launcherKey = secret();
  const invitations = new Map<string, Invitation>();
  const sessions = new Map<string, Access>();
  const streams = new Map<
    ServerResponse,
    { access: Access; timer?: ReturnType<typeof setTimeout> }
  >();
  const watchers = new Map<string, FSWatcher>();
  const redactor = createSecretRedactor();
  let port = 0,
    closing = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let finish: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const origin = () => `http://127.0.0.1:${port}`;
  const expire = () => {
    for (const [id, value] of sessions) if (value.expires <= Date.now()) sessions.delete(id);
    for (const [id, value] of invitations) if (value.expires <= Date.now()) invitations.delete(id);
  };
  const json = (res: ServerResponse, status: number, value: unknown) => {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) {
      res.writeHead(413);
      res.end();
      return;
    }
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(text);
  };
  const safeJson = (res: ServerResponse, value: unknown) =>
    json(res, 200, {
      ok: true,
      data: redactor.json(JSON.parse(JSON.stringify(value)) as JsonValue),
    });
  const read = async (req: IncomingMessage) => {
    if (req.headers["content-type"] !== "application/json")
      throw new Error("Invalid request content type.");
    let size = 0;
    const parts: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 256 * 1024) throw new Error("Request exceeds limit.");
      parts.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
  };
  const getAccess = (req: IncomingMessage, write = false) => {
    const key = req.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("veyra_gui="))
      ?.slice("veyra_gui=".length);
    const access = key ? sessions.get(key) : undefined;
    if (!access || access.expires <= Date.now())
      throw new Error("Local session expired. Open Veyra again.");
    if (write && !equal(req.headers["x-veyra-csrf"], access.csrf))
      throw new Error("Request authorization failed.");
    return access;
  };
  const notify = () => {
    for (const [res, stream] of streams) {
      if (stream.access.expires <= Date.now()) {
        res.end();
        continue;
      }
      if (stream.timer) continue;
      stream.timer = setTimeout(() => {
        stream.timer = undefined;
        if (!res.destroyed) res.write("event: changed\ndata: {}\n\n");
      }, 250);
    }
  };
  const attach = (path: string, recursive: boolean) => {
    if (watchers.has(path)) return;
    try {
      const watcher = watch(path, { recursive }, (_event, filename) => {
        // Meaningful state replacements only; raw token/stdout events never repaint the GUI.
        if (
          filename &&
          /(?:^|[/\\])(?:state|result|handoff|projects)\.json$/.test(String(filename))
        )
          notify();
      });
      watcher.on("error", () => {
        watcher.close();
        watchers.delete(path);
        notify();
      });
      watchers.set(path, watcher);
    } catch {
      /* A missing project is surfaced by the scoped API, never followed to another root. */
    }
  };
  const touch = () => {
    clearTimeout(idle);
    if (!streams.size && !closing)
      idle = setTimeout(() => {
        void stop();
      }, options.idleMs ?? 60000);
  };
  const issue = async (ids?: ProjectId[], route = "/overview") => {
    await options.authorize();
    expire();
    if (invitations.size >= 32) throw new Error("Too many pending local sessions.");
    const client = await options.client();
    const projects = await client.call("projects.list", undefined);
    if (ids?.some((id) => !projects.some((entry) => entry.project.id === id)))
      throw new Error("Project is not registered.");
    const scopes = new Map(
      projects
        .filter((entry) => !ids || ids.includes(entry.project.id))
        .map((entry) => [entry.project.id, entry.project.root]),
    );
    await options.authorize(ids ? scopes : undefined);
    const token = secret();
    invitations.set(token, { requireGrant: !!ids, scopes, expires: Date.now() + 60000, route });
    touch();
    return `${origin()}/#bootstrap=${token}`;
  };
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    void (async () => {
      if (
        closing ||
        req.headers.host !== `127.0.0.1:${port}` ||
        (req.headers.origin && req.headers.origin !== origin()) ||
        req.headers["sec-fetch-site"] === "cross-site"
      ) {
        json(res, 403, { ok: false, error: "Local origin required." });
        return;
      }
      expire();
      touch();
      const url = new URL(req.url ?? "/", origin());
      if (req.method === "POST" && url.pathname === "/launch") {
        if (req.headers.origin || !equal(req.headers.authorization, `Bearer ${launcherKey}`))
          throw new Error("Local launcher required.");
        const body = await read(req);
        if (
          !object(body) ||
          Object.keys(body).some((key) => !["projectId", "runId"].includes(key)) ||
          (body.projectId !== undefined && !isProjectId(body.projectId)) ||
          (body.runId !== undefined &&
            (!body.projectId ||
              typeof body.runId !== "string" ||
              !/^[a-f0-9-]{36}$/.test(body.runId)))
        )
          throw new Error("Invalid launcher request.");
        const projectId = body.projectId as ProjectId | undefined;
        const route = projectId
          ? body.runId
            ? `/projects/${projectId}/runs/${body.runId}`
            : `/projects/${projectId}`
          : "/overview";
        json(res, 200, { url: await issue(projectId ? [projectId] : undefined, route) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/session") {
        if (req.headers.origin !== origin())
          throw new Error("Same-origin session exchange required.");
        const body = await read(req);
        if (!object(body) || typeof body.token !== "string" || Object.keys(body).length !== 1)
          throw new Error("Invalid session invitation.");
        const invitation = invitations.get(body.token);
        if (!invitation || invitation.expires <= Date.now())
          throw new Error("Invitation expired. Open Veyra again.");
        // Consume before awaiting authorization: concurrent exchanges cannot reuse a nonce.
        invitations.delete(body.token);
        await options.authorize(invitation.requireGrant ? invitation.scopes : undefined);
        if (sessions.size >= 8) throw new Error("Too many local GUI sessions.");
        const token = secret(),
          csrf = secret();
        const access = {
          requireGrant: invitation.requireGrant,
          scopes: invitation.scopes,
          csrf,
          expires: Date.now() + 8 * 60 * 60 * 1000,
        };
        sessions.set(token, access);
        res.setHeader(
          "Set-Cookie",
          `veyra_gui=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
        );
        json(res, 200, { csrf, route: invitation.route });
        return;
      }
      if (url.pathname.startsWith("/api/") || url.pathname === "/events") {
        await options.authorize();
        const access = getAccess(req, req.method === "POST");
        await options.authorize(access.requireGrant ? access.scopes : undefined);
        if (req.method === "GET" && url.pathname === "/api/session") {
          json(res, 200, { csrf: access.csrf });
          return;
        }
        if (url.pathname === "/api/preferences") {
          if (req.method === "POST") {
            if (req.headers.origin !== origin())
              throw new Error("Same-origin preference update required.");
            const body = await read(req);
            if (
              !object(body) ||
              Object.keys(body).length !== 1 ||
              !validInterfaceLocale(body.locale)
            )
              throw new Error("Invalid interface preference.");
            // Recheck revocation after reading the bounded body, before persisting a UI-only preference.
            await options.authorize(access.requireGrant ? access.scopes : undefined);
            getAccess(req, true);
            await writeUiLocale(options.registryRoot, body.locale);
          } else if (req.method !== "GET") throw new Error("Unsupported preference method.");
          json(res, 200, { locale: await readUiLocale(options.registryRoot) });
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/logout") {
          for (const [id, session] of sessions) if (session === access) sessions.delete(id);
          for (const [stream, info] of streams) if (info.access === access) stream.end();
          res.setHeader("Set-Cookie", "veyra_gui=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
          json(res, 200, { ok: true });
          return;
        }
        if (req.method === "GET" && url.pathname === "/events") {
          if (streams.size >= 8) throw new Error("Too many event subscriptions.");
          attach(options.registryRoot, false);
          for (const [id, root] of access.scopes) {
            const entry = await (await options.client()).call("projects.get", { projectId: id });
            if (entry.status === "available" && entry.project.root === root) {
              const directory = join(root, ".veyra");
              if (!(await lstat(directory)).isSymbolicLink()) attach(directory, true);
            }
          }
          if (res.destroyed) {
            if (!streams.size) {
              for (const watcher of watchers.values()) watcher.close();
              watchers.clear();
            }
            return;
          }
          res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
          res.write("event: ready\ndata: {}\n\n");
          streams.set(res, { access });
          clearTimeout(idle);
          req.on("close", () => {
            clearTimeout(streams.get(res)?.timer);
            streams.delete(res);
            if (!streams.size) {
              for (const watcher of watchers.values()) watcher.close();
              watchers.clear();
            }
            touch();
          });
          return;
        }
        if (
          req.method !== "POST" ||
          url.pathname !== "/api/tool" ||
          req.headers.origin !== origin()
        )
          throw new Error("Unknown local operation.");
        const request = await read(req);
        if (
          !isDaemonRequest(request) ||
          ![
            "projects.list",
            "projects.get",
            "runs.list",
            "runs.get",
            "runs.wait",
            "runs.cancel",
            "handoffs.get",
            "results.get",
          ].includes(request.method)
        )
          throw new Error("Operation is not available in this GUI.");
        const client = await options.client();
        const data = await projectTool(request, {
          client,
          allowed: (id) => access.scopes.has(id),
          authorize: async (project?: ProjectDescriptor) => {
            await options.authorize(access.requireGrant ? access.scopes : undefined);
            if (access.expires <= Date.now() || ![...sessions.values()].includes(access))
              throw new Error("Local session expired.");
            if (project && access.scopes.get(project.id) !== project.root)
              throw new Error("Project location changed. Open it locally again.");
          },
          inspectProject:
            options.inspect ?? ((project) => nativeProjectReadiness(project, process.env)),
        });
        safeJson(res, data);
        return;
      }
      if (
        req.method !== "GET" ||
        (url.pathname !== "/" && !/^\/assets\/[A-Za-z0-9_.-]+\.(js|css|woff2)$/.test(url.pathname))
      ) {
        res.writeHead(404);
        res.end();
        return;
      }
      const path = join(options.assets, url.pathname === "/" ? "index.html" : url.pathname);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024)
        throw new Error("GUI asset unavailable.");
      res.writeHead(200, {
        "Content-Type": path.endsWith(".css")
          ? "text/css"
          : path.endsWith(".js")
            ? "text/javascript"
            : path.endsWith(".woff2")
              ? "font/woff2"
              : "text/html; charset=utf-8",
      });
      res.end(await readFile(path));
    })().catch((error) => {
      if (!res.headersSent)
        json(res, 403, {
          ok: false,
          error: redactor
            .text(error instanceof Error ? error.message : "Local connection needs attention.")
            .slice(0, 512),
        });
      else res.end();
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const stop = async () => {
    if (closing) return closed;
    closing = true;
    clearTimeout(idle);
    for (const [res, info] of streams) {
      clearTimeout(info.timer);
      res.end();
    }
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
    sessions.clear();
    invitations.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    finish();
  };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("GUI listen failed.");
  port = address.port;
  touch();
  return { origin: origin(), launcherKey, issue, stop, closed };
}
