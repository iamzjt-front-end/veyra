import { describe, expect, it } from "vitest";
import { isProjectDescriptor, isProjectId } from "../src/index.js";

const descriptor = {
  version: 1,
  id: "f1cafe00-1897-4555-a629-123456789012",
  name: "工程",
  root: "/tmp/My app",
  createdAt: "2026-09-08T00:00:00.000Z",
};

describe("Project contracts", () => {
  it("accepts a serializable provider-neutral identity", () => {
    expect(isProjectId(descriptor.id)).toBe(true);
    expect(isProjectDescriptor(JSON.parse(JSON.stringify(descriptor)))).toBe(true);
  });
  it.each([
    { id: "../project" },
    { version: 2 },
    { root: "relative" },
    { root: "/tmp/../app" },
    { name: " " },
    { name: "a\nb" },
    { createdAt: "not a date" },
    { auth: "secret" },
    { history: [] },
  ])("rejects invalid identity or extra fields: %j", (patch) => {
    expect(isProjectDescriptor({ ...descriptor, ...patch })).toBe(false);
  });
  it("does not invoke accessors", () => {
    const value = { ...descriptor };
    Object.defineProperty(value, "name", {
      get: () => {
        throw new Error("Must not execute");
      },
    });
    expect(isProjectDescriptor(value)).toBe(false);
  });
});
