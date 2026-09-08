import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalRunStore, MAX_INLINE_EVENT_BYTES } from "@veyraoss/core";
import { runProcess } from "@veyraoss/runtime";
import { describe, expect, it, vi } from "vitest";
import { FakeAgent } from "../../../test/helpers/fake-agent.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { runCli, type CliServices } from "../src/application.js";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const tsx = createRequire(import.meta.url).resolve("tsx");
async function invoke(cwd: string, args: string[], services: CliServices = {}) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    cwd,
    env: {},
    ...services,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

describe("CLI artifact views and retention", { timeout: 30_000 }, () => {
  it("renders bounded run/review records while retaining complete agent and verifier evidence", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await writeFile(
        join(path, "veyra.yaml"),
        JSON.stringify({
          version: 1,
          agents: { reviewer: { provider: "fixture" } },
          workflow: { use: "workflow.yaml" },
        }),
      );
      await writeFile(
        join(path, "workflow.yaml"),
        JSON.stringify({
          version: 1,
          name: "Large evidence",
          start: "verify",
          steps: {
            verify: {
              type: "command",
              run: [
                "node -e \"process.stdout.write('v'.repeat(50000));process.stderr.write('e'.repeat(30000))\"",
              ],
              next: "review",
            },
            review: { type: "agent", agent: "reviewer" },
          },
        }),
      );
      const agent = new FakeAgent({
        status: "success",
        outcome: "pass",
        summary: "Checked evidence",
        data: { report: "r".repeat(90_000) },
      });
      const result = await invoke(path, ["run", "Inspect large evidence", "--json"], {
        createAgent: () => agent,
      });
      expect(result.code, result.stderr + result.stdout).toBe(0);
      const lines = result.stdout.trim().split("\n");
      expect(lines.every((line) => Buffer.byteLength(line) <= MAX_INLINE_EVENT_BYTES)).toBe(true);
      const records = lines.map((line) => JSON.parse(line));
      expect(
        records.filter((event) => event.type === "event.stored").map((event) => event.eventType),
      ).toEqual(expect.arrayContaining(["verification.completed", "agent.completed"]));
      const id = records.at(-1).runId as string;
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const events = await store.readEvents(id);
      expect(events.find((event) => event.type === "agent.completed")).toMatchObject({
        result: { data: { report: "r".repeat(90_000) } },
      });
      const review = await invoke(path, ["review", id, "--json"]);
      expect(review.code, review.stderr).toBe(0);
      expect(Buffer.byteLength(review.stdout)).toBeLessThan(MAX_INLINE_EVENT_BYTES);
      expect(JSON.parse(review.stdout)).toMatchObject({
        review: { type: "event.stored", eventType: "agent.completed" },
        verification: { type: "event.stored", eventType: "verification.completed" },
      });
      const plain = await invoke(path, ["review", id]);
      expect(plain.stdout).toContain("Review: pass — Checked evidence");
      expect(plain.stdout).toContain("Stored payload: artifacts/");
      expect(plain.stdout).not.toContain("r".repeat(1000));
    });
  });

  it("previews through the public executable and deletes only explicitly eligible history without constructing providers", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await writeFile(
        join(path, "veyra.yaml"),
        JSON.stringify({
          version: 1,
          agents: { unused: { provider: "fixture" } },
          workflow: { use: "unused.yaml" },
        }),
      );
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const input = {
        goal: "Retention",
        cwd: path,
        workflow: {
          version: 1 as const,
          name: "retention",
          start: "done",
          steps: { done: { type: "end" as const } },
        },
      };
      const old = await store.createRun(input);
      await store.updateRun(old.state.runId, { status: "completed", currentStep: null });
      await store.appendEvent(old.state.runId, {
        type: "run.started",
        runId: old.state.runId,
        goal: "x".repeat(90_000),
        at: new Date().toISOString(),
      });
      const paused = await store.createRun(input);
      await store.updateRun(paused.state.runId, { status: "paused" });
      const active = await store.createRun(input);
      await store.updateRun(active.state.runId, { status: "completed", currentStep: null });
      const args = ["prune", "--older-than-days", "0", "--keep-last", "0", "--json"];
      const preview = await runProcess({
        executable: process.execPath,
        args: ["--import", tsx, entry, ...args],
        cwd: path,
        timeoutMs: 15_000,
      });
      expect(preview.exitCode, preview.stderr).toBe(0);
      expect(JSON.parse(preview.stdout)).toMatchObject({
        type: "retention",
        dryRun: true,
        candidates: [{ runId: old.state.runId }],
        removed: [],
      });
      expect(await store.listRuns()).toHaveLength(3);
      const createAgent = vi.fn(() => {
        throw new Error("Prune must not construct providers");
      });
      const applied = await invoke(path, [...args, "--apply"], { createAgent });
      expect(applied.code, applied.stderr).toBe(0);
      expect(JSON.parse(applied.stdout)).toMatchObject({
        dryRun: false,
        removed: [{ runId: old.state.runId }],
        skipped: expect.arrayContaining([
          { runId: active.state.runId, reason: "active_selection" },
          { runId: paused.state.runId, reason: "nonterminal" },
        ]),
      });
      expect(createAgent).not.toHaveBeenCalled();
      await expect(
        readFile(join(path, ".veyra", "runs", old.state.runId, "events.jsonl")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await store.listRuns()).toHaveLength(2);
    });
  });

  it.each([
    ["--older-than-days", "-1"],
    ["--keep-last", "1.5"],
    ["--keep-last", "100001"],
    ["--force"],
    ["unexpected-id"],
  ])("rejects invalid prune arguments %j", async (...args) => {
    await withFixtureWorkspace(async ({ path }) => {
      await writeFile(
        join(path, "veyra.yaml"),
        JSON.stringify({ version: 1, agents: {}, workflow: { use: "dev" } }),
      );
      const result = await invoke(path, ["prune", ...args, "--json"]);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout).type).toBe("error");
      await expect(readFile(join(path, ".veyra", "state", "active.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });
});
