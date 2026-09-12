/** Explicit native smoke: owns a fresh durable fixture, private server and both test clients. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { initializeProject } from "@veyraoss/project";
import { createSecretRedactor } from "@veyraoss/runtime";
import { CodexConversationAdapter } from "../src/conversation-adapter.js";
import { checkCodexConversation } from "../src/conversations.js";

const parent = process.argv[2];
const executable = process.argv[3];
if (!parent || !executable)
  throw new Error("Supply a durable fixture parent and a native Codex executable.");
await mkdir(resolve(parent), { recursive: true });
const root = await mkdtemp(join(resolve(parent), "shared-adapter-"));
const ipc = await mkdtemp(join(tmpdir(), "ve-share-"));
const socket = join(ipc, "codex.sock");
const env: NodeJS.ProcessEnv = { ...process.env, VEYRA_CODEX_SOCKET: socket };
delete env.OPENAI_API_KEY;
await writeFile(
  join(root, "AGENTS.md"),
  "Isolated Veyra transport proof. Do not use tools, access credentials, read other tasks, or modify files. Only return the supplied acknowledgement.\n",
);
execFileSync("git", ["init", "--quiet"], { cwd: root });
const project = await initializeProject(root); // No global Registry registration.
const server = spawn(executable, ["app-server", "--listen", `unix://${socket}`], {
  cwd: root,
  env,
  stdio: ["ignore", "ignore", "pipe"],
});
let serverLog = "";
server.stderr.on("data", (chunk: Buffer) => {
  serverLog = (serverLog + chunk.toString()).slice(-4096);
});
const exited = once(server, "exit");
let owner: WebSocket | undefined;
const report: Record<string, unknown> = {
  root,
  projectId: project.id,
  serverPid: server.pid,
  apiKeyUsed: false,
  desktopMigrated: false,
};
try {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error("Owned native server exited before listening.");
    if (await lstat(socket).catch(() => undefined)) break;
    await delay(50);
  }
  report.originalSocketMode = (await lstat(socket)).mode & 0o777;
  await chmod(socket, 0o600); // This fixture owns this socket; never changes the desktop's socket.
  owner = new WebSocket(`ws+unix://${socket}:/rpc`, {
    perMessageDeflate: false,
    maxPayload: 1024 * 1024,
    handshakeTimeout: 5000,
  });
  await once(owner, "open");
  let sequence = 0;
  type Turn = { id: string; status: string };
  type Response = { thread: { id: string; status: { type: string } }; turn: Turn };
  type Params = {
    threadId: string;
    turnId?: string;
    turn?: Turn;
    item?: { type: string; clientId?: string; text?: string };
  };
  const pending = new Map<number, { resolve(value: Response): void; reject(error: Error): void }>();
  const events: { method: string; params: Params }[] = [];
  let observer: ((method: string, params: Params) => void) | undefined;
  owner.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.method) {
      if (message.id !== undefined) return; // Never automatically approve.
      events.push(message);
      if (events.length > 512) events.shift();
      observer?.(message.method, message.params);
    } else {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(message.error.message));
      else request?.resolve(message.result);
    }
  });
  const call = (method: string, params: unknown) =>
    new Promise<Response>((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 10000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      owner?.send(JSON.stringify({ id, method, params }));
    });
  const completed = async (threadId: string, turnId: string) => {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const event = events.find(
        (event) =>
          event.method === "turn/completed" &&
          event.params.threadId === threadId &&
          event.params.turn?.id === turnId,
      );
      if (event?.params.turn) return event.params.turn;
      await delay(100);
    }
    await call("turn/interrupt", { threadId, turnId });
    throw new Error("Owned proof turn timed out.");
  };
  await call("initialize", {
    clientInfo: { name: "veyra_shared_owner_proof", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  owner.send(JSON.stringify({ method: "initialized" }));
  const created = await call("thread/start", {
    cwd: root,
    approvalPolicy: "on-request",
    sandbox: "read-only",
    config: { model_reasoning_effort: "low" },
    experimentalRawEvents: false,
  });
  const id = created.thread.id;
  report.threadId = id;
  const seed = await call("turn/start", {
    threadId: id,
    input: [
      { type: "text", text: "Do not use tools. Reply exactly SHARED_SEED_OK.", text_elements: [] },
    ],
  });
  assert.equal((await completed(id, seed.turn.id)).status, "completed");
  const title = "Veyra shared native adapter proof";
  await call("thread/name/set", { threadId: id, name: title });
  const selected = { id, title, root };
  const adapter = new CodexConversationAdapter(selected, project, executable, { env });
  await checkCodexConversation({ executable, env }, selected);
  const rounds = [];
  for (let i = 0; i < 2; i++) {
    const runId = randomUUID();
    const result = await adapter.run(
      {
        runId,
        stepId: "execute",
        role: "executor",
        goal: `No tools or file changes. Return a success acknowledgement with summary SHARED_ADAPTER_${i}, no changed files or commands.`,
      },
      { timeoutMs: 120000 },
    );
    await writeFile(join(root, `round-${i}.json`), JSON.stringify({ runId, result }, null, 2));
    assert.equal(result.status, "success", JSON.stringify(result));
    assert.equal(result.session?.id, id);
    assert.equal(owner.readyState, WebSocket.OPEN);
    assert.ok(
      events.some(
        (event) =>
          event.method === "item/completed" &&
          event.params.threadId === id &&
          event.params.item?.type === "agentMessage" &&
          event.params.item.text?.includes(`SHARED_ADAPTER_${i}`),
      ),
    );
    rounds.push({ runId, sameThread: true, completed: true, ownerReceived: true });
    console.log(JSON.stringify({ stage: "shared_adapter_round", ...rounds.at(-1) }));
  }
  report.rounds = rounds;
  const controller = new AbortController();
  const cancelRun = randomUUID();
  observer = (method, params) => {
    if (
      method === "item/started" &&
      params.threadId === id &&
      params.item?.type === "userMessage" &&
      params.item.clientId === cancelRun
    )
      setTimeout(() => controller.abort(), 100);
  };
  const cancelled = await adapter.run(
    {
      runId: cancelRun,
      stepId: "execute",
      role: "executor",
      goal: "No tools or file changes. Produce a long thoughtful acknowledgement, in the required schema.",
    },
    { signal: controller.signal, timeoutMs: 120000 },
  );
  observer = undefined;
  await writeFile(join(root, "cancel.json"), JSON.stringify(cancelled, null, 2));
  assert.equal(cancelled.status, "failure");
  assert.match(cancelled.summary, /cancelled/);
  const status = await call("thread/read", { threadId: id, includeTurns: false });
  assert.equal(status.thread.status.type, "idle");
  assert.equal(owner.readyState, WebSocket.OPEN);
  report.cancel = { runId: cancelRun, idleConfirmed: true, ownerStillConnected: true };
  const busy = await call("turn/start", {
    threadId: id,
    input: [
      {
        type: "text",
        text: "No tools or changes. Produce a detailed acknowledgement of this transport test.",
        text_elements: [],
      },
    ],
  });
  const refused = await adapter.run({
    runId: randomUUID(),
    stepId: "execute",
    role: "executor",
    goal: "This must not dispatch into a running desktop turn.",
  });
  assert.equal(refused.status, "failure");
  assert.match(refused.summary, /running/);
  await call("turn/interrupt", { threadId: id, turnId: busy.turn.id });
  await completed(id, busy.turn.id);
  report.busyRefused = true;
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  // Only the isolated process's bounded transport error is reported on a failed probe.
  report.serverLog = createSecretRedactor({ env }).text(serverLog);
  throw error;
} finally {
  owner?.terminate();
  server.kill("SIGTERM");
  const timer = setTimeout(() => server.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
  report.serverStopped = true;
  await writeFile(join(root, "shared-adapter-evidence.json"), JSON.stringify(report, null, 2));
  await rm(ipc, { recursive: true, force: true });
  console.log(JSON.stringify(report));
}
