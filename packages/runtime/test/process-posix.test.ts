import { ChildProcess, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { runProcess } from "../src/process.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(spawn).mockReset();
});

it.each(["ESRCH", "success", "EPERM"])(
  "settles graceful EPERM using the final group cleanup result: %s",
  async (finalResult) => {
    const child = new ChildProcess();
    Object.defineProperty(child, "pid", { value: 12345 });
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    vi.mocked(spawn).mockReturnValue(child);
    const kill = vi.fn((pid: number, signal: string) => {
      expect(pid).toBe(-12345);
      if (signal === "SIGTERM") {
        // Leader exit does not prove descendant cleanup; escalation must still run.
        queueMicrotask(() => child.emit("close", 0, null));
        throw Object.assign(new Error("graceful signal raced with exit"), { code: "EPERM" });
      }
      if (finalResult !== "success")
        throw Object.assign(new Error("final signal result"), { code: finalResult });
      return true;
    });
    vi.stubGlobal(
      "process",
      new Proxy(process, {
        get(target, key) {
          if (key === "platform") return "darwin";
          if (key === "kill") return kill;
          return Reflect.get(target, key);
        },
      }),
    );
    const controller = new AbortController();
    const running = runProcess({
      executable: "fixture",
      signal: controller.signal,
      terminationGraceMs: 0,
    });
    controller.abort();
    if (finalResult === "EPERM")
      await expect(running).rejects.toMatchObject({
        code: "termination_failed",
        systemCode: "EPERM",
        result: { terminationReason: "cancelled" },
      });
    else
      await expect(running).resolves.toMatchObject({ exitCode: 0, terminationReason: "cancelled" });
    expect(kill.mock.calls).toEqual([
      [-12345, "SIGTERM"],
      [-12345, "SIGKILL"],
    ]);
  },
);
