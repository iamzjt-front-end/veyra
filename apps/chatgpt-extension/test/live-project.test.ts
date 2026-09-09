import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { prepareLiveProject, inspectLiveProject } from "./live-project.js";
import { ProjectRegistry } from "@veyraoss/project";

it("prepares a disposable native-bound Project and detects real failure, success and protected-file tampering", async () => {
  const setup = await prepareLiveProject("/nonexistent/no-model-is-invoked");
  try {
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
  } finally {
    await rm(setup.directory, { recursive: true, force: true });
  }
});
