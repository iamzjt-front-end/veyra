import { describe, expect, it } from "vitest";
import {
  nextRetry,
  withRetryDefaults,
  type WorkflowDefinition,
  type WorkflowStep,
} from "../src/index.js";

describe("retry policy", () => {
  it("snapshots explicit limits before runtime defaults without mutating the workflow", () => {
    const workflow: WorkflowDefinition = {
      name: "retry",
      version: 1,
      start: "work",
      steps: {
        work: { type: "agent", agent: "custom", retry: { max: 4 }, next: "check" },
        check: { type: "command", run: ["test"] },
      },
    };
    const copy = withRetryDefaults(workflow, 1);
    expect(copy.steps.work?.retry?.max).toBe(4);
    expect(copy.steps.check?.retry?.max).toBe(1);
    expect(workflow.steps.check?.retry).toBeUndefined();
  });

  it("counts the first recovery entry as a repair and normal first entry as initial work", () => {
    const step = { type: "agent", agent: "custom", retry: { max: 3 } } as const;
    expect(nextRetry(step, undefined, "success")).toEqual({
      allowed: true,
      retryCount: 0,
      maxRetries: 3,
    });
    expect(nextRetry(step, undefined, "failure")).toEqual({
      allowed: true,
      retryCount: 1,
      maxRetries: 3,
    });
    expect(nextRetry(step, 2, "success")).toEqual({ allowed: true, retryCount: 3, maxRetries: 3 });
    expect(nextRetry(step, 3, "success")).toEqual({ allowed: false, retryCount: 3, maxRetries: 3 });
  });

  it("allows initial work with zero retries but refuses repairs and counter overflow", () => {
    const step: WorkflowStep = { type: "command", run: ["test"], retry: { max: 0 } };
    expect(nextRetry(step, undefined).allowed).toBe(true);
    expect(nextRetry(step, 0).allowed).toBe(false);
    expect(nextRetry(step, undefined, "fail").allowed).toBe(false);
    expect(
      nextRetry({ ...step, retry: { max: Number.MAX_SAFE_INTEGER } }, Number.MAX_SAFE_INTEGER)
        .allowed,
    ).toBe(false);
  });

  it.each([-1, NaN, 1.5, Infinity])("rejects invalid counters/limits %s", (value) => {
    expect(() => nextRetry({ type: "agent", retry: { max: value } }, undefined)).toThrow();
    expect(() => nextRetry({ type: "agent", retry: { max: 3 } }, value)).toThrow();
  });
});
