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

it.each([
  { platform: "darwin", finalResult: "ESRCH", transient: 0, attempts: 1 },
  { platform: "darwin", finalResult: "success", transient: 0, attempts: 1 },
  { platform: "darwin", finalResult: "EPERM", transient: 0, attempts: 6 },
  { platform: "darwin", finalResult: "ESRCH", transient: 2, attempts: 3 },
  { platform: "darwin", finalResult: "success", transient: 2, attempts: 3 },
  { platform: "darwin", finalResult: "EACCES", transient: 0, attempts: 1 },
  { platform: "linux", finalResult: "EPERM", transient: 0, attempts: 1 },
])(
  "settles $platform group cleanup with $transient transient errors then $finalResult",
  async ({ platform, finalResult, transient, attempts }) => {
    const child = new ChildProcess();
    Object.defineProperty(child, "pid", { value: 12345 });
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    vi.mocked(spawn).mockReturnValue(child);
    let escalations = 0;
    const kill = vi.fn((pid: number, signal: string) => {
      expect(pid).toBe(-12345);
      if (signal === "SIGTERM") {
        // Leader exit does not prove descendant cleanup; escalation must still run.
        queueMicrotask(() => child.emit("close", 0, null));
        throw Object.assign(new Error("graceful signal raced with exit"), { code: "EPERM" });
      }
      if (escalations++ < transient)
        throw Object.assign(new Error("group awaiting reaping"), { code: "EPERM" });
      if (finalResult !== "success")
        throw Object.assign(new Error("final signal result"), { code: finalResult });
      return true;
    });
    vi.stubGlobal(
      "process",
      new Proxy(process, {
        get(target, key) {
          if (key === "platform") return platform;
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
    if (!["success", "ESRCH"].includes(finalResult))
      await expect(running).rejects.toMatchObject({
        code: "termination_failed",
        systemCode: finalResult,
        result: { terminationReason: "cancelled" },
      });
    else
      await expect(running).resolves.toMatchObject({ exitCode: 0, terminationReason: "cancelled" });
    expect(kill.mock.calls).toEqual([
      [-12345, "SIGTERM"],
      ...Array.from({ length: attempts }, () => [-12345, "SIGKILL"]),
    ]);
  },
);
