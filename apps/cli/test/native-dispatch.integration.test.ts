import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { nativeDispatchFixture } from "./native-dispatch-fixture.js";

it.each(["pass", "fail", "tamper", "symlink", "cancel", "inspect-failure", "inspect-success"])(
  "exercises native dispatch harness %s with cleanup and real Verifier commands",
  async (mode) => {
    await withFixtureWorkspace(async ({ path }) => {
      const executable = join(path, "fixture-native.cjs");
      const observer = join(path, "fixture-root.txt");
      await writeFile(
        executable,
        `#!/usr/bin/env node
const fs=require('node:fs'); const {randomUUID}=require('node:crypto');
fs.readFileSync(0,'utf8'); fs.writeFileSync(${JSON.stringify(observer)},process.cwd());
if(process.env.OPENAI_API_KEY)process.exit(2);
const mode=${JSON.stringify(mode)};
if(mode==='cancel'){setInterval(()=>{},1000);}
else {
 if(mode!=='fail'&&!mode.startsWith('inspect'))fs.writeFileSync('src/message.js',"export function message() { return 'Hello from the Veyra fixture'; }\\n");
 if(mode==='tamper')fs.writeFileSync('AGENTS.md','tampered instructions');
 if(mode==='symlink'){fs.unlinkSync('AGENTS.md');fs.symlinkSync(${JSON.stringify(join(path, "same-instructions.txt"))},'AGENTS.md');}
 console.log(JSON.stringify({type:'thread.started',thread_id:randomUUID()}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:mode==='inspect-failure'?'failure':'success',summary:'Fixture executor result',changedFiles:mode.startsWith('inspect')?[]:['src/message.js'],commandsRun:[]})}}));
 console.log(JSON.stringify({type:'turn.completed'}));
}
`,
        { mode: 0o700 },
      );
      await writeFile(join(path, "same-instructions.txt"), "symlink instructions");
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = nativeDispatchFixture(executable, {
          signal: controller.signal,
          ...(mode === "inspect-failure" || mode === "inspect-success" ? { mode } : {}),
          progress: (stage) => {
            if (mode === "cancel" && stage === "native_running")
              timer = setTimeout(() => controller.abort(), 500);
          },
        });
        if (mode === "pass" || mode.startsWith("inspect"))
          expect(await result).toMatchObject({
            status: "passed",
            apiKeyPresent: false,
            disposableWorkspaceRemoved: true,
            daemonStopped: true,
            changedFiles: mode.startsWith("inspect") ? [] : ["src/message.js"],
            executionOutcome: mode === "inspect-failure" ? "failed" : "completed",
            verificationEvidenceCount: 3,
            protectedFilesUnchanged: true,
          });
        else
          await expect(result).rejects.toThrow(
            mode === "fail"
              ? "failed"
              : mode === "tamper"
                ? "Protected file changed"
                : mode === "symlink"
                  ? "Unsafe fixture file"
                  : "cancelled",
          );
        const fixtureRoot = await readFile(observer, "utf8");
        await expect(access(fixtureRoot)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        clearTimeout(timer);
      }
    });
  },
  30000,
);
