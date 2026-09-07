import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "@veyra/config";
import { runProcess } from "@veyra/runtime";
import type { WorkflowDefinition } from "@veyra/workflow";
import { describe, expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { VeyraEngine } from "../src/index.js";

const config = parseConfig({ version: 1, agents: {}, workflow: { use: "fixture" } });
const moduleUrl = new URL("../src/index.ts", import.meta.url).href;

describe("explicit interrupted checkpoint recovery", () => {
  it("continues after a completed step without repeating its filesystem mutation", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow: WorkflowDefinition = {
        name: "checkpoint",
        version: 1,
        start: "first",
        steps: {
          first: {
            type: "command",
            run: ["node -e \"require('node:fs').appendFileSync('first.txt','x')\""],
            next: "second",
          },
          second: {
            type: "command",
            run: ["node -e \"require('node:fs').writeFileSync('second.txt','done')\""],
          },
        },
      };
      const source = `import { VeyraEngine } from ${JSON.stringify(moduleUrl)};
await new VeyraEngine({emit: event => { if (event.type === 'step.completed' && event.stepId === 'first') { console.log(event.runId); process.exit(0); } }}).run({config:${JSON.stringify(config)},workflow:${JSON.stringify(workflow)},agents:{},goal:'checkpoint',cwd:process.argv[1]});`;
      const child = await runProcess({
        executable: process.execPath,
        args: ["--import", "tsx", "--input-type=module", "-e", source, path],
        timeoutMs: 30_000,
      });
      expect(child.exitCode, child.stderr).toBe(0);
      const request = { config, runId: child.stdout.trim(), cwd: path, agents: {} };
      await expect(new VeyraEngine().resume(request)).rejects.toMatchObject({
        code: "run_not_paused",
      });
      expect(
        (await new VeyraEngine().resume({ ...request, recoverInterrupted: true })).status,
      ).toBe("completed");
      expect(await readFile(join(path, "first.txt"), "utf8")).toBe("x");
      expect(await readFile(join(path, "second.txt"), "utf8")).toBe("done");
    });
  });

  it("refuses to repeat an interrupted agent whose completion is unknown", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow: WorkflowDefinition = {
        name: "interrupted",
        version: 1,
        start: "work",
        steps: { work: { type: "agent", agent: "worker" } },
      };
      const source = `import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VeyraEngine } from ${JSON.stringify(moduleUrl)};
const worker={id:'worker',provider:'fixture',run:async input=>{await writeFile(join(process.argv[1],'partial.txt'),'partial');console.log(input.runId);process.exit(0);}};
await new VeyraEngine().run({config:${JSON.stringify(config)},workflow:${JSON.stringify(workflow)},agents:{worker},goal:'checkpoint',cwd:process.argv[1]});`;
      const child = await runProcess({
        executable: process.execPath,
        args: ["--import", "tsx", "--input-type=module", "-e", source, path],
        timeoutMs: 30_000,
      });
      expect(child.exitCode, child.stderr).toBe(0);
      await expect(
        new VeyraEngine().resume({
          config,
          runId: child.stdout.trim(),
          cwd: path,
          agents: {},
          recoverInterrupted: true,
        }),
      ).rejects.toMatchObject({ code: "interrupted_attempt" });
      expect(await readFile(join(path, "partial.txt"), "utf8")).toBe("partial");
    });
  });
});
