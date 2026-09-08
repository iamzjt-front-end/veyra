import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { nativeDispatchFixture } from "./native-dispatch-fixture.js";

it.each(["pass", "fail", "tamper", "symlink", "cancel"])(
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
 if(mode!=='fail')fs.writeFileSync('src/message.js',"export function message() { return 'Hello from the Veyra fixture'; }\\n");
 if(mode==='tamper')fs.writeFileSync('AGENTS.md','tampered instructions');
 if(mode==='symlink'){fs.unlinkSync('AGENTS.md');fs.symlinkSync(${JSON.stringify(join(path, "same-instructions.txt"))},'AGENTS.md');}
 console.log(JSON.stringify({type:'thread.started',thread_id:randomUUID()}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'success',summary:'Fixture executor result',changedFiles:['src/message.js'],commandsRun:[]})}}));
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
          progress: (stage) => {
            if (mode === "cancel" && stage === "native_running")
              timer = setTimeout(() => controller.abort(), 500);
          },
        });
        if (mode === "pass")
          expect(await result).toMatchObject({
            status: "passed",
            apiKeyPresent: false,
            disposableWorkspaceRemoved: true,
            daemonStopped: true,
            changedFiles: ["src/message.js"],
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
