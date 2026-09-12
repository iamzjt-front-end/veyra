import { spawn } from "node:child_process";
import { join } from "node:path";
import { DaemonClient, daemonStatus, projectTool, type LocalToolClient } from "@veyraoss/daemon";
import {
  isDaemonRequest,
  isProjectId,
  isNativeConversation,
  type ProjectDescriptor,
  type JsonValue,
} from "@veyraoss/protocol";
import { acquireLocalLock, createSecretRedactor } from "@veyraoss/runtime";
import {
  BROWSER_ORIGIN,
  builtEntry,
  privateWrite,
  readInstallation,
  nativeCodexEnvironment,
  type Installation,
} from "./native-installation.js";
import { nativeProjectReadiness } from "./native-project-readiness.js";
import { nativeConversations } from "./native-conversations.js";

export async function ensureCoordinator(statePath: string): Promise<LocalToolClient> {
  const state = await readInstallation(statePath);
  const options = { registryRoot: state.registryRoot };
  const current = await daemonStatus(options);
  if (current.status === "unavailable") throw new Error(current.message);
  if (current.status === "stopped") {
    const lock = await acquireLocalLock({
      directory: join(state.registryRoot, "browser", ".launch-lock"),
      holder: "veyra-native-launch",
      waitMs: 8000,
      recoverStale: true,
    });
    try {
      if ((await daemonStatus(options)).status === "stopped") {
        const child = spawn(process.execPath, [builtEntry("coordinator-entry.js"), statePath], {
          detached: true,
          stdio: "ignore",
          env: process.env,
        });
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        child.unref();
      }
      for (let attempt = 0; attempt < 80; attempt++) {
        if ((await daemonStatus(options)).status === "running") return new DaemonClient(options);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Veyra could not start. Open Diagnostics or run ve doctor.");
    } finally {
      await lock.release();
    }
  }
  return new DaemonClient(options);
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export class NativeService {
  private identity?: string;
  constructor(
    private readonly path: string,
    origin: string,
    private readonly connect = ensureCoordinator,
    private readonly inspect = (project: ProjectDescriptor) =>
      nativeProjectReadiness(project, process.env),
    private readonly conversations = nativeConversations,
  ) {
    if (origin !== BROWSER_ORIGIN && origin !== `${BROWSER_ORIGIN}/`)
      throw new Error("Unapproved native messaging origin.");
  }
  private async update(change: (state: Installation) => void) {
    const current = await readInstallation(this.path);
    const lock = await acquireLocalLock({
      directory: join(current.registryRoot, "browser", ".grant-lock"),
      holder: "veyra-native-grant",
      waitMs: 5000,
      recoverStale: true,
    });
    try {
      const state = await readInstallation(this.path);
      if (state.id !== this.identity)
        throw new Error("Local authorization changed. Reconnect and explicitly bind again.");
      change(state);
      await privateWrite(this.path, JSON.stringify(state));
    } finally {
      await lock.release();
    }
  }
  async handle(value: unknown): Promise<unknown> {
    const id =
      object(value) && typeof value.id === "string" && /^[a-f0-9-]{36}$/.test(value.id)
        ? value.id
        : undefined;
    try {
      if (
        !id ||
        !object(value) ||
        value.version !== 1 ||
        typeof value.method !== "string" ||
        Object.keys(value).some(
          (key) => !["id", "version", "method", "params", "installationId"].includes(key),
        )
      )
        throw new Error("Invalid native request.");
      const state = await readInstallation(this.path);
      if (value.method === "hello") {
        if (value.params !== undefined) throw new Error("Invalid hello.");
        this.identity = state.id;
        await this.update((current) => {
          current.extensionSeenAt = Date.now();
        });
        return {
          version: 1,
          id,
          ok: true,
          data: { installationId: state.id, transport: "native", version: 1 },
        };
      }
      if (this.identity !== state.id || value.installationId !== state.id)
        throw new Error("Local authorization changed. Reconnect and explicitly bind again.");
      if (value.method === "codex.conversations.list") {
        if (
          !object(value.params) ||
          Object.keys(value.params).some((key) => !["cursor", "search"].includes(key)) ||
          (value.params.cursor !== undefined &&
            (typeof value.params.cursor !== "string" || value.params.cursor.length > 4096)) ||
          (value.params.search !== undefined &&
            (typeof value.params.search !== "string" || value.params.search.length > 128))
        )
          throw new Error("Invalid Codex discovery request.");
        const data = await this.conversations.list(
          value.params as { cursor?: string; search?: string },
          nativeCodexEnvironment(state, process.env),
        );
        const current = await readInstallation(this.path);
        if (current.id !== this.identity || current.codexSocket !== state.codexSocket)
          throw new Error("Installation or native transport changed. Reconnect before continuing.");
        return this.reply(id, data);
      }
      if (value.method === "codex.conversations.select") {
        if (!isNativeConversation(value.params)) throw new Error("Invalid Codex task selection.");
        const data = await this.conversations.select(
          value.params,
          state.registryRoot,
          nativeCodexEnvironment(state, process.env),
        );
        await this.update((current) => {
          if (current.codexSocket !== state.codexSocket)
            throw new Error("Native transport changed. Select the task again.");
          if (!current.grants[data.project.id] && Object.keys(current.grants).length >= 100)
            throw new Error("Too many local Project grants.");
          const ids = [
            ...new Set([
              ...(current.grants[data.project.id]?.root === data.project.root
                ? (current.grants[data.project.id]?.nativeConversationIds ?? [])
                : []),
              data.conversation.id,
            ]),
          ];
          if (ids.length > 20)
            throw new Error(
              "Too many authorized Codex tasks for this Project. Revoke unused authorization first.",
            );
          current.grants[data.project.id] = {
            root: data.project.root,
            expiresAt: Date.now() + 365 * 86400_000,
            nativeConversationIds: ids,
          };
        });
        return this.reply(id, data);
      }
      if (value.method === "codex.conversations.check") {
        if (
          !object(value.params) ||
          Object.keys(value.params).length !== 2 ||
          !isProjectId(value.params.projectId) ||
          !isNativeConversation(value.params.conversation)
        )
          throw new Error("Invalid Codex task readiness request.");
        const projectId = value.params.projectId;
        const grant = state.grants[projectId];
        if (
          !grant ||
          grant.root !== value.params.conversation.root ||
          grant.expiresAt <= Date.now() ||
          !grant.nativeConversationIds?.includes(value.params.conversation.id)
        )
          throw new Error("Selected task is outside the Project grant.");
        const data = await this.conversations.check(
          value.params.conversation,
          projectId,
          state.registryRoot,
          nativeCodexEnvironment(state, process.env),
        );
        const current = await readInstallation(this.path);
        if (
          current.id !== this.identity ||
          current.codexSocket !== state.codexSocket ||
          current.grants[projectId]?.root !== grant.root ||
          current.grants[projectId].expiresAt <= Date.now() ||
          !current.grants[projectId]?.nativeConversationIds?.includes(value.params.conversation.id)
        )
          throw new Error("Project grant changed.");
        return this.reply(id, data);
      }
      if (value.method === "control.open") {
        if (
          !object(value.params) ||
          !isProjectId(value.params.projectId) ||
          Object.keys(value.params).some((key) => !["projectId", "runId"].includes(key)) ||
          (value.params.runId !== undefined &&
            (typeof value.params.runId !== "string" || !/^[a-f0-9-]{36}$/.test(value.params.runId)))
        )
          throw new Error("Invalid Control Center request.");
        const entry = await (
          await this.connect(this.path)
        ).call("projects.get", { projectId: value.params.projectId });
        const grant = state.grants[value.params.projectId];
        if (!grant || grant.root !== entry.project.root || grant.expiresAt <= Date.now())
          throw new Error("Project is outside the native grant.");
        const { openControlCenter } = await import("./control-launcher.js");
        return {
          version: 1,
          id,
          ok: true,
          data: await openControlCenter(this.path, {
            projectId: value.params.projectId,
            runId: value.params.runId as string | undefined,
          }),
        };
      }
      const client = await this.connect(this.path);
      if (["projects.authorize", "projects.revoke"].includes(value.method)) {
        if (
          !object(value.params) ||
          !isProjectId(value.params.projectId) ||
          Object.keys(value.params).length !== 1
        )
          throw new Error("Invalid project grant request.");
        const projectId = value.params.projectId;
        if (value.method === "projects.revoke")
          await this.update((current) => {
            delete current.grants[projectId];
          });
        else {
          const entry = await client.call("projects.get", { projectId });
          if (entry.status !== "available")
            throw new Error("Project location changed; inspect it locally.");
          await this.update((current) => {
            if (!current.grants[projectId] && Object.keys(current.grants).length >= 100)
              throw new Error("Too many local Project grants.");
            current.grants[projectId] = {
              root: entry.project.root,
              expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
              ...(current.grants[projectId]?.root === entry.project.root &&
              current.grants[projectId]?.nativeConversationIds
                ? { nativeConversationIds: current.grants[projectId].nativeConversationIds }
                : {}),
            };
          });
        }
        return {
          version: 1,
          id,
          ok: true,
          data: { authorized: value.method === "projects.authorize" },
        };
      }
      const request = {
        version: 1,
        method: value.method,
        ...(value.params === undefined ? {} : { params: value.params }),
      };
      if (!isDaemonRequest(request)) throw new Error("Invalid project operation.");
      // Registry names/locations and native readiness are setup-level discovery; engineering state needs an explicit Project grant.
      if (request.method === "projects.get" && !state.grants[request.params.projectId]) {
        const entry = await client.call("projects.get", request.params);
        if (entry.status !== "available") throw new Error("Project location changed.");
        const data = {
          authorized: false,
          project: entry.project,
          readiness: await this.inspect(entry.project),
          sharedState: null,
        };
        return this.reply(id, data);
      }
      const authorize = async (project?: ProjectDescriptor) => {
        const current = await readInstallation(this.path);
        if (current.id !== this.identity) throw new Error("Installation revoked.");
        if (project) {
          const grant = current.grants[project.id];
          if (!grant || grant.root !== project.root || grant.expiresAt <= Date.now())
            throw new Error(
              "Project authorization expired or location changed. Bind explicitly again.",
            );
          if (
            request.method === "runs.dispatch" &&
            request.params.nativeConversationId &&
            !grant.nativeConversationIds?.includes(request.params.nativeConversationId)
          )
            throw new Error("This Codex task was not explicitly authorized for the Project.");
        }
      };
      const data = await projectTool(request, {
        allowNativeConversations: true,
        client,
        allowed: (id) => !!state.grants[id],
        authorize,
        inspectProject: (project) => this.inspect(project),
      });
      // Listing is metadata-only and must include unbound Projects for explicit selection.
      return this.reply(
        id,
        request.method === "projects.list"
          ? await client.call("projects.list", undefined)
          : request.method === "projects.get" && object(data)
            ? { ...data, authorized: true }
            : data,
      );
    } catch (error) {
      return {
        version: 1,
        id,
        ok: false,
        error: createSecretRedactor()
          .text(error instanceof Error ? error.message : "Native operation failed.")
          .slice(0, 512),
      };
    }
  }
  private reply(id: string, data: unknown) {
    return {
      version: 1,
      id,
      ok: true,
      data: createSecretRedactor().json(JSON.parse(JSON.stringify(data)) as JsonValue),
    };
  }
}
