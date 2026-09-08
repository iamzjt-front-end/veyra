import { randomUUID } from "node:crypto";
import { link, readFile, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import {
  initializeProject,
  loadProject,
  loadProjectBindings,
  saveProjectBindings,
  projectPaths,
  ProjectRegistry,
} from "../src/index.js";

const roles = { executor: { provider: "codex", mode: "native" as const } };
it("preserves identity and optional safe continuity while the registry retains only locator metadata", async () => {
  await withFixtureWorkspace(async ({ path }) => {
    const project = await initializeProject(path);
    const registry = new ProjectRegistry({ root: join(path, "registry") });
    await registry.register(path);
    expect(await loadProjectBindings(project)).toBeUndefined();
    const session = {
      version: 1 as const,
      kind: "session" as const,
      provider: "codex",
      id: randomUUID(),
      runId: randomUUID(),
      projectId: project.id,
      createdAt: project.createdAt,
    };
    const next = await saveProjectBindings(
      project,
      { executor: { ...roles.executor, session } },
      0,
    );
    expect(await loadProject(path)).toEqual(project);
    expect(await loadProjectBindings(await loadProject(path))).toEqual(next);
    expect(await registry.get(project.id)).toEqual({ project, status: "available" });
    expect(await readFile(join(path, "registry", "projects.json"), "utf8")).not.toContain(
      "session",
    );
    expect((await stat(projectPaths(project).metadata)).mode & 0o777).toBe(0o600);
  });
});

it("serializes competing writes, rejects stale revisions and leaves no partial metadata", async () => {
  await withFixtureWorkspace(async ({ path }) => {
    const project = await initializeProject(path);
    const outcomes = await Promise.allSettled([
      saveProjectBindings(project, roles, 0),
      saveProjectBindings(project, roles, 0),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
      reason: { code: "bindings_conflict" },
    });
    const original = await readFile(projectPaths(project).metadata);
    await expect(saveProjectBindings(project, roles, 0)).rejects.toMatchObject({
      code: "bindings_conflict",
    });
    expect(await readFile(projectPaths(project).metadata)).toEqual(original);
    for (let revision = 1; revision < 4; revision++) {
      const [updated, ...readers] = await Promise.all([
        saveProjectBindings(project, roles, revision),
        ...Array.from({ length: 8 }, () => loadProject(path)),
      ]);
      expect(updated).toMatchObject({ revision: revision + 1 });
      expect(readers).toEqual(Array(8).fill(project));
    }
    expect(
      (await readdir(projectPaths(project).directory)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });
});

it.each(["symbolic", "hard"])(
  "refuses unsafe %s metadata without modifying its target",
  async (kind) => {
    await withFixtureWorkspace(async ({ path }) => {
      const project = await initializeProject(path);
      const target = join(path, "target.yaml");
      const source = await readFile(projectPaths(project).metadata);
      await writeFile(target, source);
      await unlink(projectPaths(project).metadata);
      await (kind === "symbolic" ? symlink : link)(target, projectPaths(project).metadata);
      await expect(saveProjectBindings(project, roles, 0)).rejects.toMatchObject({
        code: "invalid_project",
      });
      expect(await readFile(target)).toEqual(source);
    });
  },
);

it("rejects identity changes, unknown metadata and credential fields without overwriting evidence", async () => {
  await withFixtureWorkspace(async ({ path }) => {
    const project = await initializeProject(path);
    await expect(
      saveProjectBindings(
        project,
        { executor: { ...roles.executor, credentials: "secret" } } as never,
        0,
      ),
    ).rejects.toMatchObject({ code: "invalid_bindings" });
    await writeFile(
      projectPaths(project).metadata,
      JSON.stringify({
        ...project,
        bindings: {
          version: 1,
          projectId: project.id,
          revision: 1,
          updatedAt: project.createdAt,
          roles,
        },
        chatHistory: [],
      }),
    );
    await expect(loadProject(path)).rejects.toMatchObject({ code: "invalid_project" });
    await writeFile(
      projectPaths(project).metadata,
      JSON.stringify({ ...project, id: randomUUID() }),
    );
    await expect(loadProjectBindings(project)).rejects.toMatchObject({ code: "invalid_project" });
  });
});
