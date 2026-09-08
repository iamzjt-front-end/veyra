import { cp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentInput, VeyraEvent } from "@veyraoss/protocol";
import { describe, expect, it } from "vitest";
import { runCli } from "../apps/cli/src/application.js";
import { loadConfig } from "../packages/config/src/index.js";
import { withFixtureWorkspace } from "./helpers/workspace.js";

const gallery = fileURLToPath(new URL("../examples/gallery/", import.meta.url));
const names = (await readdir(gallery, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

async function example(path: string, name: string, negativeReview = false) {
  await cp(join(gallery, name), path, { recursive: true });
  const manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
  manifest.scripts["test:targeted"] = "node --test test/message.test.js";
  manifest.scripts.build = `node -e "const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.copyFileSync('src/message.js','dist/message.js')"`;
  await writeFile(join(path, "package.json"), JSON.stringify(manifest));
  const config = join(path, "veyra.yaml");
  const calls: { id: string; input: AgentInput }[] = [];
  const ve = async (...args: string[]) => {
    let output = "";
    const code = await runCli([...args, "--config", config, "--json"], {
      cwd: path,
      env: {},
      stdout: (text) => (output += text),
      stderr: (text) => (output += text),
      createAgent: (id, agent) => ({
        id,
        provider: agent.provider,
        async run(input) {
          calls.push({ id, input: structuredClone(input) });
          return {
            status: "success",
            summary: "Deterministic gallery fixture evidence; no live provider was called.",
            ...(["reviewer", "judge"].includes(input.role)
              ? { outcome: negativeReview && id === "maintainability" ? "fail" : "pass" }
              : {}),
          };
        },
      }),
    });
    const records = output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { code, output, records };
  };
  return { ve, config, calls };
}

describe("complete gallery configurations", () => {
  it.each(names)(
    "validates and runs %s with real commands and test-only providers",
    async (name) => {
      await withFixtureWorkspace(async ({ path }) => {
        const { ve, config, calls } = await example(path, name);
        const definition = await loadConfig(config);
        expect((await ve("workflow", "validate", definition.workflow.use)).code).toBe(0);
        const gate = ["human-approval", "parallel-reviewers", "research"].includes(name);
        const run = await ve("run", "Inspect the passing disposable fixture", "--non-interactive");
        expect(run.code, run.output).toBe(gate ? 3 : 0);
        if (gate) {
          const status = await ve("status");
          const saved = status.records[0];
          if (name === "human-approval")
            expect(
              run.records.some((event: VeyraEvent) => event.type === "verification.completed"),
            ).toBe(false);
          const resumed = await ve(
            "resume",
            saved.runId,
            "--approve",
            "--approval-id",
            saved.approval.approvalId,
          );
          expect(resumed.code, resumed.output).toBe(0);
        }
        expect((await ve("status")).records[0].status).toBe("completed");
        expect((await ve("review")).code).toBe(0);
        expect(new Set(calls.map((call) => call.id)).size).toBe(
          Object.keys(definition.agents).length,
        );
      });
    },
    45_000,
  );

  it("preserves a negative parallel review in the human report", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const { ve } = await example(path, "parallel-reviewers", true);
      expect((await ve("run", "Inspect reviews")).code).toBe(3);
      const status = await ve("status");
      expect(status.records[0].approval.context.inputs.decision.outcome).toBe("fail");
      expect(status.records[0].approval.context.inputs.decision.reviews).toHaveLength(2);
    });
  });

  it("fails headless verification before the build when a check fails", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const { ve, calls } = await example(path, "ci-headless");
      await writeFile(join(path, "src/message.js"), "invalid JavaScript !!");
      const result = await ve("run", "Check failure", "--non-interactive");
      expect(result.code, result.output).toBe(1);
      expect(calls).toHaveLength(0);
      await expect(readFile(join(path, "dist/message.js"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });
});
