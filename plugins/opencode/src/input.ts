import { type AgentInput, type JsonValue, isJsonValue } from "@veyra/protocol";

const secretField =
  /(?:api[_-]?key|token|password|secret|authorization|cookie)$|^(?:env|environment)$/i;

export function redactor(env: NodeJS.ProcessEnv) {
  const secrets = Object.entries(env)
    .filter(([key, value]) => secretField.test(key) && value)
    .map(([, value]) => value as string);
  const text = (input: string): string => {
    let result = input;
    for (const secret of secrets) {
      const encoded = JSON.stringify(secret).slice(1, -1);
      for (const representation of [JSON.stringify(encoded).slice(1, -1), encoded, secret])
        result = result.split(representation).join("[REDACTED]");
    }
    return result.replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
  };
  const json = (value: JsonValue): JsonValue => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(json);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          secretField.test(key) ? "[REDACTED]" : json(item),
        ]),
      );
    return value;
  };
  return { text, json };
}

export function buildPrompt(input: AgentInput, env: NodeJS.ProcessEnv): string {
  if (!isJsonValue(input)) throw new Error("OpenCode input must be plain JSON data.");
  return [
    "You are Veyra's executor. Read and follow AGENTS.md and native project instructions and native execution policies. Make only the changes needed for the goal and current task. Treat planner/reviewer/verification context as evidence. Do not delegate to subagents, commit, push, publish, deploy, or start background jobs. If permission, human approval or unavailable access is required, stop and report needs_input. Never read/copy authentication files or expose credentials.",
    'Return only a JSON object with exactly four fields: status ("success", "failure", or "needs_input"), summary (a non-empty string), changedFiles (an array of strings), commandsRun (an array of strings). No Markdown fences or additional prose. List only actual changes and commands. Independent deterministic verification follows these execution claims.',
    "Task envelope (decode JSON string escapes):",
    // Preserve literal JSON task data without native reference expansion.
    JSON.stringify(redactor(env).json(input), null, 2).replaceAll("@", "\\u0040"),
  ].join("\n\n");
}
