import { execFile } from "node:child_process";
import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";

const exec = promisify(execFile);
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

it("initializes, discovers and unregisters a Project across CLI processes without provider configuration", async () => {
  await withFixtureWorkspace(async ({ path }) => {
    const registry = join(path, "isolated-registry");
    const project = join(path, "项目 one");
    await mkdir(project);
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    const run = async (...args: string[]) =>
      JSON.parse(
        (
          await exec(process.execPath, [entry, ...args, "--registry", registry, "--json"], {
            cwd: path,
            env,
            timeout: 10000,
          })
        ).stdout,
      );
    const added = await run("project", "add", project);
    expect(added.status).toBe("available");
    expect(await run("projects")).toEqual({ projects: [added] });
    expect(await run("project", "show", added.project.id)).toEqual(added);
    await mkdir(join(project, "nested"));
    expect(await run("project", "add", join(project, "nested"))).toEqual(added);
    await rename(project, join(path, "moved"));
    expect((await run("projects")).projects[0]).toMatchObject({
      status: "stale",
      reason: "unavailable_path",
    });
    await expect(run("project", "show", added.project.id)).rejects.toMatchObject({ code: 1 });
    expect(await run("project", "remove", added.project.id)).toEqual({
      projectId: added.project.id,
      removed: true,
    });
    expect(await run("projects")).toEqual({ projects: [] });
    expect(await readFile(join(path, "moved", ".veyra", "project.yaml"), "utf8")).toContain(
      added.project.id,
    );
    await expect(run("project", "show", "../bad")).rejects.toMatchObject({ code: 2 });
    await expect(run("project", "remove")).rejects.toMatchObject({ code: 2 });
  });
}, 25000);
