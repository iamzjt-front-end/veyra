import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { prepareLiveProject, inspectLiveProject } from "./live-project.js";
import { ProjectRegistry } from "@veyraoss/project";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";

it("prepares a disposable native-bound Project and detects real failure, success and protected-file tampering", async () => {
  await withFixtureWorkspace(async ({ path }) => {
    const setup = await prepareLiveProject(path, "/nonexistent/no-model-is-invoked");
    const entries = await new ProjectRegistry({ root: setup.registryRoot }).list();
    expect(entries[0]?.project.id).toBe(setup.project.id);
    expect(await readFile(join(setup.directory, "start-daemon.sh"), "utf8")).toContain(
      "env -u OPENAI_API_KEY",
    );
    await expect(inspectLiveProject(setup.directory)).rejects.toThrow();
    await writeFile(
      join(setup.project.root, "src/message.js"),
      "export function message() { return 'Hello from the Veyra fixture'; }\n",
    );
    expect(await inspectLiveProject(setup.directory)).toMatchObject({
      test: "passed",
      build: "passed",
      protectedFilesUnchanged: true,
    });
    await writeFile(join(setup.project.root, "test/message.test.js"), "// tampered\n");
    await expect(inspectLiveProject(setup.directory)).rejects.toThrow("Protected file changed");
  });
});

it("keeps earlier proof identity and evidence when preparing another proof in the same parent", async () => {
  await withFixtureWorkspace(async ({ path }) => {
    const parent = join(path, "persistent-proofs");
    const first = await prepareLiveProject(parent, "/nonexistent/no-model-is-invoked");
    await mkdir(join(first.project.root, ".veyra/artifacts"));
    const evidence = join(first.project.root, ".veyra/artifacts/earlier-proof.txt");
    await writeFile(evidence, "Earlier evidence must survive preparing the next proof.\n");
    const descriptor = await readFile(join(first.project.root, ".veyra/project.yaml"), "utf8");
    const second = await prepareLiveProject(parent, "/nonexistent/no-model-is-invoked");
    expect(await readdir(parent)).toHaveLength(2);
    expect(first.directory).not.toBe(second.directory);
    expect(first.project.id).not.toBe(second.project.id);
    expect(await readFile(join(first.project.root, ".veyra/project.yaml"), "utf8")).toBe(
      descriptor,
    );
    expect(await readFile(evidence, "utf8")).toBe(
      "Earlier evidence must survive preparing the next proof.\n",
    );
    for (const setup of [first, second]) {
      const entries = await new ProjectRegistry({ root: setup.registryRoot }).list();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ status: "available", project: setup.project });
    }
  });
});
