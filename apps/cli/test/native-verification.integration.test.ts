import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { LocalRunStore } from "@veyraoss/core";
import { DaemonClient, projectTool } from "@veyraoss/daemon";
import { initializeProject, projectPaths, saveProjectBindings } from "@veyraoss/project";
import type { ProjectExecutionResult, ProjectHandoff } from "@veyraoss/protocol";
import { ProcessExecutionError, runProcess, type ProcessRunner } from "@veyraoss/runtime";
import type { WorkflowPolicy } from "@veyraoss/workflow";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { startCoordinator } from "../src/coordinator.js";

it.each([
  { executor: "success", failedCheck: "none", boundary: "none" },
  { executor: "failure", failedCheck: "test", boundary: "none" },
  { executor: "success", failedCheck: "test", boundary: "none" },
  { executor: "success", failedCheck: "build", boundary: "none" },
  { executor: "success", failedCheck: "diff", boundary: "none" },
  { executor: "failure", failedCheck: "none", boundary: "none" },
  { executor: "needs_input", failedCheck: "none", boundary: "none" },
  { executor: "failure", failedCheck: "test", boundary: "approval" },
  { executor: "failure", failedCheck: "test", boundary: "stop" },
  { executor: "success", failedCheck: "none", boundary: "cancel" },
  { executor: "success", failedCheck: "none", boundary: "timeout" },
  { executor: "failure", failedCheck: "none", boundary: "cleanup" },
])(
  "collects independent native verification with truthful outcomes: %j",
  async (scenario) => {
    await withFixtureWorkspace(async ({ path }) => {
      const project = await initializeProject(path);
      await saveProjectBindings(project, { executor: { provider: "codex", mode: "native" } }, 0);
      const registryRoot = join(path, ".veyra", "registry");
      const commands = {
        test: "node --test",
        build: "node -e \"console.log('configured build evidence')\"",
        diff: "git diff --no-ext-diff --no-textconv -- src/message.js",
      };
      if (scenario.failedCheck === "test")
        await writeFile(
          join(path, "src/message.js"),
          "export function message() { return 'BROKEN'; }\n",
        );
      if (scenario.failedCheck === "build") commands.build += " && exit 1";
      if (scenario.failedCheck === "diff") commands.diff += " && exit 1";
      const policy: WorkflowPolicy =
        scenario.boundary === "approval"
          ? { approval: { before: ["build"] } }
          : scenario.boundary === "stop"
            ? { failureStrategy: "stop" }
            : scenario.boundary === "timeout"
              ? { stepTimeoutMs: 100 }
              : {};
      await writeFile(
        join(path, "veyra.yaml"),
        JSON.stringify({ version: 1, agents: {}, workflow: { use: "./checks.yaml" } }),
      );
      await writeFile(
        join(path, "checks.yaml"),
        JSON.stringify({
          version: 1,
          name: "configured-checks",
          start: "test",
          policy,
          steps: Object.fromEntries(
            Object.entries(commands).map(([id, command]) => [
              id,
              { type: "command", run: [command] },
            ]),
          ),
        }),
      );
      for (const args of [
        ["init", "--quiet"],
        ["add", "src", "test"],
      ])
        expect(
          (await runProcess({ executable: "git", args, cwd: path, timeoutMs: 5000 })).exitCode,
        ).toBe(0);
      const before = await readFile(join(path, "src/message.js"));
      let started = () => {};
      const running = new Promise<void>((resolve) => {
        started = resolve;
      });
      const runner = vi.fn<ProcessRunner>(async (request) => {
        started();
        expect(request.stdin).toContain("Check IDs are not npm script names");
        // Check guidance comes from trusted local configuration, never a guessed npm build script.
        for (const command of Object.values(commands))
          expect(request.stdin).toContain(JSON.stringify(JSON.stringify(command)).slice(1, -1));
        if (["cancel", "timeout"].includes(scenario.boundary))
          await delay(5000, undefined, { signal: request.signal });
        if (scenario.boundary === "cleanup")
          throw new ProcessExecutionError(
            "termination_failed",
            "Fixture child cleanup unconfirmed",
          );
        return {
          exitCode: 0,
          signal: null,
          durationMs: 1,
          stdoutTruncated: false,
          stderrTruncated: false,
          stderr: "",
          stdout: [
            { type: "thread.started", thread_id: randomUUID() },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: JSON.stringify({
                  status: scenario.executor,
                  summary: "Executor claim; independent checks must decide verification.",
                  changedFiles: [],
                  commandsRun: ["npm run guessed-script"],
                }),
              },
            },
            { type: "turn.completed" },
          ]
            .map((event) => JSON.stringify(event))
            .join("\n"),
        };
      });
      const daemon = await startCoordinator({ registryRoot, env: {}, runProcess: runner });
      try {
        const api = new DaemonClient({ registryRoot });
        await api.call("projects.register", { path });
        const handoff: ProjectHandoff = {
          version: 1,
          kind: "handoff",
          id: randomUUID(),
          runId: randomUUID(),
          projectId: project.id,
          provenance: {
            role: "planner",
            surface: "regression",
            actor: "test-runner",
            contentTrust: "untrusted",
            at: new Date().toISOString(),
          },
          context: {
            goal: "Inspect the fixture without changes or automatic repair.",
            constraints: ["Do not modify source or perform a repair."],
            decisions: [],
          },
          requestedVerification: [
            { id: "test", kind: "test" },
            { id: "build", kind: "build" },
            { id: "diff", kind: "shell" },
          ],
        };
        const locator = { projectId: project.id, runId: handoff.runId };
        await api.call("runs.dispatch", { projectId: project.id, handoff });
        if (scenario.boundary === "cancel") {
          await running;
          await api.call("runs.cancel", locator);
        }
        const view = await api.call("runs.wait", { ...locator, waitMs: 10000 });
        const paused = scenario.executor === "needs_input" || scenario.boundary === "approval";
        const passed =
          scenario.executor === "success" &&
          scenario.failedCheck === "none" &&
          scenario.boundary === "none";
        expect(view.status).toBe(
          paused
            ? "paused"
            : scenario.boundary === "cancel"
              ? "cancelled"
              : passed
                ? "completed"
                : "failed",
        );
        const executionStatus = paused
          ? "paused"
          : scenario.boundary === "cancel"
            ? "cancelled"
            : scenario.boundary === "timeout"
              ? "timed_out"
              : scenario.boundary === "cleanup"
                ? "failed"
                : "completed";
        expect(view.executionStatus).toBe(executionStatus);
        const payload = (await projectTool(
          { version: 1, method: "results.get", params: locator },
          {
            client: api,
            allowed: (id) => id === project.id,
            authorize: () => {},
            env: {},
          },
        )) as {
          result: ProjectExecutionResult | null;
          verificationEvidence: {
            eventId: string;
            stepId: string;
            results: { command: string; exitCode: number }[];
          }[];
        };
        const events = await new LocalRunStore({
          stateDir: projectPaths(project).directory,
        }).readEvents(handoff.runId);
        const checks = events.filter((event) => event.type === "verification.completed");
        const expectedIds =
          scenario.boundary === "approval"
            ? ["test"]
            : paused || ["cancel", "timeout", "stop", "cleanup"].includes(scenario.boundary)
              ? []
              : ["test", "build", "diff"];
        expect(checks.map((event) => event.stepId)).toEqual(expectedIds);
        expect(runner).toHaveBeenCalledTimes(1);
        expect(await readFile(join(path, "src/message.js"))).toEqual(before);
        expect(events.filter((event) => event.type === "agent.started")).toHaveLength(1);
        if (paused) {
          expect(payload.result).toBeNull();
          if (scenario.boundary === "approval")
            expect(events.some((event) => event.type === "approval.required")).toBe(true);
        } else {
          expect(payload.result?.status).toBe(view.status);
          expect(payload.result?.executionStatus).toBe(executionStatus);
          expect(payload.verificationEvidence.map((event) => event.stepId)).toEqual(expectedIds);
          for (const check of payload.result?.verification ?? []) {
            expect(check.status).toBe(
              !expectedIds.includes(check.id)
                ? "not_run"
                : check.id === scenario.failedCheck
                  ? "failed"
                  : "passed",
            );
            if (check.evidence) {
              const evidence = payload.verificationEvidence.find(
                (event) => event.eventId === check.evidence?.eventId,
              );
              expect(evidence?.results[0]?.command).toBe(
                commands[check.id as keyof typeof commands],
              );
              expect(evidence?.results[0]?.exitCode).toBe(check.status === "failed" ? 1 : 0);
            }
          }
          if (scenario.executor === "failure" && scenario.boundary !== "cleanup")
            expect(payload.result?.risks?.some((risk) => risk.code === "executor_failed")).toBe(
              true,
            );
          if (scenario.boundary === "cleanup")
            expect(view.error?.code).toBe("process_termination_failed");
          // Repeated reads and daemon snapshots cannot replay a failed execution/check.
          expect((await api.call("runs.get", locator)).status).toBe(view.status);
          expect((await api.call("runs.get", locator)).executionStatus).toBe(executionStatus);
          expect(runner).toHaveBeenCalledTimes(1);
        }
      } finally {
        await daemon.stop();
      }
    });
  },
  20000,
);
