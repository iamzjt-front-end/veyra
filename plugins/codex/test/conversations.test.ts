import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { initializeProject } from "@veyraoss/project";
import type { ProcessRunner } from "@veyraoss/runtime";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import {
  listCodexConversations,
  readCodexConversation,
  checkCodexConversation,
} from "../src/conversations.js";
import { CodexConversationAdapter } from "../src/conversation-adapter.js";

function protocol(root: string, behavior = "success") {
  const id = randomUUID();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const runner: ProcessRunner = (request) =>
    new Promise((resolve) => {
      expect(request.args).toEqual(["app-server"]);
      expect(request.maxOutputBytes).toBe(0);
      request.signal?.addEventListener(
        "abort",
        () =>
          resolve({
            exitCode: null,
            signal: "SIGTERM",
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            durationMs: 1,
          }),
        { once: true },
      );
      const send = (value: unknown) => request.onStdout?.(`${JSON.stringify(value)}\n`);
      const thread = {
        id,
        name: "已有中文 task",
        cwd: root,
        preview: "PRIVATE OLD CHAT",
        turns: [],
      };
      request.onStdin?.({
        end() {},
        write(chunk) {
          const message = JSON.parse(chunk);
          calls.push(message);
          if (message.id === undefined) return;
          queueMicrotask(() => {
            const reply = (result: unknown) => send({ id: message.id, result });
            switch (message.method) {
              case "initialize":
                reply({});
                break;
              case "thread/list":
                if (behavior === "oversized") {
                  request.onStdout?.("x".repeat(1024 * 1024 + 1));
                  break;
                }
                if (behavior === "malformed") {
                  request.onStdout?.("{bad JSON}\n");
                  break;
                }
                reply({ data: [thread, { ...thread, name: null }], nextCursor: null });
                break;
              case "thread/read":
                reply({
                  thread:
                    behavior === "wrong-id"
                      ? { ...thread, id: randomUUID() }
                      : behavior === "moved-root"
                        ? { ...thread, cwd: join(root, "another-project") }
                        : thread,
                });
                break;
              case "thread/resume":
                if (behavior === "busy")
                  send({
                    id: message.id,
                    error: { message: "thread already has an active writer" },
                  });
                else reply({ thread });
                break;
              case "turn/start": {
                const turn = { id: randomUUID(), status: "inProgress" };
                reply({ turn });
                if (behavior === "approval") {
                  send({ id: 999, method: "item/commandExecution/requestApproval", params: {} });
                  break;
                }
                if (behavior === "cancel") break;
                // Deliver before the turn/start promise resumes, to test event/response races.
                send({
                  method: "item/completed",
                  params: {
                    threadId: id,
                    turnId: turn.id,
                    item: {
                      type: "agentMessage",
                      text: JSON.stringify({
                        status: "success",
                        summary: "same native conversation",
                        changedFiles: [],
                        commandsRun: [],
                      }),
                    },
                  },
                });
                send({
                  method: "turn/completed",
                  params: { threadId: id, turn: { ...turn, status: "completed" } },
                });
                break;
              }
              default:
                throw new Error(`Unexpected native method ${message.method}`);
            }
          });
        },
      });
    });
  return { id, calls, runner, selected: { id, title: "已有中文 task", root } };
}
it("lists only safe metadata and never requests turn/history hydration", async () => {
  const f = protocol("/project");
  const options = { executable: "codex", runner: f.runner };
  expect(await listCodexConversations(options, { search: "中文", cursor: "page2" })).toEqual({
    conversations: [f.selected],
    cursor: null,
  });
  expect(await readCodexConversation(options, f.id)).toEqual(f.selected);
  expect(f.calls.find((call) => call.method === "thread/list")?.params).toMatchObject({
    useStateDbOnly: true,
    searchTerm: "中文",
    cursor: "page2",
    limit: 30,
  });
  expect(f.calls.find((call) => call.method === "thread/read")?.params).toEqual({
    threadId: f.id,
    includeTurns: false,
  });
});
it("continues the exact selected native task across distinct Veyra runs", async () => {
  await withFixtureWorkspace(async ({ path }) => {
    const project = await initializeProject(path);
    const f = protocol(project.root);
    const adapter = new CodexConversationAdapter(f.selected, project, "codex", {
      env: {},
      runProcess: f.runner,
    });
    for (let index = 0; index < 2; index++) {
      const runId = randomUUID();
      const result = await adapter.run(
        { runId, stepId: "execute", role: "executor", goal: "Do the selected task" },
        { cwd: project.root },
      );
      expect(result.status).toBe("success");
      expect(result.session).toMatchObject({ id: f.id, projectId: project.id, runId });
    }
    const resumes = f.calls.filter((call) => call.method === "thread/resume");
    expect(resumes).toHaveLength(2);
    for (const call of resumes)
      expect(call.params).toEqual({
        threadId: f.id,
        excludeTurns: true,
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
      });
    for (const call of f.calls.filter((call) => call.method === "turn/start"))
      expect(call.params.threadId).toBe(f.id);
    expect(f.calls.some((call) => ["thread/start", "thread/fork"].includes(call.method))).toBe(
      false,
    );
  });
});
it.each(["busy", "wrong-id", "moved-root"])(
  "rejects %s without dispatch, takeover or fallback",
  async (behavior) => {
    await withFixtureWorkspace(async ({ path }) => {
      const project = await initializeProject(path);
      await mkdir(join(project.root, "another-project"));
      const f = protocol(project.root, behavior);
      await expect(
        checkCodexConversation({ executable: "codex", runner: f.runner }, f.selected),
      ).rejects.toThrow();
      const result = await new CodexConversationAdapter(f.selected, project, "codex", {
        env: {},
        runProcess: f.runner,
      }).run({ runId: randomUUID(), stepId: "execute", role: "executor", goal: "Do not redirect" });
      expect(result.status).toBe("failure");
      expect(f.calls.some((call) => call.method === "turn/start")).toBe(false);
    });
  },
);
it.each(["oversized", "malformed"])(
  "closes %s metadata responses without retry",
  async (behavior) => {
    const f = protocol("/project", behavior);
    await expect(
      listCodexConversations({ executable: "codex", runner: f.runner }),
    ).rejects.toThrow();
    expect(f.calls.filter((call) => call.method === "thread/list")).toHaveLength(1);
    expect(
      f.calls.some((call) => ["thread/read", "thread/resume", "turn/start"].includes(call.method)),
    ).toBe(false);
  },
);
it("requires human input for native approval and never automatically approves", async () => {
  await withFixtureWorkspace(async ({ path }) => {
    const project = await initializeProject(path);
    const f = protocol(project.root, "approval");
    const result = await new CodexConversationAdapter(f.selected, project, "codex", {
      env: {},
      runProcess: f.runner,
    }).run({
      runId: randomUUID(),
      stepId: "execute",
      role: "executor",
      goal: "May require approval",
    });
    expect(result.status).toBe("needs_input");
    expect(f.calls.some((call) => call.method === undefined)).toBe(false);
  });
});
it("cancels its owned server without resending the turn", async () => {
  await withFixtureWorkspace(async ({ path }) => {
    const project = await initializeProject(path);
    const f = protocol(project.root, "cancel");
    const controller = new AbortController();
    const result = new CodexConversationAdapter(f.selected, project, "codex", {
      env: {},
      runProcess: f.runner,
    }).run(
      { runId: randomUUID(), stepId: "execute", role: "executor", goal: "Cancelable task" },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 40);
    expect((await result).status).toBe("failure");
    expect(f.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
  });
});
