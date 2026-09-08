import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentAdapter } from "@veyraoss/protocol";
import { describe, expect, it, vi } from "vitest";
import { runClosedLoopSmoke, smokeGreeting } from "./closed-loop.js";

const env = { VEYRA_LIVE_SMOKE: "1", OPENAI_API_KEY: "fixture-smoke-secret" };
const ready = async () => ({
  ready: true,
  available: true,
  authentication: "ready" as const,
  version: "fixture",
  message: "Fixture readiness only",
});
const factory = (name: string): AgentAdapter => ({
  id: name,
  provider: "fixture",
  async run(_input, options) {
    if (name === "executor")
      await writeFile(
        join(options?.cwd ?? "", "src/message.js"),
        `export function message() { return ${JSON.stringify(smokeGreeting)}; }\n`,
      );
    return {
      status: "success",
      summary: "Fixture result",
      ...(name === "reviewer" ? { outcome: "pass" } : {}),
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    };
  },
});

describe("opt-in closed-loop smoke tooling", () => {
  it("requires opt-in and a key before readiness checks or provider calls", async () => {
    const checkCodex = vi.fn(ready);
    const createAgent = vi.fn(factory);
    expect(await runClosedLoopSmoke({}, { checkCodex, createAgent })).toMatchObject({
      status: "blocked",
      message: expect.stringContaining("VEYRA_LIVE_SMOKE=1"),
    });
    expect(
      await runClosedLoopSmoke({ VEYRA_LIVE_SMOKE: "1" }, { checkCodex, createAgent }),
    ).toMatchObject({ status: "blocked", message: expect.stringContaining("OPENAI_API_KEY") });
    expect(checkCodex).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("runs the actual smoke setup, verifier and scope checks with injected providers and cleans up", async () => {
    const report = await runClosedLoopSmoke(env, { checkCodex: ready, createAgent: factory });
    expect(report, report.message).toMatchObject({
      status: "passed",
      disposableWorkspaceRemoved: true,
      calls: [{ agent: "planner" }, { agent: "executor" }, { agent: "reviewer" }],
    });
    expect(JSON.stringify(report)).not.toContain(env.OPENAI_API_KEY);
    await expect(access(report.fixturePath as string)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("blocks on Codex readiness and cleans up without invoking providers", async () => {
    const createAgent = vi.fn(factory);
    const report = await runClosedLoopSmoke(env, {
      checkCodex: async () => ({ ...(await ready()), ready: false, message: "Run codex login" }),
      createAgent,
    });
    expect(report).toMatchObject({
      status: "blocked",
      message: "Run codex login",
      disposableWorkspaceRemoved: true,
    });
    expect(createAgent).not.toHaveBeenCalled();
    await expect(access(report.fixturePath as string)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails if an executor changes a protected test even when the workflow reports success", async () => {
    const report = await runClosedLoopSmoke(env, {
      checkCodex: ready,
      createAgent: (name) => {
        const adapter = factory(name);
        return {
          ...adapter,
          run: async (input, options) => {
            const result = await adapter.run(input, options);
            if (name === "executor")
              await writeFile(
                join(options?.cwd ?? "", "test/message.test.js"),
                "// Do not allow a forged passing test.\n",
              );
            return result;
          },
        };
      },
    });
    expect(report, report.message).toMatchObject({
      status: "failed",
      message: expect.stringContaining("Protected fixture file changed"),
      disposableWorkspaceRemoved: true,
    });
    await expect(access(report.fixturePath as string)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("retains a failed fixture only on explicit request and redacts the failure", async () => {
    const report = await runClosedLoopSmoke(
      { ...env, VEYRA_SMOKE_KEEP: "1" },
      {
        checkCodex: ready,
        createAgent: (name) => ({
          id: name,
          provider: "fixture",
          run: async () => {
            throw new Error(`Provider failed ${env.OPENAI_API_KEY}`);
          },
        }),
      },
    );
    const path = report.fixturePath as string;
    try {
      expect(report).toMatchObject({ status: "failed", disposableWorkspaceRemoved: false });
      expect(report.message).toContain("[REDACTED]");
      expect(JSON.stringify(report)).not.toContain(env.OPENAI_API_KEY);
      const persisted = await readFile(
        join(path, ".veyra/runs", report.runId as string, "events.jsonl"),
        "utf8",
      );
      expect(persisted).not.toContain(env.OPENAI_API_KEY);
      expect(persisted).toContain("[REDACTED]");
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  }, 30_000);
});
