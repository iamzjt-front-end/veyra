import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { isProjectBindings, isProjectRoleBinding } from "../src/index.js";

const projectId = randomUUID();
const binding = { provider: "custom-vendor", mode: "native" };
const session = {
  version: 1,
  kind: "session",
  provider: binding.provider,
  id: randomUUID(),
  runId: randomUUID(),
  projectId,
  createdAt: new Date().toISOString(),
};
const bindings = {
  version: 1,
  projectId,
  revision: 1,
  updatedAt: session.createdAt,
  roles: { executor: { ...binding, session }, reviewer: { provider: "another", mode: "api" } },
};

it("keeps arbitrary roles independent of providers and validates scoped optional native locators", () => {
  expect(isProjectBindings(bindings)).toBe(true);
  expect(isProjectBindings({ ...bindings, roles: { custom: binding } })).toBe(true);
  expect(
    isProjectBindings({
      ...bindings,
      roles: { executor: { ...binding, session: { ...session, projectId: randomUUID() } } },
    }),
  ).toBe(false);
  expect(isProjectBindings({ ...bindings, extra: "not metadata" })).toBe(false);
  expect(isProjectBindings({ ...bindings, revision: 0 })).toBe(false);
});

it.each([
  { credentials: "secret" },
  { env: { TOKEN: "secret" } },
  { history: [] },
  { mode: "api", session },
  { provider: "another", session },
  { executable: "\0unsafe" },
  { model: "m".repeat(257) },
  { provider: "../vendor" },
])("rejects unsafe binding %#", (change) => {
  expect(isProjectRoleBinding({ ...binding, ...change })).toBe(false);
});

it("bounds the aggregate and rejects accessors without invoking them", () => {
  expect(
    isProjectBindings({
      ...bindings,
      roles: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`role-${i}`, binding])),
    }),
  ).toBe(false);
  expect(
    isProjectBindings({
      ...bindings,
      roles: Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [
          `role-${i}`,
          { ...binding, executable: "x".repeat(4096) },
        ]),
      ),
    }),
  ).toBe(false);
  let accessed = false;
  expect(
    isProjectRoleBinding({
      ...binding,
      get model() {
        accessed = true;
        return "secret";
      },
    }),
  ).toBe(false);
  expect(accessed).toBe(false);
});
