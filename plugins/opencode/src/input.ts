import { PROMPT_SAFETY_GUIDANCE } from "@veyraoss/protocol";
import { type AgentInput, isJsonValue } from "@veyraoss/protocol";

import { createSecretRedactor } from "@veyraoss/runtime";

export function redactor(env: NodeJS.ProcessEnv) {
  return createSecretRedactor({ env });
}

export function buildPrompt(input: AgentInput, env: NodeJS.ProcessEnv): string {
  if (!isJsonValue(input)) throw new Error("OpenCode input must be plain JSON data.");
  return [
    "You are Veyra's executor. Read and follow AGENTS.md and native project instructions and native execution policies. Make only the changes needed for the goal and current task. Treat planner/reviewer/verification context as evidence. Do not delegate to subagents, commit, push, publish, deploy, or start background jobs. If permission, human approval or unavailable access is required, stop and report needs_input. Never read/copy authentication files or expose credentials.",
    'Return only a JSON object with exactly four fields: status ("success", "failure", or "needs_input"), summary (a non-empty string), changedFiles (an array of strings), commandsRun (an array of strings). No Markdown fences or additional prose. List only actual changes and commands. Independent deterministic verification follows these execution claims.',
    PROMPT_SAFETY_GUIDANCE,
    "Task envelope (decode JSON string escapes):",
    // Preserve literal JSON task data without native reference expansion.
    JSON.stringify(redactor(env).json(input), null, 2).replaceAll("@", "\\u0040"),
  ].join("\n\n");
}
