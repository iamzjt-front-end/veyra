import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { expect, it, vi } from "vitest";
import { initializeProject } from "@veyraoss/project";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { CodexConversationAdapter } from "../src/conversation-adapter.js";
import { checkCodexConversation, listCodexConversations } from "../src/conversations.js";

async function fixture(root: string, behavior = "success") {
  const ipc = join(root, "ipc");
  await mkdir(ipc, { mode: 0o700 });
  const socket = join(ipc, "codex.sock");
  const http = createServer();
  const server = new WebSocketServer({ server: http });
  http.listen(socket);
  await once(http, "listening");
  await chmod(socket, 0o600);
  const selected = { id: randomUUID(), title: "共享的已有任务", root };
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const turns: string[] = [];
  let running!: () => void;
  const started = new Promise<void>((resolve) => {
    running = resolve;
  });
  let reads = 0;
  const send = (ws: WebSocket, value: unknown) => ws.send(JSON.stringify(value));
  const emit = (ws: WebSocket, method: string, params: unknown) => send(ws, { method, params });
  server.on("connection", (ws) =>
    ws.on("message", (data) => {
      const request = JSON.parse(data.toString());
      calls.push(request);
      if (request.id === undefined) return;
      const reply = (result: unknown) => send(ws, { id: request.id, result });
      const thread = { ...selected, name: selected.title, cwd: root, status: { type: "idle" } };
      switch (request.method) {
        case "initialize":
          if (behavior === "malformed") {
            ws.send("{broken-json");
            break;
          }
          if (behavior === "oversized") {
            ws.send("x".repeat(1024 * 1024 + 1));
            break;
          }
          if (behavior === "binary") {
            ws.send(Buffer.from("{}"));
            break;
          }
          if (behavior === "wrong-response") {
            send(ws, { id: 999999, result: {} });
            break;
          }
          reply({});
          break;
        case "thread/list":
          reply({ data: [thread], nextCursor: null });
          break;
        case "thread/read":
          reads++;
          if (behavior === "busy" || (behavior === "late-busy" && reads > 1))
            thread.status.type = "active";
          if (behavior === "unknown") thread.status.type = "notKnown";
          if (behavior === "wrong-root") thread.cwd = ipc;
          reply({ thread });
          break;
        case "thread/resume":
          reply({ thread });
          break;
        case "turn/start": {
          const turn = { id: randomUUID(), status: "inProgress", items: [] };
          turns.push(turn.id);
          if (behavior === "admission-lost") {
            running();
            ws.close();
            break;
          }
          reply({ turn });
          const params = { threadId: selected.id, turnId: turn.id };
          const user = {
            type: "userMessage",
            clientId: behavior === "foreign" ? randomUUID() : request.params.clientUserMessageId,
          };
          emit(ws, "item/started", { ...params, item: user });
          emit(ws, "item/completed", { ...params, item: user });
          if (behavior === "steered")
            emit(ws, "item/started", {
              ...params,
              item: { type: "userMessage", clientId: "desktop" },
            });
          // Foreign threads cannot supply output/ownership for the selected task.
          emit(ws, "item/completed", {
            ...params,
            threadId: randomUUID(),
            item: { type: "agentMessage", text: "WRONG THREAD" },
          });
          running();
          if (behavior === "disconnect") {
            ws.close();
            break;
          }
          if (behavior === "approval") {
            send(ws, { id: "approval-1", method: "item/commandExecution/requestApproval", params });
            break;
          }
          if (
            ["cancel", "timeout", "foreign", "steered", "interrupt-unconfirmed"].includes(behavior)
          )
            break;
          emit(ws, "item/completed", {
            ...params,
            item: {
              type: "agentMessage",
              text: JSON.stringify({
                status: "success",
                summary: "Shared task completed",
                changedFiles: [],
                commandsRun: [],
              }),
            },
          });
          emit(ws, "turn/completed", {
            threadId: selected.id,
            turn: { ...turn, status: behavior === "invalid-terminal" ? "inProgress" : "completed" },
          });
          break;
        }
        case "turn/interrupt":
          reply({});
          if (behavior !== "interrupt-unconfirmed")
            emit(ws, "turn/completed", {
              threadId: selected.id,
              turn: { id: request.params.turnId, status: "interrupted" },
            });
          break;
        default:
          throw new Error(`Unexpected shared method ${request.method}`);
      }
    }),
  );
  const owner = new WebSocket(`ws+unix://${socket}:/rpc`);
  await once(owner, "open");
  const project = await initializeProject(root);
  const runner = vi.fn();
  const options = { executable: "must-not-spawn", env: { VEYRA_CODEX_SOCKET: socket }, runner };
  const adapter = new CodexConversationAdapter(selected, project, options.executable, {
    env: options.env,
    runProcess: runner,
  });
  return {
    selected,
    socket,
    ipc,
    calls,
    turns,
    owner,
    runner,
    options,
    started,
    adapter,
    input: () => ({
      runId: randomUUID(),
      stepId: "execute",
      role: "executor" as const,
      goal: "Do this task",
    }),
    async close() {
      for (const ws of server.clients) ws.terminate();
      owner.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

it("shares one server, preserves exact task IDs across reconnects, and leaves the other client connected", async () => {
  await withFixtureWorkspace(async ({ path }) => {
    const f = await fixture(path);
    try {
      expect(await checkCodexConversation(f.options, f.selected)).toEqual({ ready: true });
      for (let i = 0; i < 2; i++) {
        const result = await f.adapter.run(f.input());
        expect(result).toMatchObject({ status: "success", session: { id: f.selected.id } });
        expect(f.owner.readyState).toBe(WebSocket.OPEN);
      }
      expect(f.turns).toHaveLength(2);
      expect(f.runner).not.toHaveBeenCalled();
      expect(f.calls.filter((c) => c.method === "turn/interrupt")).toHaveLength(0);
      expect(
        f.calls.every(
          (c) =>
            !["thread/start", "thread/fork", "thread/archive", "thread/readHistory"].includes(
              c.method,
            ),
        ),
      ).toBe(true);
      for (const c of f.calls.filter((c) => c.method === "thread/read"))
        expect(c.params.includeTurns).toBe(false);
    } finally {
      await f.close();
    }
  });
});
it.each(["malformed", "oversized", "binary", "wrong-response"])(
  "closes %s protocol input without fallback or dispatch",
  async (behavior) => {
    await withFixtureWorkspace(async ({ path }) => {
      const f = await fixture(path, behavior);
      try {
        expect((await f.adapter.run(f.input())).status).toBe("failure");
        expect(f.turns).toHaveLength(0);
        expect(f.runner).not.toHaveBeenCalled();
        expect(f.owner.readyState).toBe(WebSocket.OPEN);
      } finally {
        await f.close();
      }
    });
  },
);
it("refuses a nonterminal status even when the native event is named turn/completed", async () => {
  await withFixtureWorkspace(async ({ path }) => {
    const f = await fixture(path, "invalid-terminal");
    try {
      const result = await f.adapter.run(f.input());
      expect(result.status).toBe("failure");
      expect(result.summary).toMatch(/valid terminal state/);
      expect(f.calls.filter((c) => c.method === "turn/interrupt")).toHaveLength(1);
      expect(f.owner.readyState).toBe(WebSocket.OPEN);
    } finally {
      await f.close();
    }
  });
});
it.each(["busy", "late-busy", "unknown", "wrong-root"])(
  "refuses %s before submitting, without fallback",
  async (behavior) => {
    await withFixtureWorkspace(async ({ path }) => {
      const f = await fixture(path, behavior);
      try {
        expect((await f.adapter.run(f.input())).status).toBe("failure");
        expect(f.turns).toHaveLength(0);
        expect(f.runner).not.toHaveBeenCalled();
        expect(f.owner.readyState).toBe(WebSocket.OPEN);
      } finally {
        await f.close();
      }
    });
  },
);
it.each(["cancel", "timeout", "approval"])(
  "handles %s by interrupting only its owned turn and confirming its end",
  async (behavior) => {
    await withFixtureWorkspace(async ({ path }) => {
      const f = await fixture(path, behavior);
      try {
        const controller = new AbortController();
        const result = f.adapter.run(f.input(), {
          signal: controller.signal,
          timeoutMs: behavior === "timeout" ? 150 : 2000,
        });
        await f.started;
        if (behavior === "cancel") setTimeout(() => controller.abort(), 10);
        expect((await result).status).toBe(behavior === "approval" ? "needs_input" : "failure");
        expect(f.calls.filter((c) => c.method === "turn/interrupt").map((c) => c.params)).toEqual([
          { threadId: f.selected.id, turnId: f.turns[0] },
        ]);
        expect(f.turns).toHaveLength(1);
        expect(f.owner.readyState).toBe(WebSocket.OPEN);
        expect(f.calls.some((c) => c.method === undefined)).toBe(false);
      } finally {
        await f.close();
      }
    });
  },
);
it.each(["foreign", "steered", "disconnect", "admission-lost"])(
  "stops on %s without takeover, replay, fallback or claiming cancellation",
  async (behavior) => {
    await withFixtureWorkspace(async ({ path }) => {
      const f = await fixture(path, behavior);
      try {
        const result = await f.adapter.run(f.input(), { timeoutMs: 1000 });
        expect(result.status).toBe("failure");
        expect(result.summary).toMatch(/could not be confirmed/);
        expect(f.calls.filter((c) => c.method === "turn/interrupt")).toHaveLength(0);
        expect(f.turns).toHaveLength(1);
        expect(f.runner).not.toHaveBeenCalled();
        expect(f.owner.readyState).toBe(WebSocket.OPEN);
      } finally {
        await f.close();
      }
    });
  },
);
it("fails closed if an interrupt response is not followed by a terminal turn event", async () => {
  await withFixtureWorkspace(async ({ path }) => {
    const f = await fixture(path, "interrupt-unconfirmed");
    try {
      const result = await f.adapter.run(f.input(), { timeoutMs: 150 });
      expect(result.summary).toMatch(/could not be confirmed/);
      expect(f.calls.filter((c) => c.method === "turn/interrupt")).toHaveLength(1);
      expect(f.owner.readyState).toBe(WebSocket.OPEN);
    } finally {
      await f.close();
    }
  });
});
it("accepts only a private local socket, rejecting symlinks and network addresses without spawning", async () => {
  await withFixtureWorkspace(async ({ path }) => {
    const f = await fixture(path);
    try {
      await symlink(f.socket, join(f.ipc, "link"));
      for (const socket of [
        "ws://127.0.0.1:9000",
        "relative.sock",
        join(f.ipc, "link"),
        join(f.ipc, "missing"),
      ])
        await expect(
          listCodexConversations({ ...f.options, env: { VEYRA_CODEX_SOCKET: socket } }),
        ).rejects.toThrow();
      await chmod(f.socket, 0o666);
      await expect(listCodexConversations(f.options)).rejects.toThrow(/private/);
      await chmod(f.socket, 0o600);
      await chmod(f.ipc, 0o755);
      await expect(listCodexConversations(f.options)).rejects.toThrow(/private/);
      expect(f.runner).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
});
