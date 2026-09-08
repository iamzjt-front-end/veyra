import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { ProjectDescriptor, NativeSessionReference } from "@veyraoss/protocol";
import type { ProcessRunner, ProcessResult } from "@veyraoss/runtime";
import { describe, expect, it, vi } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { CodexAdapter } from "../src/index.js";

async function project(root: string): Promise<ProjectDescriptor> {
  return {
    version: 1,
    id: randomUUID() as ProjectDescriptor["id"],
    root: await realpath(root),
    name: "fixture",
    createdAt: new Date().toISOString(),
  };
}
function completed(id: string, override: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    durationMs: 1,
    stdoutTruncated: false,
    stderrTruncated: false,
    stderr: "",
    stdout: [
      { type: "thread.started", thread_id: id },
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            status: "success",
            summary: "Continued",
            changedFiles: [],
            commandsRun: [],
          }),
        },
      },
      { type: "turn.completed" },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n"),
    ...override,
  };
}
describe("explicit Codex Project sessions", () => {
  it("creates and resumes only the explicit UUID under the same Project/run and permission policy", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const selected = await project(path);
      const id = randomUUID();
      const runner = vi.fn<ProcessRunner>(async () => completed(id));
      const input = {
        runId: randomUUID(),
        stepId: "execute",
        role: "executor",
        goal: "Do scoped work",
      };
      const create = new CodexAdapter({ session: { project: selected } }, { runProcess: runner });
      const first = await create.run(input, { cwd: path });
      expect(first.status).toBe("success");
      if (!first.session) throw new Error("Missing native reference");
      expect(first.session).toMatchObject({
        provider: "codex",
        projectId: selected.id,
        runId: input.runId,
        id,
      });
      expect(runner.mock.calls[0]?.[0].args).not.toContain("--ephemeral");
      const resume = new CodexAdapter(
        { session: { project: selected, resume: first.session } },
        { runProcess: runner },
      );
      const controller = new AbortController();
      const second = await resume.run(
        { ...input, stepId: "continue" },
        { cwd: path, timeoutMs: 20000, signal: controller.signal },
      );
      expect(second.session).toEqual(first.session);
      const request = runner.mock.calls[1]?.[0];
      expect(request).toMatchObject({ cwd: path, timeoutMs: 20000, signal: controller.signal });
      expect(request?.args?.slice(0, 7)).toEqual([
        "exec",
        "--sandbox",
        "workspace-write",
        "--color",
        "never",
        "resume",
        "--json",
      ]);
      expect(request?.args?.slice(-2)).toEqual([id, "-"]);
      expect(request?.args).not.toContain("--last");
      expect(request?.args).not.toContain("--all");
      expect(request?.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    });
  });
  it("refuses wrong Project/run/cwd before starting a native process", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const selected = await project(path);
      const reference: NativeSessionReference = {
        version: 1,
        kind: "session",
        provider: "codex",
        id: randomUUID(),
        projectId: selected.id,
        runId: randomUUID(),
        createdAt: selected.createdAt,
      };
      const runner = vi.fn<ProcessRunner>();
      expect(
        () =>
          new CodexAdapter({
            session: {
              project: selected,
              resume: { ...reference, projectId: randomUUID() as typeof selected.id },
            },
          }),
      ).toThrow("selected Project");
      expect(
        () =>
          new CodexAdapter({
            session: { project: selected, resume: { ...reference, provider: "other" } },
          }),
      ).toThrow("native provider");
      const adapter = new CodexAdapter(
        { session: { project: selected, resume: reference } },
        { runProcess: runner },
      );
      const input = {
        runId: reference.runId,
        stepId: "continue",
        role: "executor",
        goal: "Continue",
      };
      for (const [request, options] of [
        [input, {}],
        [input, { cwd: "/" }],
        [{ ...input, runId: randomUUID() }, { cwd: path }],
      ] as const)
        expect((await adapter.run(request, options)).error?.code).toBe("codex_session_scope");
      expect(runner).not.toHaveBeenCalled();
    });
  });
  it.each(["missing-history", "changed-id", "invalid-id", "timeout", "abort"])(
    "keeps %s explicit without starting a replacement session",
    async (mode) => {
      await withFixtureWorkspace(async ({ path }) => {
        const selected = await project(path);
        const reference: NativeSessionReference = {
          version: 1,
          kind: "session",
          provider: "codex",
          id: randomUUID(),
          projectId: selected.id,
          runId: randomUUID(),
          createdAt: selected.createdAt,
        };
        const runner = vi.fn<ProcessRunner>(async () =>
          completed(
            mode === "changed-id"
              ? randomUUID()
              : mode === "invalid-id"
                ? "../history"
                : reference.id,
            {
              ...(mode === "missing-history" ? { exitCode: 1 } : {}),
              ...(mode === "timeout" || mode === "abort"
                ? { terminationReason: mode === "timeout" ? "timeout" : "cancelled" }
                : {}),
            },
          ),
        );
        const result = await new CodexAdapter(
          { session: { project: selected, resume: reference } },
          { runProcess: runner },
        ).run(
          { runId: reference.runId, stepId: "continue", role: "executor", goal: "Continue" },
          { cwd: path },
        );
        expect(result.status).toBe("failure");
        expect(result.error?.code).toBe(
          mode === "missing-history"
            ? "codex_session_resume_failed"
            : mode === "timeout"
              ? "codex_timeout"
              : mode === "abort"
                ? "codex_cancelled"
                : "codex_session_unavailable",
        );
        expect(runner).toHaveBeenCalledTimes(1);
        if (mode === "changed-id" || mode === "invalid-id") expect(result.session).toBeUndefined();
      });
    },
  );
});
