import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { readProjectInstructions } from "../src/project-instructions.js";

describe("execution-root project instructions", () => {
  it("reads only the root rule file and does not expand includes or ancestor files", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      expect(await readProjectInstructions(path)).toEqual([]);
      const text = "遵守项目范围。\n@secret-file\nInclude ../outside.md";
      await writeFile(join(path, "AGENTS.md"), text);
      expect(await readProjectInstructions(path)).toEqual([{ source: "AGENTS.md", text }]);
      const child = join(path, "child");
      await mkdir(child);
      expect(await readProjectInstructions(child)).toEqual([]);
    });
  });
  it.each(["oversized", "invalid-utf8", "directory"])("refuses %s instructions", async (kind) => {
    await withFixtureWorkspace(async ({ path }) => {
      const file = join(path, "AGENTS.md");
      if (kind === "directory") await mkdir(file);
      else
        await writeFile(file, kind === "oversized" ? "x".repeat(32769) : Buffer.from([255, 254]));
      await expect(readProjectInstructions(path)).rejects.toThrow(/Project instructions/);
    });
  });
  it.skipIf(process.platform === "win32")(
    "refuses a linked rule file and preserves the target",
    async () => {
      await withFixtureWorkspace(async ({ path }) => {
        const target = join(path, "private.txt");
        await writeFile(target, "Do not read through a link");
        await symlink(target, join(path, "AGENTS.md"));
        await expect(readProjectInstructions(path)).rejects.toThrow(/regular file/);
        expect(await readFile(target, "utf8")).toBe("Do not read through a link");
      });
    },
  );
});
