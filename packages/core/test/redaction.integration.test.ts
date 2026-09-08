import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "@veyraoss/config";
import type { AgentAdapter, VeyraEvent } from "@veyraoss/protocol";
import type { Verifier } from "@veyraoss/verifier";
import type { WorkflowDefinition } from "@veyraoss/workflow";
import { describe, expect, it } from "vitest";
import { patternSecrets } from "../../../test/helpers/secret-fixtures.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { LocalRunStore, VeyraEngine } from "../src/index.js";

const config = parseConfig({ version: 1, agents: {}, workflow: { use: "fixture" } });

describe("persisted secret boundaries", () => {
  it("filters unknown token formats and payload keys before events, later agent context and files", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow: WorkflowDefinition = {
        version: 1,
        name: "redaction",
        start: "first",
        steps: {
          first: { type: "agent", agent: "first", next: "next" },
          next: { type: "agent", agent: "next" },
        },
      };
      const first: AgentAdapter = {
        id: "first",
        provider: "fixture",
        async run() {
          return {
            status: "success",
            summary: patternSecrets.join(" "),
            data: {
              [patternSecrets[0] as string]: patternSecrets,
              credentials: "unknown opaque credential",
            },
          };
        },
      };
      const next: AgentAdapter = {
        id: "next",
        provider: "fixture",
        async run(input) {
          for (const secret of patternSecrets) expect(JSON.stringify(input)).not.toContain(secret);
          expect(JSON.stringify(input)).not.toContain("unknown opaque credential");
          return { status: "success", summary: "Sanitized context" };
        },
      };
      const events: VeyraEvent[] = [];
      const engine = new VeyraEngine({
        emit: (event) => {
          events.push(event);
        },
      });
      const result = await engine.run({
        config,
        cwd: path,
        workflow,
        agents: { first, next },
        goal: "No unknown credentials in state",
      });
      expect(result.status).toBe("completed");
      const files = await Promise.all(
        ["input.json", "state.json", "events.jsonl"].map((file) =>
          readFile(join(path, ".veyra", "runs", result.runId, file), "utf8"),
        ),
      );
      for (const text of [...files, JSON.stringify(events), JSON.stringify(result)]) {
        for (const secret of patternSecrets) expect(text).not.toContain(secret);
        expect(text).not.toContain("unknown opaque credential");
      }
    });
  });

  it.each(["agent", "verifier"])(
    "redacts a %s exception before slicing its diagnostic",
    async (kind) => {
      await withFixtureWorkspace(async ({ path }) => {
        const secret = `clipped-credential-${"x".repeat(64)}`;
        const failure = () => {
          throw new Error("x".repeat(2030) + secret);
        };
        const workflow: WorkflowDefinition = {
          version: 1,
          name: "exception",
          start: "work",
          steps: {
            work:
              kind === "agent"
                ? { type: "agent", agent: "worker" }
                : { type: "command", run: ["node --test"] },
          },
        };
        const events: VeyraEvent[] = [];
        const engine = new VeyraEngine({
          redactValues: [secret],
          verifier: { verify: async () => failure() },
          emit: (event) => {
            events.push(event);
          },
        });
        const result = await engine.run({
          config,
          cwd: path,
          workflow,
          agents: { worker: { id: "worker", provider: "fixture", run: async () => failure() } },
          goal: "No clipped secret",
        });
        expect(result.status).toBe("failed");
        const text = await readFile(
          join(path, ".veyra", "runs", result.runId, "events.jsonl"),
          "utf8",
        );
        for (const output of [text, JSON.stringify(events), JSON.stringify(result)]) {
          expect(output).not.toContain("clipped-credential-");
          expect(output).toContain("[REDACTED]");
        }
      });
    },
  );

  it("removes partial known secrets from a truncated verifier stream and refuses secret structural keys", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const secret = "truncated-output-credential";
      const store = new LocalRunStore({ stateDir: join(path, ".veyra"), redactValues: [secret] });
      const workflow: WorkflowDefinition = {
        version: 1,
        name: "stream",
        start: "work",
        steps: { work: { type: "command", run: ["node --test"] } },
      };
      const verifier: Verifier = {
        async verify({ commands }) {
          return {
            success: false,
            durationMs: 1,
            results: [
              {
                command: commands[0] as string,
                success: false,
                exitCode: 1,
                stdout: "",
                stderr: secret.slice(0, 18),
                stderrTruncated: true,
                durationMs: 1,
              },
            ],
          };
        },
      };
      const result = await new VeyraEngine({ store, verifier }).run({
        config,
        workflow,
        cwd: path,
        agents: {},
        goal: "Redact retained prefixes",
      });
      expect(result.status).toBe("failed");
      const text = await readFile(
        join(store.directory, "runs", result.runId, "events.jsonl"),
        "utf8",
      );
      expect(text).not.toContain(secret.slice(0, 18));
      expect(text).toContain("[REDACTED]");
      await expect(
        store.createRun({
          goal: "No secret identifiers",
          cwd: path,
          workflow: {
            version: 1,
            name: "unsafe",
            start: secret,
            steps: { [secret]: { type: "end" } },
          },
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });
  });
});
