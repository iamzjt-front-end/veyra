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
  "@veyraoss/workflow/workflow-v1.schema.json",
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
  it("validates opt-in ordered routing in both validators and checks candidate references at runtime", () => {
    const make = (routing: unknown) => ({
      ...minimal(),
      steps: {
        done: {
          type: "agent",
          agent: "primary",
          requires: { role: "planner", capabilities: ["reasoning"] },
          routing,
        },
      },
    });
    const routing = {
      fallbacks: ["backup"],
      fallbackOn: ["requirements", "unavailable", "budget"],
      allowUnknownReadiness: false,
      readinessTimeoutMs: 5000,
      budget: {
        currency: "USD",
        maxEstimatedCost: 0.02,
        estimates: [
          { agent: "primary", amount: 0.03 },
          { agent: "backup", amount: 0.01 },
        ],
      },
    };
    expect(validate(make(routing)), JSON.stringify(validate.errors)).toBe(true);
    expect(parseWorkflow(make(routing)).steps.done?.routing).toEqual(routing);
    for (const patch of [
      { fallbacks: ["backup", "backup"] },
      { fallbackOn: ["run_failure"] },
      { fallbackOn: ["unavailable", "unavailable"] },
      { fallbacks: [" "] },
      { fallbacks: ["x".repeat(129)] },
      { readinessTimeoutMs: 0 },
      { readinessTimeoutMs: 60001 },
      { allowUnknownReadiness: "yes" },
      { maxRetries: 4 },
      { budget: { ...routing.budget, maxEstimatedCost: -1 } },
      { budget: { ...routing.budget, currency: "usd" } },
    ]) {
      expect(validate(make({ ...routing, ...patch }))).toBe(false);
      expect(() => parseWorkflow(make({ ...routing, ...patch }))).toThrow("routing");
    }
    const missingRole = make(routing);
    missingRole.steps.done.requires = { role: "", capabilities: [] };
    expect(validate(missingRole)).toBe(false);
    expect(() => parseWorkflow(missingRole)).toThrow("requires");
    const noRequires = {
      ...minimal(),
      steps: { done: { type: "agent", agent: "primary", routing } },
    };
    expect(validate(noRequires)).toBe(false);
    expect(() => parseWorkflow(noRequires)).toThrow("requires.role");
    const command = {
      ...minimal(),
      steps: { done: { type: "command", run: ["node --version"], routing } },
    };
    expect(validate(command)).toBe(false);
    expect(() => parseWorkflow(command)).toThrow("routing");
    // Candidate-name relationships need the runtime parser, as do graph references elsewhere in v1.
    for (const patch of [
      { fallbacks: ["primary"] },
      { budget: { ...routing.budget, estimates: [{ agent: "absent", amount: 0 }] } },
      {
        budget: {
          ...routing.budget,
          estimates: [
            { agent: "backup", amount: 0 },
            { agent: "backup", amount: 1 },
          ],
        },
      },
    ])
      expect(() => parseWorkflow(make({ ...routing, ...patch }))).toThrow("routing");
  });
  it("accepts explicit role/capability requirements and rejects malformed or non-agent declarations", () => {
    const make = (requires: unknown) => ({
      ...minimal(),
      steps: { done: { type: "agent", agent: "analysis-binding", requires } },
    });
    expect(
      validate(make({ role: "planner", capabilities: ["reasoning", "example:retrieval"] })),
    ).toBe(true);
    expect(parseWorkflow(make({ role: "planner" })).steps.done?.requires).toEqual({
      role: "planner",
    });
    for (const requires of [
      { role: "" },
      { role: "x".repeat(129) },
      { capabilities: ["*"] },
      { capabilities: ["reasoning", "reasoning"] },
      { capabilities: ["cap with spaces"] },
      { optional: ["vision"] },
      { capabilities: Array.from({ length: 65 }, (_, i) => `cap-${i}`) },
    ]) {
      expect(validate(make(requires))).toBe(false);
      expect(() => parseWorkflow(make(requires))).toThrow("requires");
    }
    const command = {
      ...minimal(),
      steps: {
        done: {
          type: "command",
          run: ["node --version"],
          requires: { capabilities: ["reasoning"] },
        },
      },
    };
    expect(validate(command)).toBe(false);
    expect(() => parseWorkflow(command)).toThrow("requires");
  });
  it("accepts literal agent instructions and rejects invalid limits/types in both validators", () => {
    const make = (instructions: unknown) => ({
      ...minimal(),
      steps: { done: { type: "agent", agent: "reviewer", instructions } },
    });
    const literal = `Review \${literal}; do not evaluate $(commands) or templates.`;
    expect(validate(make(literal))).toBe(true);
    expect(parseWorkflow(make(literal)).steps.done?.instructions).toBe(literal);
    for (const instructions of [" ", 42, {}, "x".repeat(16385)]) {
      expect(validate(make(instructions))).toBe(false);
      expect(() => parseWorkflow(make(instructions))).toThrow("instructions");
    }
    const command = {
      ...minimal(),
      steps: { done: { type: "command", run: ["node --version"], instructions: literal } },
    };
    expect(validate(command)).toBe(false);
    expect(() => parseWorkflow(command)).toThrow("instructions");
  });
  it("agrees with runtime validation for workflow policies and leaf deadlines", () => {
    const base = {
      ...minimal(),
      start: "work",
      steps: { work: { type: "agent", agent: "worker", timeoutMs: 1000 } },
    };
    const policy = {
      stepTimeoutMs: 1000,
      retry: { max: 2, backoff: { initialMs: 10, multiplier: 2, maxMs: 100 } },
      concurrency: 2,
      maxSteps: 20,
      failureStrategy: "stop",
      approval: { before: ["work"] },
      budget: { maxTokens: 100, maxCost: { amount: 0.5, currency: "USD" } },
    };
    expect(validate({ ...base, policy }), JSON.stringify(validate.errors)).toBe(true);
    expect(() => parseWorkflow({ ...base, policy })).not.toThrow();
    for (const patch of [
      { stepTimeoutMs: 0 },
      { stepTimeoutMs: 86400001 },
      { concurrency: 33 },
      { maxSteps: 1001 },
      { retry: { max: -1 } },
      { retry: { max: 2, backoff: { initialMs: 1, multiplier: 1.5 } } },
      { retry: { max: 2, backoff: { initialMs: 1, maxMs: 3600001 } } },
      { failureStrategy: "ignore" },
      { approval: { before: ["work", "work"] } },
      { budget: {} },
      { budget: { maxTokens: -1 } },
      { budget: { maxCost: { amount: -1, currency: "USD" } } },
      { budget: { maxCost: { amount: 1, currency: " " } } },
      { unknown: true },
    ]) {
      const value = { ...base, policy: { ...policy, ...patch } };
      expect(validate(value), JSON.stringify(value)).toBe(false);
      expect(() => parseWorkflow(value)).toThrow();
    }
    for (const step of [
      { ...base.steps.work, timeoutMs: 0 },
      { type: "human", timeoutMs: 1 },
    ]) {
      const value = { ...base, steps: { work: step } };
      expect(validate(value)).toBe(false);
      expect(() => parseWorkflow(value)).toThrow();
    }
  });
  it("validates consensus policy fields and requires mode-specific quorum or judge", () => {
    const base = {
      ...minimal(),
      start: "group",
      steps: {
        ...minimal().steps,
        group: { type: "consensus", reviewers: ["a", "b"] },
        a: { type: "agent", agent: "a" },
        b: { type: "agent", agent: "b" },
        judge: { type: "agent", agent: "judge" },
      },
    };
    for (const patch of [{}, { mode: "quorum", quorum: 1 }, { mode: "judge", judge: "judge" }]) {
      const value = { ...base, steps: { ...base.steps, group: { ...base.steps.group, ...patch } } };
      expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
      expect(() => parseWorkflow(value)).not.toThrow();
    }
    for (const patch of [
      { reviewers: ["a"] },
      { reviewers: ["a", "a"] },
      { mode: "quorum" },
      { mode: "judge" },
      { quorum: 1 },
      { judge: "judge" },
      { mode: "quorum", quorum: 0 },
      { failurePolicy: "ignore" },
    ]) {
      const value = { ...base, steps: { ...base.steps, group: { ...base.steps.group, ...patch } } };
      expect(validate(value), JSON.stringify(value)).toBe(false);
      expect(() => parseWorkflow(value)).toThrow();
    }
  });
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

  it.each([
    "minimal",
    "approval",
    "review-loop",
    "inputs",
    "parallel",
    "router",
    "subworkflow",
    "subworkflow-child",
    "consensus",
    "policy",
    "capabilities",
    "provider-routing",
  ])("validates the documented %s example and editor schema path", async (name) => {
    const file = fileURLToPath(
      new URL(`../../../examples/workflows/v1/${name}.yaml`, import.meta.url),
    );
    const text = await readFile(file, "utf8");
    expect(validate(parse(text)), JSON.stringify(validate.errors)).toBe(true);
    const loaded = await loadWorkflow(file);
    expect(validate(loaded), JSON.stringify(validate.errors)).toBe(true);
    if (name !== "subworkflow") expect(loaded).toEqual(parseWorkflow(parse(text)));
    else expect(loaded.steps.suite?.workflow?.name).toBe("reusable-checks");
    const schemaReference = text.split("$schema=")[1]?.split("\n")[0];
    expect(schemaReference).toBeDefined();
    expect(fileURLToPath(new URL(schemaReference as string, pathToFileURL(file)))).toBe(schemaPath);
  });

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
