import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentAdapter } from "@veyra/protocol";
import { expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { runCli } from "../src/application.js";

it("renders declared native permissions, configured command origins and the pending operation", async () => {
  await withFixtureWorkspace(async ({ path }) => {
    await writeFile(
      join(path, "veyra.yaml"),
      JSON.stringify({
        version: 1,
        agents: { executor: { provider: "fixture" } },
        workflow: { use: "workflow.yaml" },
      }),
    );
    await writeFile(
      join(path, "workflow.yaml"),
      JSON.stringify({
        version: 1,
        name: "safety",
        start: "work",
        policy: { approval: { before: ["operation"] } },
        steps: {
          work: { type: "agent", agent: "executor", next: "verify" },
          verify: { type: "command", run: ["node --test"], next: "operation" },
          operation: { type: "command", run: ["node --check src/message.js"] },
        },
      }),
    );
    const executor: AgentAdapter = {
      id: "executor",
      provider: "fixture",
      describe() {
        return {
          schemaVersion: 1,
          id: "executor",
          provider: "fixture",
          adapterVersion: "1.0.0",
          roles: ["executor"],
          capabilities: ["code-execution"],
          permissions: { mode: "default", source: "adapter-argument", toolAllowRules: 2 },
        };
      },
      async run() {
        return { status: "success", summary: "Fixture" };
      },
    };
    let output = "";
    const invoke = (args: string[]) =>
      runCli(args, {
        cwd: path,
        env: {},
        createAgent: () => executor,
        stdout: (text) => {
          output += text;
        },
      });
    expect(await invoke(["run", "Inspect command permissions"])).toBe(3);
    expect(output).toContain(
      "Permissions: default (adapter-argument); explicit allow rules: 2; additional native policy not inspected",
    );
    expect(output).toContain("workflow shell commands (host permissions)");
    output = "";
    expect(await invoke(["status"])).toBe(0);
    expect(output).toContain("Operation:");
    expect(output).toContain("node --check src/message.js");
    output = "";
    expect(await invoke(["status", "--json"])).toBe(0);
    expect(JSON.parse(output).approval.context.operation).toMatchObject({
      stepId: "operation",
      type: "command",
      commandSource: "workflow",
      truncated: false,
    });
  });
});
