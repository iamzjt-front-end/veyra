import { execFile } from "node:child_process";
import {
  cp,
  link,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import {
  assertUniqueProjectIds,
  initializeProject,
  loadProject,
  openProject,
  projectPaths,
} from "../src/index.js";

const exec = promisify(execFile);
const moduleUrl = new URL("../dist/index.js", import.meta.url).href;

describe("local Project", () => {
  it("preserves existing files and reopens identity from root/nested directories", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await writeFile(join(path, "veyra.yaml"), "existing workflow");
      await mkdir(join(path, ".veyra", "runs"), { recursive: true });
      const project = await initializeProject(path, { name: "Local project" });
      expect(await loadProject(path)).toEqual(project);
      await mkdir(join(path, "src", "nested"), { recursive: true });
      expect(await openProject(join(path, "src", "nested"))).toEqual(project);
      expect(await readFile(join(path, "veyra.yaml"), "utf8")).toBe("existing workflow");
      expect((await readdir(projectPaths(project).directory)).sort()).toEqual([
        "project.yaml",
        "runs",
      ]);
      expect(projectPaths(project).state).toBe(join(await realpath(path), ".veyra", "state.json"));
      expect((await stat(projectPaths(project).metadata)).mode & 0o777).toBe(0o600);
      project.name = "in memory only";
      expect((await loadProject(path)).name).toBe("Local project");
    });
  });

  it("creates and reopens in three independent processes with networking disabled and no API keys", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await mkdir(join(path, "nested"));
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET/.test(key)) delete env[key];
      const run = async (operation: string, directory: string) => {
        const script = `
          import net from 'node:net'; import http from 'node:http'; import https from 'node:https';
          const deny = () => { throw new Error('Network is forbidden'); };
          net.Socket.prototype.connect = deny; http.request = deny; https.request = deny; globalThis.fetch = deny;
          const api = await import(${JSON.stringify(moduleUrl)});
          const project = await api[process.argv[1]](process.argv[2]);
          process.stdout.write(JSON.stringify({project, paths:api.projectPaths(project)}));
        `;
        const result = await exec(
          process.execPath,
          ["--input-type=module", "-e", script, operation, directory],
          { env, timeout: 10000 },
        );
        return JSON.parse(result.stdout);
      };
      const created = await run("initializeProject", path);
      expect(await run("loadProject", path)).toEqual(created);
      expect(await run("openProject", join(path, "nested"))).toEqual(created);
    });
  });

  it("supports spaces/unicode and canonical symlink aliases", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const root = join(path, "项目 one");
      await mkdir(root);
      await symlink(root, join(path, "alias"));
      const project = await initializeProject(join(path, "alias"));
      expect(project.name).toBe("项目 one");
      expect(project.root).toBe(await realpath(root));
      expect(await openProject(join(path, "alias"))).toEqual(project);
    });
  });

  it("does not cross a symlink into a different physical project", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await mkdir(join(path, "one"));
      await mkdir(join(path, "two"));
      const first = await initializeProject(join(path, "one"));
      const second = await initializeProject(join(path, "two"));
      await symlink(second.root, join(first.root, "linked"));
      expect(await openProject(join(first.root, "linked"))).toEqual(second);
    });
  });

  it("never overwrites metadata and has one winner under concurrent initialization", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const outcomes = await Promise.allSettled(
        Array.from({ length: 6 }, () => initializeProject(path)),
      );
      const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
      expect(winners).toHaveLength(1);
      for (const outcome of outcomes)
        if (outcome.status === "rejected") expect(outcome.reason.code).toBe("project_exists");
      expect(await loadProject(path)).toEqual(winners[0]?.value);
      await expect(initializeProject(path)).rejects.toMatchObject({ code: "project_exists" });
    });
  });

  it("rejects conflicting identities, copied metadata and moved roots explicitly", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await mkdir(join(path, "one"));
      await mkdir(join(path, "two"));
      const first = await initializeProject(join(path, "one"));
      const second = await initializeProject(join(path, "two"));
      expect(() => assertUniqueProjectIds([first, second, first])).not.toThrow();
      expect(() => assertUniqueProjectIds([first, { ...second, id: first.id }])).toThrow(
        /identity conflicts/,
      );
      expect(() => assertUniqueProjectIds([first, { ...second, root: first.root }])).toThrow(
        /identity conflicts/,
      );
      await cp(projectPaths(first).metadata, projectPaths(second).metadata);
      await expect(loadProject(second.root)).rejects.toMatchObject({
        code: "project_path_mismatch",
      });
      await rename(first.root, join(path, "moved"));
      await expect(loadProject(first.root)).rejects.toMatchObject({ code: "invalid_path" });
      await expect(loadProject(join(path, "moved"))).rejects.toMatchObject({
        code: "project_path_mismatch",
      });
    });
  });

  it("reports nonexistent, non-directory and uninitialized paths without ancestor fallback", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await expect(loadProject(path)).rejects.toMatchObject({ code: "project_missing" });
      await initializeProject(path);
      for (const invalid of [
        "",
        "a\0b",
        join(path, "absent"),
        join(path, ".veyra", "project.yaml"),
      ]) {
        await expect(openProject(invalid)).rejects.toMatchObject({ code: "invalid_path" });
      }
    });
  });

  it("stops at corrupt nearer metadata and rejects unknown fields without echoing values", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await initializeProject(path);
      const nested = join(path, "nested");
      await mkdir(nested);
      const project = await initializeProject(nested);
      await writeFile(projectPaths(project).metadata, "auth: sensitive-test-value\n");
      await expect(openProject(nested)).rejects.toMatchObject({ code: "invalid_project" });
      await expect(loadProject(nested)).rejects.not.toThrow(/sensitive-test-value/);
    });
  });

  it.each(["state-symlink", "metadata-symlink", "metadata-hardlink", "metadata-directory"])(
    "refuses %s",
    async (kind) => {
      await withFixtureWorkspace(async ({ path }) => {
        await mkdir(join(path, "project"));
        await mkdir(join(path, "external"));
        const project = await initializeProject(join(path, "project"));
        const paths = projectPaths(project);
        if (kind === "state-symlink") {
          await rename(paths.directory, join(path, "external", "state"));
          await symlink(join(path, "external", "state"), paths.directory);
        } else {
          const original = join(path, "external", "metadata");
          await rename(paths.metadata, original);
          if (kind === "metadata-symlink") await symlink(original, paths.metadata);
          else if (kind === "metadata-hardlink") await link(original, paths.metadata);
          else await mkdir(paths.metadata);
        }
        await expect(loadProject(project.root)).rejects.toMatchObject({ code: "invalid_project" });
      });
    },
  );

  it("bounds metadata and rejects duplicate YAML keys and aliases", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const project = await initializeProject(path);
      for (const source of ["x".repeat(65537), "version: 1\nversion: 1", "a: &a [1]\nb: *a"]) {
        await writeFile(projectPaths(project).metadata, source);
        await expect(loadProject(path)).rejects.toMatchObject({ code: "invalid_project" });
      }
      await rm(projectPaths(project).metadata);
      await expect(loadProject(path)).rejects.toMatchObject({ code: "project_missing" });
    });
  });
});
