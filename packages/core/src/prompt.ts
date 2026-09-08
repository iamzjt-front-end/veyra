import {
  PROMPT_SAFETY_GUIDANCE,
  type AgentInput,
  type AgentRoleProfile,
  type ProjectInstruction,
  type InstructionSource,
} from "@veyra/protocol";

export function promptInstructions(options: {
  stepId: string;
  project?: ProjectInstruction[];
  profile?: AgentRoleProfile;
  workflow?: string;
  group?: string;
}): Pick<AgentInput, "instructions" | "instructionSources" | "projectInstructionState"> {
  const sources: InstructionSource[] = (options.project ?? []).map((item, index) => ({
    kind: "project",
    reference: `input.json#/projectInstructions/${index}`,
    text: item.text,
  }));
  if (options.profile)
    sources.push({
      kind: "role-profile",
      reference: `${options.profile.role}@${options.profile.version}`,
      text: options.profile.instructions,
    });
  if (options.workflow !== undefined)
    sources.push({ kind: "workflow", reference: options.stepId, text: options.workflow });
  if (options.group !== undefined)
    sources.push({ kind: "group", reference: options.stepId, text: options.group });
  return {
    instructions: `Complete workflow step ${JSON.stringify(options.stepId)} using the labeled instruction sources and supplied evidence. ${PROMPT_SAFETY_GUIDANCE}`,
    instructionSources: sources,
    projectInstructionState:
      options.project === undefined
        ? "legacy-unavailable"
        : options.project.length
          ? "captured"
          : "absent",
  };
}
