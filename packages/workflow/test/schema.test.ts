import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { loadWorkflow, parseWorkflow } from "../src/index.js";

const schemaPath = createRequire(import.meta.url).resolve(
  "@veyra/workflow/workflow-v1.schema.json",
);
const schema = JSON.parse(await readFile(schemaPath, "utf8"));
const validate = new Ajv({ strict: true, allErrors: true }).compile(schema);
const minimal = () => ({
  name: "fixture",
  version: 1,
  start: "done",
  steps: { done: { type: "end" } },
});

describe("published version 1 workflow schema", () => {
  it("validates named input bindings and rejects invalid pointer syntax/limits in both validators", () => {
    const make = (path: string) => ({
      ...minimal(),
      start: "source",
      steps: {
        source: { type: "agent", agent: "planner", next: "target" },
        target: { type: "human", inputs: { value: { from: "source", path } } },
      },
    });
    for (const pointer of [
      "",
      "/data",
      "/data/a~1b/~0key",
      "/results/0/exitCode",
      "/~01",
      `/${"🧭".repeat(800)}`,
    ]) {
      expect(validate(make(pointer)), JSON.stringify(validate.errors)).toBe(true);
      expect(() => parseWorkflow(make(pointer))).not.toThrow();
    }
    for (const pointer of ["\n", "data", "/bad~", "/~2", "/x".repeat(33), `/${"x".repeat(1024)}`]) {
      expect(validate(make(pointer)), pointer).toBe(false);
      expect(() => parseWorkflow(make(pointer))).toThrow("steps.target.inputs.value.path");
    }
  });
  it.each(["dev", "bugfix", "review", "research"])(
    "validates the %s preset with the schema and runtime parser",
    async (preset) => {
      const workflow = await loadWorkflow(preset);
      expect(validate(workflow), JSON.stringify(validate.errors)).toBe(true);
    },
  );

  it.each(["minimal", "approval", "review-loop", "inputs", "parallel", "router"])(
    "validates the documented %s example and editor schema path",
    async (name) => {
      const file = fileURLToPath(
        new URL(`../../../examples/workflows/v1/${name}.yaml`, import.meta.url),
      );
      const text = await readFile(file, "utf8");
      expect(validate(parse(text)), JSON.stringify(validate.errors)).toBe(true);
      expect(await loadWorkflow(file)).toEqual(parseWorkflow(parse(text)));
      const schemaReference = text.split("$schema=")[1]?.split("\n")[0];
      expect(schemaReference).toBeDefined();
      expect(fileURLToPath(new URL(schemaReference as string, pathToFileURL(file)))).toBe(
        schemaPath,
      );
    },
  );

  it.each([
    { name: "future version", value: { ...minimal(), version: 2 } },
    { name: "string version", value: { ...minimal(), version: "1" } },
    { name: "missing name", value: { version: 1, start: "done", steps: minimal().steps } },
    { name: "empty name", value: { ...minimal(), name: " \n\t" } },
    { name: "unknown root field", value: { ...minimal(), extra: true } },
    { name: "empty steps", value: { ...minimal(), steps: {} } },
    { name: "blank step key", value: { ...minimal(), steps: { " ": { type: "end" } } } },
    ...[
      { type: "agent" },
      { type: "agent", agent: "" },
      { type: "agent", agent: "executor", run: ["node --version"] },
      { type: "agent", agent: "executor", retry: { max: -1 } },
      { type: "agent", agent: "executor", retry: { max: 1.5 } },
      { type: "agent", agent: "executor", retry: { max: Number.MAX_SAFE_INTEGER + 1 } },
      { type: "agent", agent: "executor", retry: { max: 1, delay: 1 } },
      { type: "command", run: [] },
      { type: "command", run: [" "] },
      { type: "human", message: false },
      { type: "human", on: { " ": "done" } },
      { type: "human", on: { approved: " " } },
      { type: "end", next: "done" },
      { type: "end", retry: { max: 0 } },
      { type: "end", metadata: [] },
      { type: "parallel" },
      { type: "router" },
      { type: "subworkflow" },
    ].map((step, index) => ({
      name: `invalid node ${index}`,
      value: { ...minimal(), steps: { done: step } },
    })),
  ])("agrees with runtime rejection for $name", ({ value }) => {
    expect(validate(value)).toBe(false);
    expect(() => parseWorkflow(value)).toThrow();
  });

  it("supports all existing optional fields without rewriting values", () => {
    const value = {
      ...minimal(),
      start: "work",
      steps: {
        ...minimal().steps,
        work: {
          type: "agent",
          agent: "executor",
          next: "done",
          on: { success: "done" },
          retry: { max: 0 },
          metadata: { nested: [null, 1, true, { note: "annotation" }] },
        },
      },
    };
    const original = structuredClone(value);
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    expect(parseWorkflow(value)).toEqual(original);
    expect(value).toEqual(original);
  });

  it("leaves graph references to the runtime's actionable semantic validation", () => {
    const value = { ...minimal(), start: "absent" };
    expect(validate(value)).toBe(true);
    expect(() => parseWorkflow(value)).toThrow("start: step 'absent' does not exist");
  });

  it("rejects future versions with the file and version field before execution", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const file = join(path, "future.yaml");
      await writeFile(file, JSON.stringify({ ...minimal(), version: 999 }));
      await expect(loadWorkflow(file)).rejects.toMatchObject({
        filePath: file,
        field: "version",
        detail: "expected schema version 1",
      });
    });
  });
});
