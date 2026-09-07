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
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
});

function setup(treeExitCode: number) {
  vi.stubGlobal(
    "process",
    new Proxy(process, {
      get(target, key) {
        return key === "platform" ? "win32" : Reflect.get(target, key);
      },
    }),
  );
  const child = new ChildProcess();
  Object.defineProperty(child, "pid", { value: 12345 });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const helper = new ChildProcess();
  const kill = vi.spyOn(child, "kill").mockImplementation(() => {
    queueMicrotask(() => child.emit("close", null, "SIGKILL"));
    return true;
  });
  vi.mocked(spawn)
    .mockImplementationOnce(() => child)
    .mockImplementationOnce(() => {
      queueMicrotask(() => {
        if (treeExitCode === 0) child.emit("close", 1, null);
        helper.emit("close", treeExitCode, null);
      });
      return helper;
    });
  return { child, kill };
}

it("uses a PID-scoped system taskkill command for Windows descendants", async () => {
  const { kill } = setup(0);
  const controller = new AbortController();
  const running = runProcess({ executable: "fixture.exe", signal: controller.signal });
  controller.abort();
  expect(await running).toMatchObject({ terminationReason: "cancelled", exitCode: 1 });
  expect(vi.mocked(spawn).mock.calls[1]?.[0]).toMatch(/System32[/\\]taskkill\.exe$/);
  expect(vi.mocked(spawn).mock.calls[1]?.[1]).toEqual(["/PID", "12345", "/T", "/F"]);
  expect(vi.mocked(spawn).mock.calls[1]?.[2]).toMatchObject({ timeout: 5000, windowsHide: true });
  expect(kill).not.toHaveBeenCalled();
});

it("reports failed Windows tree cleanup instead of claiming success", async () => {
  const { child, kill } = setup(1);
  const controller = new AbortController();
  const running = runProcess({ executable: "fixture.exe", signal: controller.signal });
  controller.abort();
  await expect(running).rejects.toMatchObject({
    code: "termination_failed",
    result: { terminationReason: "cancelled" },
  });
  expect(kill).toHaveBeenCalledWith("SIGKILL");
  expect(child.stdout?.destroyed).toBe(true);
  expect(child.stderr?.destroyed).toBe(true);
});
