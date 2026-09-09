import { useState } from "react";
import { RunDetail } from "../src/run-detail.js";
import { WorkspaceView } from "../src/views.js";
import { controlFixture } from "./fixtures.js";
import type { ProjectId } from "@veyraoss/protocol";
export function WorkspaceFixture({ name }: { name: string }) {
  const [fixture] = useState(() => {
    const value = controlFixture(
      name === "large-projects"
        ? "projects"
        : name === "large-runs"
          ? "runs"
          : name === "empty"
            ? "overview"
            : name === "missing"
              ? "project"
              : name === "disconnected"
                ? "overview"
                : name,
    );
    if (name === "empty") {
      value.data.projects = [];
      value.data.runs = [];
    }
    if (name === "large-projects")
      value.data.projects = Array.from({ length: 3000 }, (_, i) => ({
        ...value.data.projects[0],
        status: "available" as const,
        project: {
          ...value.project.project,
          id: `62bf60b0-5646-4195-9f47-${String(i).padStart(12, "0")}` as ProjectId,
          name: `Project ${String(i).padStart(4, "0")}`,
        },
      }));
    if (name === "large-runs")
      value.data.runs = Array.from({ length: 3000 }, (_, i) => ({
        ...value.data.runs[0],
        ...value.evidence.run,
        goal: `Task ${String(i).padStart(4, "0")}`,
        runId: `712bdbd3-48e2-45d1-947e-${String(i).padStart(12, "0")}`,
      })) as typeof value.data.runs;
    return value;
  });
  const [route, navigate] = useState(fixture.route);
  return (
    <WorkspaceView
      {...fixture}
      route={route}
      project={name === "missing" ? undefined : fixture.project}
      error={
        name === "missing"
          ? "Project location is unavailable. Restore it locally or choose a different Project."
          : name === "disconnected"
            ? "The local bridge disconnected."
            : undefined
      }
      runDetail={
        <RunDetail
          evidence={fixture.evidence}
          projectRoot={fixture.project.project.root}
          cancel={() => {}}
        />
      }
      navigate={navigate}
      reconnect={() => {}}
      cancel={() => {}}
      logout={() => {}}
      theme={(theme) => {
        document.documentElement.dataset.theme = theme;
      }}
    />
  );
}
