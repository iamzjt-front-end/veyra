import { randomUUID } from "node:crypto";
import { readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  initializeProject,
  ProjectHandoffStore,
  ProjectStateStore,
  projectPaths,
} from "@veyraoss/project";
import { fixtureProjectState } from "../../../test/helpers/project-state.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { startDaemon, DaemonClient, projectTool } from "../src/index.js";

describe("persisted Project review API", { timeout: 30000 }, () => {
  it("records once, mirrors current state, restores after daemon restart and preserves history", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const project = await initializeProject(path);
      const fixture = fixtureProjectState(project.id);
      const archive = new ProjectHandoffStore({ project });
      const shared = new ProjectStateStore({ project });
      const runId = randomUUID();
      const handoff = { ...fixture.handoff!, runId };
      const result = {
        ...fixture.result!,
        runId,
        evidence: [],
        artifacts: [],
        status: "failed" as const,
        executionStatus: "completed" as const,
      };
      const review = {
        ...fixture.review!,
        runId,
        evidence: [],
        handoffId: handoff.id,
        findings: [{ severity: "warning" as const, description: "BROKEN remains by design" }],
        sourceVerdict: "PASS" as const,
      };
      await archive.createHandoff(handoff);
      await archive.createResult(result);
      await shared.save(
        { context: handoff.context, provenance: handoff.provenance, handoff, result },
        0,
      );
      const registryRoot = join(path, "registry");
      let daemon = await startDaemon({ registryRoot });
      try {
        const client = new DaemonClient({ registryRoot });
        await client.call("projects.register", { path });
        const locator = { projectId: project.id, runId };
        expect(await client.call("reviews.get", locator)).toBeNull();
        const request = { version: 1, method: "reviews.submit", params: { ...locator, review } };
        await expect(
          projectTool(request, { client, allowed: () => false, authorize: () => {} }),
        ).rejects.toMatchObject({ code: "project_forbidden" });
        await expect(
          projectTool(request, {
            client,
            allowed: () => true,
            authorize: () => {
              throw new Error("revoked");
            },
          }),
        ).rejects.toThrow("revoked");
        expect(await archive.getReview(runId)).toBeUndefined();
        await Promise.all(
          Array.from({ length: 4 }, () => client.call("reviews.submit", { ...locator, review })),
        );
        const snapshot = await shared.read();
        expect(snapshot?.revision).toBe(2);
        expect(snapshot?.review).toEqual(review);
        expect(snapshot?.result?.status).toBe("failed");
        const file = join(projectPaths(project).handoffs, `${runId}.review.json`);
        const before = await stat(file);
        await client.call("reviews.submit", { ...locator, review });
        expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect((await shared.read())?.revision).toBe(2);
        for (const field of ["projectId", "runId", "resultId", "handoffId"])
          await expect(
            client.call("reviews.submit", {
              ...locator,
              review: { ...review, [field]: randomUUID() },
            }),
          ).rejects.toThrow();
        await expect(
          client.call("reviews.submit", {
            ...locator,
            review: { ...review, verdict: "fail", sourceVerdict: "FAIL", nextAction: "repair" },
          }),
        ).rejects.toThrow();
        expect(JSON.parse(await readFile(file, "utf8"))).toEqual(review);
        const nextHandoff = { ...handoff, id: randomUUID(), runId: randomUUID() };
        await shared.save(
          {
            context: nextHandoff.context,
            provenance: nextHandoff.provenance,
            handoff: nextHandoff,
          },
          2,
        );
        await client.call("reviews.submit", { ...locator, review });
        expect((await shared.read())?.handoff?.id).toBe(nextHandoff.id);
        expect((await shared.read())?.revision).toBe(3);
        await daemon.stop();
        daemon = await startDaemon({ registryRoot });
        const cold = new DaemonClient({ registryRoot });
        expect(await cold.call("reviews.get", locator)).toEqual(review);
        expect(
          await projectTool(
            { version: 1, method: "reviews.get", params: locator },
            {
              client: cold,
              allowed: () => true,
              authorize: () => {},
            },
          ),
        ).toEqual(review);
      } finally {
        await daemon.stop();
      }
    });
  });
  it("rejects review without a result, linked/oversized archives and redacts duplicate content consistently", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const project = await initializeProject(path);
      const fixture = fixtureProjectState(project.id);
      const runId = randomUUID();
      const store = new ProjectHandoffStore({ project, redactValues: ["fixture-secret-value"] });
      const handoff = { ...fixture.handoff!, runId };
      const result = { ...fixture.result!, runId, evidence: [], artifacts: [] };
      const review = {
        ...fixture.review!,
        runId,
        evidence: [],
        summary: "Inspect fixture-secret-value",
      };
      await store.createHandoff(handoff);
      await expect(store.createReview(review)).rejects.toThrow();
      await store.createResult(result);
      const saved = await store.createReview(review);
      expect(saved.summary).not.toContain("fixture-secret-value");
      expect(await store.createReview(review)).toEqual(saved);
      const file = join(projectPaths(project).handoffs, `${runId}.review.json`);
      const target = join(path, "outside-review.json");
      const content = await readFile(file);
      await writeFile(target, content);
      await unlink(file);
      await symlink(target, file);
      await expect(store.getReview(runId)).rejects.toThrow();
      await expect(store.createReview(review)).rejects.toThrow();
      expect(await readFile(target)).toEqual(content);
      await unlink(file);
      await writeFile(file, "x".repeat(65537));
      await expect(store.getReview(runId)).rejects.toThrow();
    });
  });
});
