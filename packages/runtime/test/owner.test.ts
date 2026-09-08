import { hostname } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentProcessOwner, inspectProcessOwner, isProcessOwner } from "../src/index.js";

afterEach(() => vi.restoreAllMocks());

describe("local process ownership observations", () => {
  it("records and observes the current process without sending a termination signal", () => {
    const owner = currentProcessOwner();
    expect(owner).toMatchObject({ pid: process.pid, host: hostname() });
    expect(isProcessOwner(owner)).toBe(true);
    expect(Date.parse(owner.startedAt)).toBeLessThanOrEqual(Date.now());
    const probe = vi.spyOn(process, "kill");
    expect(inspectProcessOwner(owner)).toBe("alive");
    expect(probe).toHaveBeenCalledExactlyOnceWith(process.pid, 0);
  });

  it.each(["ESRCH", "EPERM", "EINVAL"])("treats probe error %s conservatively", (code) => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("fixture"), { code });
    });
    expect(inspectProcessOwner(currentProcessOwner())).toBe(code === "ESRCH" ? "dead" : "unknown");
  });

  it("does not probe foreign or missing owners", () => {
    const probe = vi.spyOn(process, "kill");
    expect(inspectProcessOwner({ ...currentProcessOwner(), host: `other-${hostname()}` })).toBe(
      "unknown",
    );
    expect(inspectProcessOwner()).toBe("unknown");
    expect(probe).not.toHaveBeenCalled();
  });

  it.each([
    { pid: 0 },
    { pid: -1 },
    { pid: 1.5 },
    { pid: 2_147_483_648 },
    { host: "" },
    { host: "bad\0host" },
    { startedAt: "yesterday" },
    { extra: true },
  ])("rejects malformed ownership metadata %#", (patch) => {
    expect(isProcessOwner({ ...currentProcessOwner(), ...patch })).toBe(false);
  });
});
