import { describe, expect, it } from "vitest";
import { parseWorkflow, resolveStepInputs } from "../src/index.js";

const workflow = (inputs: unknown, type = "agent") => ({
  name: "references",
  version: 1,
  start: "source",
  steps: {
    source: { type: "agent", agent: "planner", next: "target" },
    target: { type, ...(type === "agent" ? { agent: "executor" } : {}), inputs },
  },
});
describe("named step input references", () => {
  it("preserves selected JSON types, escaped pointer keys and literal strings without executing them", () => {
    const source = {
      data: {
        array: [
          1,
          true,
          null,
          "$(touch unwanted)",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Expression-like data must remain literal.
          "${{ evaluate() }}",
        ],
        "a/b": { "~key": "value" },
      },
    };
    const resolved = resolveStepInputs(
      {
        array: { from: "source", path: "/data/array" },
        escaped: { from: "source", path: "/data/a~1b/~0key" },
        first: { from: "source", path: "/data/array/0" },
        whole: { from: "source", path: "" },
      },
      () => source,
    );
    expect(resolved).toEqual({
      array: source.data.array,
      escaped: "value",
      first: 1,
      whole: source,
    });
    (resolved.array as unknown[]).push("changed");
    expect(source.data.array).toHaveLength(5);
  });

  it.each([
    "/data/toString",
    "/data/constructor",
    "/data/array/01",
    "/data/array/-",
    "/data/array/length",
    "/data/array/9",
    "/absent",
  ])("refuses missing/inherited/non-canonical path %s", (path) => {
    expect(() =>
      resolveStepInputs({ item: { from: "source", path } }, () => ({ data: { array: [1] } })),
    ).toThrow("cannot resolve its path");
  });

  it("accepts an explicit own prototype-shaped JSON key and never invokes output getters", () => {
    expect(
      resolveStepInputs({ own: { from: "source", path: "/__proto__/value" } }, () =>
        JSON.parse('{"__proto__":{"value":4}}'),
      ),
    ).toEqual({ own: 4 });
    let accessed = false;
    const value = Object.defineProperty({}, "data", {
      enumerable: true,
      get: () => {
        accessed = true;
        return "unsafe";
      },
    });
    expect(() =>
      resolveStepInputs({ item: { from: "source", path: "/data" } }, () => value),
    ).toThrow("requires a persisted output");
    expect(accessed).toBe(false);
  });

  it("bounds the actual combined serialized size including keys and escaped characters", () => {
    expect(() =>
      resolveStepInputs({ item: { from: "source", path: "/data" } }, () => ({
        data: "\0".repeat(6000),
      })),
    ).toThrow("32 KiB");
    expect(() =>
      resolveStepInputs(
        { one: { from: "source", path: "" }, two: { from: "source", path: "" } },
        () => "x".repeat(20_000),
      ),
    ).toThrow("32 KiB");
  });

  it.each([
    null,
    [],
    { item: "source.data" },
    { item: { from: "source" } },
    { item: { from: "missing", path: "" } },
    { item: { from: "source", path: "data" } },
    { item: { from: "source", path: "\n" } },
    { item: { from: "source", path: "/bad~2escape" } },
    { item: { from: "source", path: "/bad~" } },
    { item: { from: "source", path: "/x".repeat(33) } },
    { item: { from: "source", path: `/${"x".repeat(1024)}` } },
    { item: { from: "source", path: "", default: "implicit fallback" } },
    { " ": { from: "source", path: "" } },
    { ["x".repeat(129)]: { from: "source", path: "" } },
    Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`value${index}`, { from: "source", path: "" }]),
    ),
  ])("rejects malformed references %# with an actionable field", (inputs) => {
    expect(() => parseWorkflow(workflow(inputs))).toThrow("steps.target.inputs");
  });

  it("accepts references on agent/human nodes and refuses command interpolation", () => {
    const inputs = { selected: { from: "source", path: "/data" } };
    expect(parseWorkflow(workflow(inputs)).steps.target?.inputs).toEqual(inputs);
    expect(parseWorkflow(workflow(inputs, "human")).steps.target?.inputs).toEqual(inputs);
    expect(() => parseWorkflow(workflow(inputs, "command"))).toThrow("steps.target.inputs");
  });
});
