import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ProjectId } from "@veyraoss/protocol";
import { fixtureProjectState } from "../../../test/helpers/project-state.js";
import { isDaemonRequest, isDaemonResponse } from "../src/index.js";

const projectId = randomUUID() as ProjectId;
const runId = randomUUID();
const fixture = fixtureProjectState(projectId);
if (!fixture.handoff) throw new Error("Missing fixture handoff");
const handoff = { ...fixture.handoff, runId };
const locator = { projectId, runId };

describe("versioned daemon contracts", () => {
  it("validates every minimum operation with bounded Project locators", () => {
    const requests = [
      ...["health", "stop", "projects.list"].map((method) => ({ version: 1, method })),
      { version: 1, method: "projects.get", params: { projectId } },
      { version: 1, method: "projects.register", params: { path: "/tmp/project" } },
      { version: 1, method: "runs.dispatch", params: { projectId, handoff } },
      { version: 1, method: "runs.list", params: { projectId, limit: 20 } },
      ...["runs.get", "runs.cancel", "handoffs.get", "results.get"].map((method) => ({
        version: 1,
        method,
        params: locator,
      })),
      { version: 1, method: "runs.wait", params: { ...locator, waitMs: 30000 } },
    ];
    for (const request of requests)
      expect(isDaemonRequest(request), JSON.stringify(request)).toBe(true);
  });

  it.each([
    ...[0, 101, 1.5, "20"].map((limit) => ({
      version: 1,
      method: "runs.list",
      params: { projectId, limit },
    })),
    { version: 2, method: "health" },
    { version: 1, method: "fs.read", params: { path: "/etc/passwd" } },
    { version: 1, method: "projects.register", params: { path: "../project" } },
    { version: 1, method: "health", credentials: "must not cross this API" },
    { version: 1, method: "runs.dispatch", params: { projectId: randomUUID(), handoff } },
    { version: 1, method: "runs.get", params: { projectId, runId: "../../outside" } },
    { version: 1, method: "runs.wait", params: { ...locator, waitMs: 30001 } },
    { version: 1, method: "runs.wait", params: { ...locator, waitMs: -1 } },
    { version: 1, method: "runs.wait", params: { ...locator, waitMs: 0.5 } },
    {
      version: 1,
      method: "runs.dispatch",
      params: {
        projectId,
        handoff: { ...handoff, context: { ...handoff.context, goal: "x".repeat(256 * 1024) } },
      },
    },
  ])("rejects unsupported or unsafe request %#", (request) => {
    expect(isDaemonRequest(request)).toBe(false);
  });

  it("does not execute getters and validates responses against their operation", () => {
    let accessed = false;
    expect(
      isDaemonRequest({
        get version() {
          accessed = true;
          return 1;
        },
        method: "health",
      }),
    ).toBe(false);
    expect(accessed).toBe(false);
    expect(isDaemonResponse({ version: 1, ok: true, result: null }, "results.get")).toBe(true);
    expect(isDaemonResponse({ version: 1, ok: true, result: null }, "runs.get")).toBe(false);
    expect(
      isDaemonResponse(
        { version: 1, ok: false, error: { code: "run_not_found", message: "Missing run" } },
        "runs.get",
      ),
    ).toBe(true);
    expect(
      isDaemonResponse(
        { version: 1, ok: false, error: { code: "bad", message: "x".repeat(513) } },
        "runs.get",
      ),
    ).toBe(false);
  });
});
