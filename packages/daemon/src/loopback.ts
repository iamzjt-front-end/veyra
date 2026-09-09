import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { LocalRunStore } from "@veyraoss/core";
import { ProjectStateStore, projectPaths } from "@veyraoss/project";
import {
  isDaemonRequest,
  isProjectId,
  MAX_DAEMON_REQUEST_BYTES,
  type DaemonOperations,
  type DaemonMethod,
  type JsonValue,
  type ProjectDescriptor,
  type ProjectId,
} from "@veyraoss/protocol";
import { createSecretRedactor, runProcess } from "@veyraoss/runtime";
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
interface LocalClient {
  call<M extends DaemonMethod>(
    method: M,
    input: DaemonOperations[M]["input"],
  ): Promise<DaemonOperations[M]["output"]>;
}
export async function startLoopback(
  options: LoopbackOptions,
  client: LocalClient,
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
  const project = async (id: string) => {
    if (!isProjectId(id) || !allowed.has(id))
      throw new DaemonError("project_forbidden", "Project is outside the local grant.");
    const entry = await client.call("projects.get", { projectId: id });
    if (entry.status !== "available")
      throw new DaemonError("project_stale", "Repair this Project's location locally.");
    return entry.project;
  };
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
        if (!isDaemonRequest(body) || ["stop", "health", "projects.register"].includes(body.method))
          throw new DaemonError(
            "invalid_request",
            "Operation is not exposed on the loopback transport.",
          );
        if (body.method === "projects.list") {
          const entries = await client.call("projects.list", undefined);
          requireGrant();
          reply(200, { ok: true, data: entries.filter((entry) => allowed.has(entry.project.id)) });
          return;
        }
        if (!body.params || !("projectId" in body.params))
          throw new DaemonError("invalid_request", "Project identity required.");
        const selected = await project(body.params.projectId);
        requireGrant();
        let data: unknown;
        if (body.method === "projects.get") {
          data = {
            project: { id: selected.id, name: selected.name, root: selected.root },
            readiness: options.inspectProject
              ? await options.inspectProject(selected)
              : {
                  ready: false,
                  message: "No native readiness inspector configured by the local launcher.",
                  checks: [],
                },
            sharedState: (await new ProjectStateStore({ project: selected, env }).read()) ?? null,
          };
        } else if (body.method === "runs.dispatch") {
          const readiness = await options.inspectProject?.(selected);
          if (!readiness?.ready)
            throw new DaemonError(
              "native_not_ready",
              readiness?.message ?? "Configure native execution locally before dispatch.",
            );
          requireGrant();
          data = await client.call("runs.dispatch", body.params);
        } else if (body.method === "runs.get") {
          const run = await client.call("runs.get", body.params);
          const events = await new LocalRunStore({
            stateDir: projectPaths(selected).directory,
          })
            .readEvents(body.params.runId)
            .catch((error: unknown) => {
              // A queued run can precede Core's first persisted event; corrupt evidence still fails.
              if (error instanceof Error && "code" in error && error.code === "not_found")
                return [];
              throw error;
            });
          const event = [...events]
            .reverse()
            .find((event) =>
              ["agent.started", "agent.completed", "agent.failed"].includes(event.type),
            );
          data = {
            ...run,
            execution: {
              agentStatus:
                run.status === "cancelled"
                  ? "cancelled"
                  : event?.type === "agent.completed"
                    ? event.result.status
                    : event?.type === "agent.failed"
                      ? "failed"
                      : event?.type === "agent.started" && run.status === "running"
                        ? "running"
                        : "unknown",
              observedAt: new Date().toISOString(),
            },
          };
        } else if (body.method === "results.get") {
          const locator = body.params;
          const result = await client.call("results.get", locator);
          const events = result
            ? await new LocalRunStore({ stateDir: projectPaths(selected).directory }).readEvents(
                locator.runId,
              )
            : [];
          const refs = new Set(
            result?.evidence.filter((ref) => ref.source === "verifier").map((ref) => ref.eventId),
          );
          const verificationEvidence = events
            .filter(
              (event) =>
                event.type === "verification.completed" &&
                !!event.eventId &&
                refs.has(event.eventId),
            )
            .slice(-16)
            .flatMap((event) =>
              event.type === "verification.completed"
                ? [
                    {
                      eventId: event.eventId,
                      stepId: event.stepId,
                      success: event.success,
                      results: event.results.slice(0, 8).map((check) => ({
                        success: check.success,
                        exitCode: check.exitCode,
                        command: redactor.text(check.command, { truncated: true }).slice(0, 512),
                        stdout: redactor.text(check.stdout, { truncated: true }).slice(0, 1024),
                        stderr: redactor.text(check.stderr, { truncated: true }).slice(0, 512),
                        truncated:
                          check.stdoutTruncated ||
                          check.stderrTruncated ||
                          check.stdout.length > 1024 ||
                          check.stderr.length > 512 ||
                          check.command.length > 512,
                      })),
                    },
                  ]
                : [],
            );
          data = {
            result,
            verificationEvidence,
            workspaceDiff: result ? await workspaceDiff(selected, env) : null,
          };
        } else {
          switch (body.method) {
            case "runs.wait":
              data = await client.call(body.method, body.params);
              break;
            case "runs.cancel":
              data = await client.call(body.method, body.params);
              break;
            case "handoffs.get":
              data = await client.call(body.method, body.params);
              break;
            default:
              throw new DaemonError("invalid_request", "Unsupported operation.");
          }
        }
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

async function workspaceDiff(
  project: ProjectDescriptor,
  env: Readonly<Record<string, string | undefined>>,
) {
  const git = (args: string[], maxOutputBytes = 32768) =>
    runProcess({
      executable: "git",
      args,
      cwd: project.root,
      env,
      timeoutMs: 3000,
      maxOutputBytes,
    });
  const base = {
    source: "git",
    scope: "current_workspace_including_preexisting_changes",
    observedAt: new Date().toISOString(),
  };
  try {
    const root = await git(["rev-parse", "--show-toplevel"], 4096);
    if (root.exitCode !== 0 || root.stdout.trim() !== project.root)
      return {
        ...base,
        available: false,
        reason: "Project must be the Git root; parent repositories are not read.",
      };
    const patch = await git([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "HEAD",
      "--",
      ".",
      ":(exclude).veyra",
      ":(exclude,glob)**/.env*",
    ]);
    const untracked = await git(
      [
        "ls-files",
        "--others",
        "--exclude-standard",
        "--",
        ".",
        ":(exclude).veyra",
        ":(exclude,glob)**/.env*",
      ],
      4096,
    );
    const redactor = createSecretRedactor({ env });
    return {
      ...base,
      available: patch.exitCode === 0,
      patch: redactor.text(patch.stdout, { truncated: true }),
      truncated: patch.stdoutTruncated,
      untrackedFiles: untracked.stdout.split("\n").filter(Boolean).slice(0, 128),
      untrackedTruncated: untracked.stdoutTruncated,
    };
  } catch {
    return { ...base, available: false, reason: "Bounded Git inspection unavailable." };
  }
}
