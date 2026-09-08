import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initializeProject, ProjectHandoffStore } from "@veyraoss/project";
import { runProcess } from "@veyraoss/runtime";
import type { NativeSessionReference } from "@veyraoss/protocol";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";

const codexUrl = new URL("../dist/index.js", import.meta.url).href;
const projectUrl = new URL("../../../packages/project/dist/index.js", import.meta.url).href;

/** The only native state exchanged by these two independent Veyra processes is a safe locator. */
export async function sessionFixture(executable = "codex") {
  const result = await withFixtureWorkspace(async ({ path }) => {
    const project = await initializeProject(path);
    const runId = randomUUID();
    const marker = `continuity-${randomUUID()}`;
    const instructions =
      "# Session fixture\nOnly change src/message.js. Preserve tests, package.json, this AGENTS.md, and .veyra/. Do not install dependencies, access unrelated files, commit, push, publish, or deploy. Native Codex owns its session state; never copy authentication files.\n";
    await writeFile(join(path, "AGENTS.md"), instructions);
    await writeFile(join(path, ".gitignore"), ".veyra/\n");
    const originalTest = await readFile(join(path, "test/message.test.js"), "utf8");
    const command = async (executable: string, args: string[]) => {
      const result = await runProcess({ executable, args, cwd: path, timeoutMs: 30000 });
      assert.equal(result.exitCode, 0, `${executable} failed`);
      return result.stdout;
    };
    await command("git", ["init", "--quiet"]);
    const reports: { status: string; summary: string; session: NativeSessionReference }[] = [];
    for (const phase of ["create", "resume"] as const) {
      const expected = phase === "create" ? "Hello from session one" : "Hello from session two";
      const protectedTest = originalTest.replace("Hello from the Veyra fixture", expected);
      await writeFile(join(path, "test/message.test.js"), protectedTest);
      await command("git", ["add", "AGENTS.md", ".gitignore", "package.json", "test", "src"]);
      const before = await runProcess({
        executable: process.execPath,
        args: ["--test"],
        cwd: path,
        timeoutMs: 30000,
      });
      assert.notEqual(
        before.exitCode,
        0,
        "Each continuation starts with a deliberately failing assertion.",
      );
      const goal =
        `Make message() return exactly "${expected}". Change only src/message.js and run node --test. ` +
        (phase === "create"
          ? `Remember this marker for the next turn in this native session; do not write it to project files. Continuity marker: ${marker}`
          : "Include the continuity marker supplied in the previous turn in your result summary. Do not fetch Veyra logs or other chat histories to find it.");
      const source = `
        const {CodexAdapter}=await import(${JSON.stringify(codexUrl)});
        const {openProject,ProjectHandoffStore}=await import(${JSON.stringify(projectUrl)});
        const project=await openProject(process.argv[1]); const runId=process.argv[2];
        const store=new ProjectHandoffStore({project});
        const resume=process.argv[3]==='resume' ? await store.getSession(runId) : undefined;
        if(process.argv[3]==='resume' && !resume) throw new Error('Missing saved safe reference');
        const adapter=new CodexAdapter({executable:process.argv[4],session:{project,...(resume?{resume}:{})},timeoutMs:180000});
        const result=await adapter.run({runId,stepId:process.argv[3],role:'executor',goal:process.argv[5]}, {cwd:project.root});
        if(result.status==='success' && result.session && !resume) await store.createSession(result.session);
        console.log(JSON.stringify({status:result.status,summary:result.summary,session:result.session,error:result.error,...(result.status!=='success'?{diagnostics:result.data?.process}:{})}));
      `;
      const child = await runProcess({
        executable: process.execPath,
        args: ["--input-type=module", "-e", source, path, runId, phase, executable, goal],
        cwd: path,
        env: { OPENAI_API_KEY: undefined },
        timeoutMs: 210000,
        maxOutputBytes: 65536,
      });
      assert.equal(child.exitCode, 0, `Veyra ${phase} process failed: ${child.stderr}`);
      const report = JSON.parse(child.stdout);
      assert.equal(report.status, "success", JSON.stringify(report));
      assert.ok(report.session, "Native session must be present");
      assert.equal(report.session.projectId, project.id);
      assert.equal(report.session.runId, runId);
      reports.push(report);
      assert.equal(await readFile(join(path, "AGENTS.md"), "utf8"), instructions);
      assert.equal(await readFile(join(path, "test/message.test.js"), "utf8"), protectedTest);
      await command(process.execPath, ["--check", "src/message.js"]);
      await command(process.execPath, ["--test"]);
      assert.deepEqual((await command("git", ["diff", "--name-only"])).trim().split("\n"), [
        "src/message.js",
      ]);
      assert.equal(await command("git", ["ls-files", "--others", "--exclude-standard"]), "");
    }
    assert.equal(reports[0]?.session.id, reports[1]?.session.id);
    assert.ok(
      reports[1]?.summary.includes(marker),
      "Continuation did not recall native-session context",
    );
    const saved = await new ProjectHandoffStore({ project }).getSession(runId);
    assert.deepEqual(saved, reports[0]?.session);
    assert.ok(!JSON.stringify(saved).includes(marker), "Reference must not copy task history");
    return {
      status: "passed",
      processes: 2,
      projectId: project.id,
      runId,
      sessionId: saved?.id,
      sameNativeSession: true,
      nativeContextRecalled: true,
      verification: [
        "node --check src/message.js",
        "node --test",
        "protected files",
        "git diff scope",
      ],
    };
  });
  return { ...result, disposableWorkspaceRemoved: true, nativeHistoryOwnership: "native-client" };
}
