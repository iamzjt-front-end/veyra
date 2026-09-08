import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ProjectId } from "@veyraoss/protocol";
import { fixtureProjectState } from "../../../test/helpers/project-state.js";
import {
  isNativeSessionReference,
  isNativeSessionRequest,
  isProjectExecutionResult,
} from "../src/index.js";

const project = {
  version: 1 as const,
  id: randomUUID() as ProjectId,
  name: "fixture",
  root: "/fixture",
  createdAt: new Date().toISOString(),
};
const reference = {
  version: 1,
  kind: "session",
  provider: "custom-native",
  id: randomUUID(),
  projectId: project.id,
  runId: randomUUID(),
  createdAt: project.createdAt,
};
describe("safe native session references", () => {
  it("permits provider-neutral references while binding result/session identities", () => {
    expect(isNativeSessionReference(reference)).toBe(true);
    expect(isNativeSessionRequest({ project, resume: reference })).toBe(true);
    const result = {
      ...fixtureProjectState(project.id).result,
      runId: reference.runId,
      evidence: [],
      artifacts: [],
      session: reference,
    };
    expect(isProjectExecutionResult(result)).toBe(true);
    expect(
      isProjectExecutionResult({ ...result, session: { ...reference, runId: randomUUID() } }),
    ).toBe(false);
    expect(
      isNativeSessionRequest({ project, resume: { ...reference, projectId: randomUUID() } }),
    ).toBe(false);
  });
  it.each([
    { version: 2 },
    { id: "../../auth.json" },
    { id: "secret-bearer-token" },
    { projectId: "project-name" },
    { runId: "run-name" },
    { provider: "native/../vendor" },
    { token: "fixture-secret" },
    { history: ["private chat"] },
    { createdAt: "yesterday" },
  ])("rejects unsafe reference %#", (change) => {
    expect(isNativeSessionReference({ ...reference, ...change })).toBe(false);
  });
  it("rejects credential-shaped requests and getters without executing them", () => {
    expect(isNativeSessionRequest({ project, credentials: "fixture-secret" })).toBe(false);
    let touched = false;
    expect(
      isNativeSessionReference({
        ...reference,
        get id() {
          touched = true;
          return randomUUID();
        },
      }),
    ).toBe(false);
    expect(touched).toBe(false);
  });
});
