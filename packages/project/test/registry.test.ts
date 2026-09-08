import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { initializeProject, projectPaths, ProjectRegistry } from "../src/index.js";

const exec = promisify(execFile);
const moduleUrl = new URL("../dist/index.js", import.meta.url).href;
const runtimeUrl = new URL("../../runtime/dist/index.js", import.meta.url).href;

describe("Project Registry", () => {
  it("stores only identity, is idempotent, and preserves project data after removal", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const root = join(path, "registry");
      const registry = new ProjectRegistry({ root });
      expect(await registry.list()).toEqual([]);
      await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
      const project = await initializeProject(path);
      await writeFile(projectPaths(project).state, "unrelated state must not be parsed");
      await writeFile(join(path, "veyra.yaml"), "invalid provider config");
      await mkdir(join(path, "nested"));
      expect((await registry.register(join(path, "nested"))).project).toEqual(project);
      await registry.register(path);
      expect(await registry.list()).toEqual([{ project, status: "available" }]);
      const snapshot = JSON.parse(await readFile(join(root, "projects.json"), "utf8"));
      expect(snapshot).toEqual({ version: 1, projects: [project] });
      expect((await stat(join(root, "projects.json"))).mode & 0o777).toBe(0o600);
      expect(await registry.unregister(project.id)).toBe(true);
      expect(await registry.unregister(project.id)).toBe(false);
      expect(await registry.get(project.id)).toBeUndefined();
      expect(await readFile(projectPaths(project).state, "utf8")).toBe(
        "unrelated state must not be parsed",
      );
    });
  });

  it("discovers identical paths in a second cold process and serializes independent writers", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const root = join(path, "registry");
      const script = `const api = await import(${JSON.stringify(moduleUrl)}); const registry = new api.ProjectRegistry({root:process.argv[1]});
        await api.initializeProject(process.argv[2]); await registry.register(process.argv[2]);`;
      const directories = Array.from({ length: 5 }, (_, i) => join(path, `工程 ${i}`));
      await Promise.all(directories.map((directory) => mkdir(directory)));
      const registry = new ProjectRegistry({ root });
      let done = false;
      const writes = Promise.all(
        directories.map((directory) =>
          exec(process.execPath, ["--input-type=module", "-e", script, root, directory], {
            timeout: 15000,
          }),
        ),
      ).finally(() => {
        done = true;
      });
      while (!done) {
        const entries = await registry.list();
        expect(entries.every((entry) => entry.status === "available")).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      await writes;
      const entries = await registry.list();
      expect(entries).toHaveLength(5);
      const read = await exec(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const api = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(await new api.ProjectRegistry({root:process.argv[1]}).list()));`,
          root,
        ],
        { timeout: 10000 },
      );
      expect(JSON.parse(read.stdout)).toEqual(entries);
    });
  }, 25000);

  it("preserves stale entries and rejects duplicate identities even after the old root moves", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const registry = new ProjectRegistry({ root: join(path, "registry") });
      await mkdir(join(path, "one"));
      await mkdir(join(path, "two"));
      const first = await initializeProject(join(path, "one"));
      const second = await initializeProject(join(path, "two"));
      await registry.register(first.root);
      await writeFile(projectPaths(second).metadata, JSON.stringify({ ...second, id: first.id }));
      await expect(registry.register(second.root)).rejects.toMatchObject({
        code: "duplicate_project",
      });
      await rename(first.root, join(path, "moved"));
      expect(await registry.get(first.id)).toEqual({
        project: first,
        status: "stale",
        reason: "unavailable_path",
      });
      await expect(registry.register(second.root)).rejects.toMatchObject({
        code: "duplicate_project",
      });
      expect(await registry.list()).toHaveLength(1);
      expect(
        JSON.parse(await readFile(join(registry.root, "projects.json"), "utf8")).projects,
      ).toEqual([first]);
    });
  });

  it("distinguishes replaced identity from invalid metadata", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const registry = new ProjectRegistry({ root: join(path, "registry") });
      const project = await initializeProject(path);
      await registry.register(path);
      await writeFile(
        projectPaths(project).metadata,
        JSON.stringify({ ...project, id: "c9afe000-1234-4123-8123-123456789012" }),
      );
      expect((await registry.get(project.id))?.reason).toBe("identity_changed");
      await writeFile(projectPaths(project).metadata, "bad data");
      expect((await registry.get(project.id))?.reason).toBe("invalid_metadata");
    });
  });

  it("recovers a killed writer without consuming its partial temporary snapshot", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const registry = new ProjectRegistry({ root: join(path, "registry") });
      const project = await initializeProject(path);
      await registry.register(path);
      const script = `import {writeFile} from 'node:fs/promises'; import {join} from 'node:path';
        const {acquireLocalLock}=await import(${JSON.stringify(runtimeUrl)});
        await acquireLocalLock({directory:join(process.argv[1],'.projects-lock'),holder:'project-registry'});
        await writeFile(join(process.argv[1],'.projects-abandoned.tmp'),'{partial');
        process.stdout.write('ready'); setInterval(()=>{},1000);`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, registry.root], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exited = once(child, "exit");
      try {
        await Promise.race([
          once(child.stdout, "data", { signal: AbortSignal.timeout(5000) }),
          exited.then(() => {
            throw new Error("Writer exited before acquiring lock");
          }),
        ]);
        child.kill("SIGKILL");
        await exited;
        expect((await registry.get(project.id))?.status).toBe("available");
        await registry.register(path);
        expect(await registry.list()).toEqual([{ project, status: "available" }]);
        expect(await readdir(join(registry.root, ".projects-lock"))).toEqual([]);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await exited;
        }
      }
    });
  }, 15000);

  it.each(["invalid-json", "oversized", "secret-field", "symlink-file", "symlink-root"])(
    "rejects %s and preserves existing bytes",
    async (kind) => {
      await withFixtureWorkspace(async ({ path }) => {
        const root = join(path, "registry");
        const registry = new ProjectRegistry({ root });
        await initializeProject(path);
        await registry.register(path);
        const file = join(root, "projects.json");
        if (kind === "symlink-root") {
          await rename(root, join(path, "outside"));
          await symlink(join(path, "outside"), root);
        } else if (kind === "symlink-file") {
          await rename(file, join(path, "outside.json"));
          await symlink(join(path, "outside.json"), file);
        } else
          await writeFile(
            file,
            kind === "oversized"
              ? "x".repeat(1024 * 1024 + 1)
              : kind === "secret-field"
                ? JSON.stringify({ version: 1, projects: [], token: "secret-test-value" })
                : "{partial",
          );
        const original = await readFile(file);
        await expect(registry.list()).rejects.toMatchObject({ code: "invalid_registry" });
        await expect(registry.register(path)).rejects.toMatchObject({ code: "invalid_registry" });
        expect(await readFile(file)).toEqual(original);
      });
    },
  );
});
