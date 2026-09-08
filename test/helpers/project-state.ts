import type { ProjectId, ProjectProvenance, ProjectSharedState } from "@veyraoss/protocol";

export function fixtureProjectState(projectId: ProjectId): ProjectSharedState {
  const provenance: ProjectProvenance = {
    role: "planner",
    surface: "fixture-planner",
    actor: "fixture",
    at: "2026-09-08T00:00:00.000Z",
    contentTrust: "untrusted",
  };
  const context = {
    goal: "Write the project answer",
    constraints: ["Change only answer.txt"],
    decisions: [
      {
        id: "decision-1",
        summary: "Keep output local",
        rationale: "No provider required",
        provenance,
      },
    ],
    plan: {
      id: "plan-1",
      revision: 1,
      summary: "Write answer.txt",
      tasks: [{ id: "task-1", description: "Write 42" }],
      acceptanceCriteria: ["answer.txt contains 42"],
      provenance,
    },
    currentTask: "task-1",
  };
  const handoff = {
    version: 1 as const,
    kind: "handoff" as const,
    id: "handoff-1",
    projectId,
    runId: "run-1",
    provenance,
    context,
  };
  const result = {
    version: 1 as const,
    kind: "result" as const,
    id: "result-1",
    projectId,
    runId: "run-1",
    provenance: { ...provenance, role: "executor" as const, surface: "fixture-executor" },
    handoffId: handoff.id,
    status: "completed" as const,
    summary: "Wrote answer.txt",
    changedFiles: ["answer.txt"],
    evidence: [
      {
        path: "/verification",
        source: "verifier" as const,
        runId: "run-1",
        stepId: "verify",
        eventId: "event-1",
        sequence: 1,
      },
    ],
    artifacts: [
      { id: "artifact-1", kind: "diff", path: "artifacts/diff.txt", producer: { runId: "run-1" } },
    ],
  };
  return {
    version: 1,
    projectId,
    revision: 1,
    updatedAt: provenance.at,
    provenance,
    context,
    handoff,
    result,
    review: {
      version: 1,
      kind: "review",
      id: "review-1",
      projectId,
      runId: "run-1",
      resultId: result.id,
      provenance: { ...provenance, role: "reviewer", surface: "fixture-reviewer" },
      verdict: "pass",
      summary: "Acceptance met",
      nextAction: "complete",
      evidence: result.evidence,
    },
  };
}
