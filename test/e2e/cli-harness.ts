import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentAdapter, AgentInput, AgentResult } from "@veyraoss/protocol";
import { runCli } from "../../apps/cli/src/application.js";
import { createAgent, type AgentFactory } from "../../apps/cli/src/providers.js";

// Test-only composition: the public CLI command handlers, with deterministic providers.
// This file is not imported by any production entry point.
const scenario = (await readFile("scenario.txt", "utf8")).trim();
const greeting = "Hello from a verified Veyra run";
const factory: AgentFactory = (name, config): AgentAdapter => {
  if (scenario === "missing-codex" && name === "executor") return createAgent(name, config);
  return {
    id: name,
    provider: "e2e-fixture",
    async run(input, options): Promise<AgentResult> {
      await appendFile(
        "calls.jsonl",
        `${JSON.stringify({ pid: process.pid, input, cwd: options?.cwd })}\n`,
      );
      if (scenario === "provider-failure" && name === "planner")
        throw new Error("Fixture provider is unavailable");
      if (name === "planner")
        return {
          status: "success",
          summary: "Change only the fixture greeting and preserve its tests.",
          data: { greeting },
        };
      if (name === "executor") {
        const broken =
          scenario === "max-retries" || (scenario === "verifier-fix" && input.stepId === "execute");
        await writeFile(
          join(options?.cwd ?? process.cwd(), "src/message.js"),
          `export function message() { return ${JSON.stringify(broken ? "wrong greeting" : greeting)}; }\n${input.stepId === "fix" ? "// Repaired using the persisted evidence.\n" : ""}`,
        );
        return {
          status: "success",
          summary: "Updated src/message.js",
          data: { changedFiles: ["src/message.js"] },
        };
      }
      const calls = (await readFile("calls.jsonl", "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { input: AgentInput });
      const fail =
        scenario === "reviewer-fix" &&
        calls.filter((call) => call.input.role === "reviewer").length === 1;
      return {
        status: "success",
        outcome: fail ? "fail" : "pass",
        summary: fail ? "Add a repair comment to explain the change." : "Fixture evidence passes.",
        artifacts: [{ id: "built-message", kind: "build", path: "dist/message.js" }],
      };
    },
  };
};

process.exitCode = await runCli(process.argv.slice(2), {
  createAgent: factory,
  env: {},
  stdout: (text) => {
    process.stdout.write(text);
    const event = JSON.parse(text) as { type: string; stepId?: string };
    // Simulate an owner exiting after persistence but before the next scheduling write.
    if (scenario === "restart" && event.type === "step.completed" && event.stepId === "plan")
      process.exit(71);
  },
});
