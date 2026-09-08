import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DaemonClient, startDaemon } from "@veyraoss/daemon";
import { initializeProject, ProjectHandoffStore, projectPaths } from "@veyraoss/project";
import {
  parseProjectEnvelope,
  serializeProjectEnvelope,
  type ProjectHandoff,
} from "@veyraoss/protocol";
import type { ProcessRunner } from "@veyraoss/runtime";
import { LocalRunStore } from "@veyraoss/core";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { fixtureProjectState } from "../../../test/helpers/project-state.js";
import { nativeExecution, nativeConfig } from "../src/native-executor.js";

it.each(["pass", "fail", "skip"])(
  "exchanges canonical planner/native-adapter/reviewer envelopes with actual %s verification evidence",
  async (outcome) => {
    await withFixtureWorkspace(async ({ path }) => {
      const project = await initializeProject(path);
      const fixture = fixtureProjectState(project.id);
      if (!fixture.handoff) throw new Error("Missing handoff fixture");
      const planned: ProjectHandoff = {
        ...fixture.handoff,
        runId: randomUUID(),
        references: [{ kind: "file", path: "answer.txt" }],
        requestedVerification: [{ id: "verify", kind: "test" }],
      };
      // A fake ChatGPT surface owns only the canonical wire payload, never a provider's chat store.
      const wire = serializeProjectEnvelope(planned);
      const received = parseProjectEnvelope(wire);
      if (received.kind !== "handoff") throw new Error("Wrong envelope");
      const runner = vi.fn<ProcessRunner>(async (request) => {
        expect(request.cwd).toBe(project.root);
        expect(request.stdin).toContain(JSON.stringify(wire).slice(1, -1));
        await writeFile(join(path, "answer.txt"), outcome === "fail" ? "0" : "42");
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
                  status: "success",
                  summary: "Claimed execution complete",
                  changedFiles: ["answer.txt"],
                  commandsRun: [],
                }),
              },
            },
            { type: "turn.completed" },
          ]
            .map((value) => JSON.stringify(value))
            .join("\n"),
        };
      });
      const registryRoot = join(path, "registry");
      const daemon = await startDaemon({
        registryRoot,
        env: {},
        resolveExecution: (project, handoff) => {
          const setup = nativeExecution(
            project,
            { provider: "codex", mode: "native" },
            handoff,
            {
              env: {},
              runProcess: runner,
            },
            {
              config: nativeConfig(project, { provider: "codex", mode: "native" }),
              workflow: {
                version: 1,
                name: "trusted-checks",
                start: "verify",
                steps: {
                  verify: {
                    type: "command",
                    run: [
                      "node -e \"if(require('node:fs').readFileSync('answer.txt','utf8')!=='42')process.exit(1)\"",
                    ],
                  },
                },
              },
            },
          );
          setup.workflow.steps = {
            execute: {
              type: "agent",
              agent: "executor",
              ...(outcome !== "skip" ? { next: "verify" } : {}),
            },
            verify: {
              type: "command",
              run: [
                "node -e \"if(require('node:fs').readFileSync('answer.txt','utf8')!=='42')process.exit(1)\"",
              ],
            },
          };
          return setup;
        },
      });
      try {
        const api = new DaemonClient({ registryRoot });
        await api.call("projects.register", { path });
        await expect(
          api.call("runs.dispatch", {
            projectId: project.id,
            handoff: {
              ...received,
              requestedVerification: [{ id: "arbitrary-shell", kind: "shell" }],
            },
          }),
        ).rejects.toMatchObject({ code: "verification_unconfigured" });
        expect(runner).not.toHaveBeenCalled();
        expect(
          await new ProjectHandoffStore({ project }).getHandoff(received.runId),
        ).toBeUndefined();
        await api.call("runs.dispatch", { projectId: project.id, handoff: received });
        const locator = { projectId: project.id, runId: received.runId };
        expect(await api.call("runs.wait", { ...locator, waitMs: 10000 })).toMatchObject({
          status: outcome === "pass" ? "completed" : "failed",
        });
        const result = await api.call("results.get", locator);
        const reviewed = parseProjectEnvelope(serializeProjectEnvelope(result));
        expect(reviewed).toMatchObject({
          status: outcome === "pass" ? "completed" : "failed",
          verification: [
            {
              id: "verify",
              status: outcome === "pass" ? "passed" : outcome === "fail" ? "failed" : "not_run",
            },
          ],
          diff: { source: "executor" },
          session: { provider: "codex", projectId: project.id },
        });
        if (reviewed.kind !== "result") throw new Error("Wrong result envelope");
        expect(reviewed.risks?.length).toBe(outcome === "pass" ? 0 : outcome === "fail" ? 2 : 1);
        const evidence = reviewed.verification?.[0]?.evidence;
        if (outcome !== "skip") {
          const events = await new LocalRunStore({
            stateDir: projectPaths(project).directory,
          }).readEvents(received.runId);
          expect(events.find((event) => event.eventId === evidence?.eventId)).toMatchObject({
            type: "verification.completed",
            success: outcome === "pass",
          });
        }
        expect(
          await readFile(
            join(projectPaths(project).handoffs, `${received.runId}.handoff.json`),
            "utf8",
          ),
        ).toBe(wire);
      } finally {
        await daemon.stop();
      }
    });
  },
  20000,
);
