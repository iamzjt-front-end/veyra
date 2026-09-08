import { describe, expect, it } from "vitest";
import {
  isContextProvenance,
  isEvidenceReference,
  isInstructionSources,
  isProjectInstructions,
} from "../src/index.js";

const ref = {
  path: "/context/inputs/finding",
  source: "agent",
  runId: "run",
  stepId: "research",
  eventId: "event",
  sequence: 4,
  attemptId: "attempt",
  selector: "/data/findings",
};
describe("prompt source contracts", () => {
  it("keeps source identity distinct from content trust and rejects invented authority", () => {
    expect(isEvidenceReference(ref)).toBe(true);
    expect(
      isContextProvenance({
        version: 1,
        contentTrust: "untrusted",
        evidence: [ref],
        unknownPaths: [],
        omitted: 0,
      }),
    ).toBe(true);
    for (const forged of [
      { ...ref, source: "system" },
      { ...ref, trust: "trusted" },
      { ...ref, sequence: 0 },
      { ...ref, eventId: undefined },
    ])
      expect(isEvidenceReference(forged)).toBe(false);
    expect(
      isContextProvenance({
        version: 1,
        contentTrust: "trusted",
        evidence: [ref],
        unknownPaths: [],
        omitted: 0,
      }),
    ).toBe(false);
  });
  it("bounds project files and labels only the defined instruction sources", () => {
    expect(isProjectInstructions([{ source: "AGENTS.md", text: "规则" }])).toBe(true);
    expect(isProjectInstructions([{ source: "../secret", text: "rules" }])).toBe(false);
    expect(isProjectInstructions([{ source: "AGENTS.md", text: "规".repeat(11000) }])).toBe(false);
    const source = {
      kind: "project",
      reference: "input.json#/projectInstructions/0",
      text: "Rules",
    };
    expect(isInstructionSources([source])).toBe(true);
    expect(isInstructionSources([source, source])).toBe(false);
    expect(isInstructionSources([{ ...source, kind: "system" }])).toBe(false);
    expect(isInstructionSources([{ ...source, text: () => "dynamic" }])).toBe(false);
  });
});
