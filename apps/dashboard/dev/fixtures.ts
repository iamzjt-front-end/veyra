import { panelFixture } from "../../chatgpt-extension/dev/fixtures.js";
import type { WorkspaceViewProps } from "../src/views.js";
import type { DaemonRunSummary } from "@veyraoss/protocol";
export function controlFixture(name = "overview") {
  const panel = panelFixture(name === "failed" ? "failed" : "completed");
  const running = panelFixture("running");
  const first = panel.projects[0];
  if (!first || !panel.evidence.run || !running.evidence.run || !panel.evidence.handoff)
    throw new Error("Missing UI fixture");
  const runs: DaemonRunSummary[] = [
    {
      ...running.evidence.run,
      runId: "712bdbd3-48e2-45d1-947e-f4f865488610",
      goal: "Refine the session validation",
    },
    { ...panel.evidence.run, goal: panel.evidence.handoff.context.goal },
    {
      ...panel.evidence.run,
      runId: "712bdbd3-48e2-45d1-947e-f4f865488612",
      projectId: panel.projects[1]?.project.id ?? first.project.id,
      goal: "Improve the appointment summary",
      status: "completed",
      createdAt: "2026-09-09T09:03:00.000Z",
      updatedAt: "2026-09-09T09:07:26.000Z",
    },
    {
      ...panel.evidence.run,
      runId: "712bdbd3-48e2-45d1-947e-f4f865488613",
      projectId: panel.projects[2]?.project.id ?? first.project.id,
      goal: "Preserve photo metadata on export",
      status: "failed",
      createdAt: "2026-09-09T08:10:00.000Z",
      updatedAt: "2026-09-09T08:13:09.000Z",
    },
  ];
  return {
    data: { projects: panel.projects, runs, issues: [], hasMore: false },
    project: {
      project: first.project,
      readiness: { ready: true, message: "Native Codex is using its existing login." },
    },
    evidence: panel.evidence,
    route:
      name === "project"
        ? `/projects/${first.project.id}`
        : ["run", "failed"].includes(name)
          ? `/projects/${first.project.id}/runs/${panel.evidence.run.runId}`
          : `/${name}`,
  } satisfies Pick<WorkspaceViewProps, "data" | "route" | "project" | "evidence">;
}
