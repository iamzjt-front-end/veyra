import { expect, it, vi } from "vitest";
import type { ProjectId } from "@veyraoss/protocol";
import { BridgeController, type ExtensionHost } from "../src/controller.js";
import {
  extractHandoffBlock,
  frameHandoff,
  instruction,
  parseHandoff,
  type Binding,
} from "../src/contracts.js";
import { diagnosticText } from "../src/diagnostic-copy.js";

const binding: Binding = {
  id: "ef852a36-73ee-44e8-85f6-f3f4ba1da6bc",
  epoch: "fixture-document",
  conversation: "https://chatgpt.com/c/8e7dc509-d7f1-4d0a-958c-8c98ff011e64",
  tabId: 1,
  projectId: "62bf60b0-5646-4195-9f47-a4ea70140859" as ProjectId,
  projectName: "fixture",
  projectRoot: "/fixture",
  phase: "armed",
  count: 0,
  maxRuns: 3,
  nextRunId: "8e7dc509-d7f1-4d0a-958c-8c98ff011e64",
  message: "fixture",
};
function example() {
  const block = extractHandoffBlock(instruction(binding));
  if (!block) throw new Error("Missing instruction example");
  return parseHandoff(block, binding.projectId, binding.nextRunId);
}
it("gives the planner a complete valid canonical example with explicit field locations and types", () => {
  const handoff = example();
  expect(handoff.context.plan?.tasks.length).toBeGreaterThan(0);
  expect(handoff.context.currentTask).toBe(handoff.context.plan?.tasks[0]?.id);
  expect(typeof handoff.context.currentTask).toBe("string");
  expect(handoff.context.decisions).toEqual([]);
  expect(handoff.references).toEqual([]);
  expect(handoff.requestedVerification).toEqual([]);
  expect(handoff.context).not.toHaveProperty("requestedVerification");
  expect(handoff.context.plan?.provenance).toEqual(handoff.provenance);
  expect(instruction(binding)).toContain("context.currentTask");
  expect(instruction(binding)).toContain("最外层");
});
it("does not offer another handoff when the execution budget is exhausted", () => {
  expect(extractHandoffBlock(instruction({ ...binding, count: 3 }))).toBeUndefined();
});
it.each(["requestedVerification", "currentTask", "decisions"] as const)(
  "rejects the observed %s mistake with a translated explanation and no dispatch or rewrite",
  async (field) => {
    const handoff = example();
    const bad = {
      ...handoff,
      context: {
        ...handoff.context,
        [field]:
          field === "requestedVerification"
            ? [{ id: "test", kind: "test" }]
            : field === "currentTask"
              ? { id: "task-1", description: "Read only" }
              : ["Read only"],
      },
    };
    const source = frameHandoff(bad);
    let message = "";
    try {
      parseHandoff(source, binding.projectId, binding.nextRunId);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(field);
    expect(diagnosticText("zh-CN", message)).toContain("没有执行");
    expect(diagnosticText("en", message)).toContain("Nothing was executed");
    const save = vi.fn();
    const host: ExtensionHost = {
      read: async () => ({ binding: structuredClone(binding) }),
      save,
      activeTab: async () => ({ id: 1, url: binding.conversation }),
      tab: async () => ({ id: 1, url: binding.conversation }),
      send: vi.fn(),
    };
    const request = vi.fn<typeof fetch>();
    const controller = new BridgeController(host, request);
    await expect(
      controller.handle(
        { type: "dispatch", source, epoch: binding.epoch, bindingId: binding.id },
        { tabId: 1, url: binding.conversation },
      ),
    ).rejects.toThrow(field);
    expect(request).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(frameHandoff(bad)).toBe(source);
  },
);
