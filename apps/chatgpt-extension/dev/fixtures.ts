import type { PanelSnapshot } from "../src/panel-store.js";
import type { ProjectId } from "@veyraoss/protocol";

export const fixtureTime = "2026-09-09T10:29:14.000Z";
const id = "62bf60b0-5646-4195-9f47-a4ea70140859" as ProjectId;
const runId = "712bdbd3-48e2-45d1-947e-f4f865488614";
const provenance = {
  role: "planner",
  surface: "ui-fixture",
  actor: "ChatGPT",
  at: "2026-09-09T10:27:00.000Z",
  contentTrust: "untrusted",
} as const;
export function panelFixture(name: string): PanelSnapshot {
  const projects = ["veyra-pro-proof", "kidney-care", "photo-tools"].map((name, i) => ({
    project: {
      version: 1 as const,
      id: (i ? `62bf60b0-5646-4195-9f47-a4ea7014085${i}` : id) as ProjectId,
      name,
      root: `/Users/developer/Projects/${name}`,
      createdAt: provenance.at,
    },
    status: "available" as const,
  }));
  const first = projects[0];
  if (!first) throw new Error("Fixture requires a Project");
  const state: PanelSnapshot = {
    loading: false,
    busy: false,
    projects,
    projectId: id,
    connected: true,
    currentBound: name !== "unbound",
    conversation: `https://chatgpt.com/c/${runId}`,
    tabId: 10,
    enabled: true,
    selected: {
      project: first.project,
      readiness: { ready: true, message: "Codex ready", checks: [{ id: "test" }, { id: "build" }] },
      sharedState: null,
    },
    evidence: {},
  };
  if (name === "unbound") return state;
  state.binding = {
    id: runId,
    tabId: 10,
    epoch: "fixture",
    conversation: `https://chatgpt.com/c/${runId}`,
    projectId: id,
    projectName: "veyra-pro-proof",
    projectRoot: first.project.root,
    maxRuns: 3,
    count: 0,
    nextRunId: runId,
    phase: "armed",
    message: "Waiting for ChatGPT",
  };
  if (name === "idle") return state;
  if (name === "disconnected") {
    state.connected = false;
    return state;
  }
  if (name === "no-projects") {
    state.projects = [];
    state.projectId = "";
    state.currentBound = false;
    state.binding = undefined;
    return state;
  }
  const terminal = ["completed", "failed", "cancelled"].includes(name);
  state.binding.runId = runId;
  state.binding.runStatus = terminal ? name : "running";
  state.binding.phase = terminal ? "armed" : "running";
  const goal = "Implement the login flow";
  state.evidence = {
    stage: name === "verification" ? "verify" : "execute",
    run: {
      version: 1,
      projectId: id,
      runId,
      status: terminal ? (name as "completed" | "failed" | "cancelled") : "running",
      createdAt: provenance.at,
      updatedAt: fixtureTime,
    },
    handoff: {
      version: 1,
      kind: "handoff",
      id: runId,
      projectId: id,
      runId,
      provenance,
      context: {
        goal,
        constraints: ["Keep the existing session contract"],
        decisions: [],
        plan: {
          id: "login-plan",
          revision: 1,
          summary: "Add Apple and WeChat sign-in to the existing account system.",
          tasks: [{ id: "auth", description: "Implement native sign-in adapters" }],
          acceptanceCriteria: [
            "Existing users can sign in",
            "Session validation and build checks pass",
          ],
          provenance,
        },
      },
    },
  };
  if (terminal) {
    const status = name as "completed" | "failed" | "cancelled";
    state.binding.lastResult = {
      runId,
      status,
      summary: "Sign-in adapters and session validation are implemented.",
      delivery: "confirmed",
    };
    state.evidence.result = {
      version: 1,
      kind: "result",
      id: runId,
      projectId: id,
      runId,
      handoffId: runId,
      status,
      summary: "Sign-in adapters and session validation are implemented.",
      changedFiles: [
        "src/auth/apple.ts",
        "src/auth/wechat.ts",
        "src/api/session.ts",
        "src/components/Login.vue",
      ],
      evidence: [],
      artifacts: [{ id: "build-output", kind: "build", path: "artifacts/build-report.txt" }],
      provenance: { ...provenance, role: "executor", actor: "Codex" },
      verification: ["test", "build", "typecheck"].map((check) => ({
        id: check,
        status: name === "failed" && check === "test" ? "failed" : "passed",
        evidence: {
          source: "verifier",
          runId,
          stepId: check,
          eventId: `verify-${check}`,
          sequence: 1,
          path: "events.jsonl",
        },
      })),
    };
    state.evidence.verificationEvidence = ["test", "build", "typecheck"].map((check) => ({
      stepId: check,
      success: !(name === "failed" && check === "test"),
      results: [
        {
          success: !(name === "failed" && check === "test"),
          exitCode: name === "failed" && check === "test" ? 1 : 0,
          command: `pnpm ${check}`,
          stdout:
            name === "failed" && check === "test"
              ? "Session expiry: expected expired token to be rejected.\n1 test failed."
              : "Check passed.",
          stderr: "",
          durationMs: 1800,
        },
      ],
    }));
  }
  if (name === "paused") {
    state.enabled = false;
    state.binding.pausedByUser = true;
    state.binding.phase = "stopped";
  }
  return state;
}
