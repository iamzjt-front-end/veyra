import { LocalRunStore } from "@veyraoss/core";
import { ProjectStateStore, projectPaths } from "@veyraoss/project";
import {
  isDaemonRequest,
  isProjectId,
  type DaemonMethod,
  type DaemonOperations,
  type ProjectDescriptor,
  type ProjectId,
} from "@veyraoss/protocol";
import { createSecretRedactor, runProcess } from "@veyraoss/runtime";
import { DaemonError } from "./files.js";
import type { LoopbackOptions } from "./loopback.js";
export interface LocalToolClient {
  call<M extends DaemonMethod>(
    method: M,
    input: DaemonOperations[M]["input"],
  ): Promise<DaemonOperations[M]["output"]>;
}
/** Transport-neutral, bounded Project evidence API. Authorization belongs to its local transport. */
export async function projectTool(
  body: unknown,
  options: {
    client: LocalToolClient;
    allowed: (id: ProjectId) => boolean;
    authorize: (project?: ProjectDescriptor) => void | Promise<void>;
    inspectProject?: LoopbackOptions["inspectProject"];
    env?: Readonly<Record<string, string | undefined>>;
    allowNativeConversations?: boolean;
  },
): Promise<unknown> {
  const { client, allowed, inspectProject } = options;
  const env = options.env ?? process.env;
  const redactor = createSecretRedactor({ env });
  let selectedProject: ProjectDescriptor | undefined;
  const requireGrant = () => options.authorize(selectedProject);
  const project = async (id: string) => {
    if (!isProjectId(id) || !allowed(id))
      throw new DaemonError("project_forbidden", "Project is outside the local grant.");
    const entry = await client.call("projects.get", { projectId: id });
    if (entry.status !== "available")
      throw new DaemonError("project_stale", "Repair this Project's location locally.");
    selectedProject = entry.project;
    return entry.project;
  };
  if (!isDaemonRequest(body) || ["stop", "health", "projects.register"].includes(body.method))
    throw new DaemonError("invalid_request", "Operation is not exposed on this Project transport.");
  if (body.method === "projects.list") {
    const entries = await client.call("projects.list", undefined);
    await requireGrant();
    return entries.filter((entry) => allowed(entry.project.id));
  }
  if (!body.params || !("projectId" in body.params))
    throw new DaemonError("invalid_request", "Project identity required.");
  const selected = await project(body.params.projectId);
  await requireGrant();
  let data: unknown;
  if (body.method === "projects.get") {
    data = {
      project: { id: selected.id, name: selected.name, root: selected.root },
      readiness: inspectProject
        ? await inspectProject(selected)
        : {
            ready: false,
            message: "No native readiness inspector configured by the local launcher.",
            checks: [],
          },
      sharedState: (await new ProjectStateStore({ project: selected, env }).read()) ?? null,
    };
  } else if (body.method === "runs.dispatch") {
    if (body.params.nativeConversationId && !options.allowNativeConversations)
      throw new DaemonError(
        "conversation_forbidden",
        "Existing native conversations require explicit Native Bridge authorization.",
      );
    const readiness = await inspectProject?.(selected);
    if (!readiness?.ready)
      throw new DaemonError(
        "native_not_ready",
        readiness?.message ?? "Configure native execution locally before dispatch.",
      );
    await requireGrant();
    data = await client.call("runs.dispatch", body.params);
  } else if (body.method === "runs.get") {
    const run = await client.call("runs.get", body.params);
    const events = await new LocalRunStore({
      stateDir: projectPaths(selected).directory,
    })
      .readEvents(body.params.runId)
      .catch((error: unknown) => {
        // A queued run can precede Core's first persisted event; corrupt evidence still fails.
        if (error instanceof Error && "code" in error && error.code === "not_found") return [];
        throw error;
      });
    const event = [...events]
      .reverse()
      .find((event) => ["agent.started", "agent.completed", "agent.failed"].includes(event.type));
    data = {
      ...run,
      execution: {
        stage:
          [...events]
            .reverse()
            .find((event) =>
              ["agent.started", "verification.started", "verification.completed"].includes(
                event.type,
              ),
            )?.type === "verification.started"
            ? "verify"
            : ["completed", "failed", "cancelled"].includes(run.status)
              ? "review"
              : "execute",
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
          event.type === "verification.completed" && !!event.eventId && refs.has(event.eventId),
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
                  durationMs: check.durationMs,
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
      review: result ? await client.call("reviews.get", locator) : null,
      verificationEvidence,
      workspaceDiff: result ? await workspaceDiff(selected, env) : null,
    };
  } else {
    switch (body.method) {
      case "runs.list":
        data = await client.call(body.method, body.params);
        break;
      case "runs.wait":
        data = await client.call(body.method, body.params);
        break;
      case "runs.cancel":
        data = await client.call(body.method, body.params);
        break;
      case "handoffs.get":
        data = await client.call(body.method, body.params);
        break;
      case "reviews.get":
        data = await client.call(body.method, body.params);
        break;
      case "reviews.submit":
        await requireGrant();
        data = await client.call(body.method, body.params);
        break;
      default:
        throw new DaemonError("invalid_request", "Unsupported operation.");
    }
  }
  await requireGrant();
  return data;
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
