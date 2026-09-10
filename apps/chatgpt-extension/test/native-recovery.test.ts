import { afterEach, expect, it, vi } from "vitest";
import { NativeClient } from "../src/native-client.js";
import { handoffTemplate, type Binding } from "../src/contracts.js";
import type { ProjectId } from "@veyraoss/protocol";

const installation = "8852fd50-44a4-4aad-bd98-596e9482528c";
type Message = { version: number; id: string; method: string; installationId?: string };
function transport(mode: "hello" | "read" | "write" | "rotate" | "permanent" | "invalid") {
  vi.useFakeTimers();
  vi.stubGlobal("chrome", { runtime: {} });
  const sent: Message[] = [];
  const ports: { reply: (value: unknown) => void }[] = [];
  const connect = vi.fn(() => {
    const number = ports.length;
    let reply = (_value: unknown) => {};
    let disconnected = () => {};
    ports.push({ reply: (value) => reply(value) });
    return {
      onMessage: {
        addListener: (fn: typeof reply) => {
          reply = fn;
        },
      },
      onDisconnect: {
        addListener: (fn: typeof disconnected) => {
          disconnected = fn;
        },
      },
      disconnect: vi.fn(),
      postMessage: (message: Message) => {
        sent.push(message);
        queueMicrotask(() => {
          if (
            mode === "permanent" ||
            (mode === "hello" && number === 0) ||
            (message.method !== "hello" && (mode === "write" || number === 0))
          ) {
            disconnected();
          } else if (mode === "invalid") {
            reply({ version: 1, id: "wrong-reply", ok: true, data: {} });
          } else
            reply({
              version: 1,
              id: message.id,
              ok: true,
              data:
                message.method === "hello"
                  ? {
                      version: 1,
                      installationId:
                        mode === "rotate" && number > 0
                          ? "2f891c28-c621-414b-b2ed-9ac62ab6316f"
                          : installation,
                    }
                  : [],
            });
        });
      },
    } as unknown as chrome.runtime.Port;
  });
  return { client: new NativeClient(connect), connect, sent, ports };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("recovers a dropped handshake before any Project action, then leaves zero idle timers", async () => {
  const f = transport("hello");
  const identity = expect(f.client.identity()).resolves.toBe(installation);
  await vi.advanceTimersByTimeAsync(1000);
  await identity;
  expect(f.connect).toHaveBeenCalledTimes(2);
  expect(f.sent.map((message) => message.method)).toEqual(["hello", "hello"]);
  // Events from the retired port must never close its replacement.
  f.ports[0]?.reply({ version: 1, id: "stale", ok: true });
  expect(await f.client.identity()).toBe(installation);
  expect(f.connect).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60000);
  expect(vi.getTimerCount()).toBe(0);
});
it("reconnects a dropped evidence read once without renewing grants or changing installation", async () => {
  const f = transport("read");
  const result = expect(f.client.call("projects.list", undefined)).resolves.toEqual([]);
  await vi.advanceTimersByTimeAsync(1000);
  await result;
  expect(f.sent.map((message) => message.method)).toEqual([
    "hello",
    "projects.list",
    "hello",
    "projects.list",
  ]);
  expect(
    f.sent
      .filter((message) => message.method === "projects.list")
      .every((message) => message.installationId === installation),
  ).toBe(true);
  await vi.advanceTimersByTimeAsync(60000);
  expect(vi.getTimerCount()).toBe(0);
});
it("rejects an installation change during read recovery without sending the second Project request", async () => {
  const f = transport("rotate");
  const result = expect(f.client.call("projects.list", undefined)).rejects.toThrow(
    "authorization changed",
  );
  await vi.advanceTimersByTimeAsync(1000);
  await result;
  expect(f.sent.filter((message) => message.method === "projects.list")).toHaveLength(1);
});
it("never replays a dispatched write after the native port disappears", async () => {
  const f = transport("write");
  const projectId = "62bf60b0-5646-4195-9f47-a4ea70140859" as ProjectId;
  const b: Binding = {
    id: installation,
    projectId,
    projectName: "fixture",
    projectRoot: "/fixture",
    tabId: 1,
    epoch: "epoch",
    conversation: "https://chatgpt.com/c/test",
    phase: "armed",
    count: 0,
    maxRuns: 3,
    nextRunId: "7f208d63-7bb7-435e-9ebd-1556a253dba6",
    message: "fixture",
  };
  const result = expect(
    f.client.call("runs.dispatch", { projectId, handoff: handoffTemplate(b) }),
  ).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(60000);
  await result;
  expect(f.sent.map((message) => message.method)).toEqual(["hello", "runs.dispatch"]);
  expect(f.connect).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it.each(["permanent", "invalid"] as const)(
  "bounds %s connection failures and stops all retry timers",
  async (mode) => {
    const f = transport(mode);
    const result = expect(f.client.identity()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(60000);
    await result;
    expect(f.connect).toHaveBeenCalledTimes(mode === "permanent" ? 2 : 1);
    expect(vi.getTimerCount()).toBe(0);
  },
);
