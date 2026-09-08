import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "@veyraoss/runtime";
import { describe, expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { LocalRunStore } from "../src/index.js";

const moduleUrl = new URL("../src/state.ts", import.meta.url).href;

describe.skipIf(process.platform === "win32")("atomic snapshots during process death", () => {
  it.each(["before", "after"])(
    "retains a complete snapshot when killed %s rename",
    async (boundary) => {
      await withFixtureWorkspace(async ({ path }) => {
        // Fault injection wraps the actual fs operation only in this child process.
        // No production hook or simulated success replaces the store's write path.
        const source = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
let armed = false;
const originalRename = fs.promises.rename;
fs.promises.rename = async (from,to) => {
  if (armed && to.endsWith('state.json')) {
    if (${JSON.stringify(boundary)} === 'after') await originalRename(from,to);
    process.kill(process.pid,'SIGKILL');
  }
  return originalRename(from,to);
};
syncBuiltinESMExports();
const { LocalRunStore } = await import(${JSON.stringify(moduleUrl)});
const store = new LocalRunStore({stateDir:join(process.argv[1],'.veyra')});
const run = await store.createRun({goal:'Atomic fixture',cwd:process.argv[1],workflow:{name:'atomic',version:1,start:'work',steps:{work:{type:'end'}}}});
fs.writeFileSync(join(process.argv[1],'run-id.txt'),run.state.runId);
armed = true;
await store.updateRun(run.state.runId,{status:'paused',retryCounts:{work:7},lastOutcome:'complete snapshot'});`;
        const child = await runProcess({
          executable: process.execPath,
          args: ["--import", "tsx", "--input-type=module", "-e", source, path],
          timeoutMs: 30_000,
        });
        expect(child.signal, child.stderr).toBe("SIGKILL");
        const runId = await readFile(join(path, "run-id.txt"), "utf8");
        const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
        const state = (await store.loadRun(runId)).state;
        expect(state).toMatchObject(
          boundary === "before"
            ? { status: "running", retryCounts: {} }
            : { status: "paused", retryCounts: { work: 7 }, lastOutcome: "complete snapshot" },
        );
        expect(await store.readEvents(runId)).toEqual([]);
        expect((await store.listRuns()).map((run) => run.runId)).toEqual([runId]);
        const files = await readdir(join(store.directory, "runs", runId));
        expect(files.some((name) => name.endsWith(".tmp"))).toBe(boundary === "before");
      });
    },
    30_000,
  );
});
