import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { sessionFixture } from "./session-fixture.js";

it("creates and continues across cold Veyra processes using only a safe saved native reference", async () => {
  await withFixtureWorkspace(async ({ path }) => {
    const executable = join(path, "fixture-codex.cjs");
    const nativeFile = join(path, "native-state.json");
    const id = randomUUID();
    await writeFile(
      executable,
      `#!/usr/bin/env node
const fs=require('node:fs'); const args=process.argv.slice(2); const prompt=fs.readFileSync(0,'utf8');
const resume=args.includes('resume');
if(args.includes('--ephemeral')||!args.includes('workspace-write'))process.exit(2);
let state;
if(resume){state=JSON.parse(fs.readFileSync(${JSON.stringify(nativeFile)},'utf8'));if(args.at(-2)!==state.id)process.exit(3);}
else {state={id:${JSON.stringify(id)},marker:/Continuity marker: (continuity-[a-f0-9-]+)/.exec(prompt)[1]};fs.writeFileSync(${JSON.stringify(nativeFile)},JSON.stringify(state));}
fs.writeFileSync('src/message.js','export function message() { return '+JSON.stringify(resume?'Hello from session two':'Hello from session one')+'; }\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:state.id}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'success',summary:resume?state.marker:'First task complete',changedFiles:['src/message.js'],commandsRun:[]})}}));
console.log(JSON.stringify({type:'turn.completed'}));
`,
      { mode: 0o700 },
    );
    expect(await sessionFixture(executable)).toMatchObject({
      status: "passed",
      processes: 2,
      sessionId: id,
      nativeContextRecalled: true,
      disposableWorkspaceRemoved: true,
    });
    expect(JSON.parse(await readFile(nativeFile, "utf8")).id).toBe(id);
  });
}, 30000);
