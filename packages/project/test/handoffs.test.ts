import { randomUUID } from "node:crypto";
import { link, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureProjectState } from "../../../test/helpers/project-state.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { initializeProject, ProjectHandoffStore, projectPaths } from "../src/index.js";

describe("immutable Project run envelopes", () => {
  it("stores only safe Project/run-bound native locators and preserves an existing reference", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const project = await initializeProject(path);
      const store = new ProjectHandoffStore({ project });
      const reference = {
        version: 1 as const,
        kind: "session" as const,
        provider: "native-fixture",
        id: randomUUID(),
        projectId: project.id,
        runId: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      expect(await store.getSession(reference.runId)).toBeUndefined();
      await store.createSession(reference);
      expect(await new ProjectHandoffStore({ project }).getSession(reference.runId)).toEqual(
        reference,
      );
      await expect(store.createSession({ ...reference, id: randomUUID() })).rejects.toMatchObject({
        code: "handoff_exists",
      });
      expect(await store.getSession(reference.runId)).toEqual(reference);
      await expect(
        store.createSession({ ...reference, projectId: randomUUID() as typeof project.id }),
      ).rejects.toMatchObject({ code: "invalid_handoff" });
      const source = await readFile(
        join(projectPaths(project).handoffs, `${reference.runId}.session.json`),
        "utf8",
      );
      expect(JSON.parse(source)).toEqual(reference);
      expect(Object.keys(JSON.parse(source))).toHaveLength(7);
    });
  });
  it("keeps past handoffs/results redacted and refuses duplicate publication", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const project = await initializeProject(path);
      const fixture = fixtureProjectState(project.id);
      if (!fixture.handoff || !fixture.result) throw new Error("Incomplete fixture");
      const store = new ProjectHandoffStore({ project, redactValues: ["fixture-private-secret"] });
      const ids = [randomUUID(), randomUUID()] as const;
      for (const runId of ids) {
        const handoff = {
          ...fixture.handoff,
          runId,
          id: randomUUID(),
          context: { ...fixture.context, goal: "Use fixture-private-secret" },
        };
        const result = {
          ...fixture.result,
          runId,
          handoffId: handoff.id,
          evidence: [],
          artifacts: [],
        };
        expect((await store.createHandoff(handoff)).context.goal).not.toContain(
          "fixture-private-secret",
        );
        await store.createResult(result);
        const file = join(projectPaths(project).handoffs, `${runId}.handoff.json`);
        const before = await readFile(file, "utf8");
        await expect(store.createHandoff(handoff)).rejects.toMatchObject({
          code: "handoff_exists",
        });
        await expect(store.createResult(result)).rejects.toMatchObject({ code: "handoff_exists" });
        expect(await readFile(file, "utf8")).toBe(before);
        expect(before).not.toContain("fixture-private-secret");
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect((await new ProjectHandoffStore({ project }).getResult(runId))?.handoffId).toBe(
          handoff.id,
        );
      }
      expect((await store.getHandoff(ids[0]))?.runId).toBe(ids[0]);
      expect(await store.getHandoff(randomUUID())).toBeUndefined();
    });
  });
  it("rejects mismatched and linked envelopes without touching their targets", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const project = await initializeProject(path);
      const fixture = fixtureProjectState(project.id);
      if (!fixture.handoff || !fixture.result) throw new Error("Incomplete fixture");
      const runId = randomUUID();
      const handoff = { ...fixture.handoff, runId };
      const store = new ProjectHandoffStore({ project });
      await expect(store.getHandoff("../../outside")).rejects.toMatchObject({
        code: "invalid_handoff",
      });
      await expect(
        store.createHandoff({ ...handoff, projectId: randomUUID() as typeof project.id }),
      ).rejects.toMatchObject({ code: "invalid_handoff" });
      await store.createHandoff(handoff);
      await expect(
        store.createResult({
          ...fixture.result,
          runId,
          handoffId: "wrong",
          evidence: [],
          artifacts: [],
        }),
      ).rejects.toMatchObject({ code: "invalid_handoff" });
      const file = join(projectPaths(project).handoffs, `${runId}.handoff.json`);
      const target = join(path, "outside.json");
      const source = await readFile(file);
      await writeFile(target, source);
      for (const makeLink of [symlink, link]) {
        await unlink(file);
        await makeLink(target, file);
        await expect(store.getHandoff(runId)).rejects.toMatchObject({ code: "invalid_handoff" });
        expect(await readFile(target)).toEqual(source);
      }
      await unlink(file);
      await writeFile(file, "x".repeat(65537));
      await expect(store.getHandoff(runId)).rejects.toMatchObject({ code: "invalid_handoff" });
      expect((await stat(file)).size).toBe(65537);
    });
  });
});
