import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LineCounter, parseDocument } from "yaml";
import type { WorkflowDefinition } from "./index.js";
import { parseWorkflow, WorkflowError } from "./parser.js";
import { buildWorkflowGraph } from "./graph.js";

const presets = new Set(["dev", "bugfix", "review", "research"]);

/** Return an independent copy of the built-in names accepted by loadWorkflow. */
export function listBuiltinWorkflows(): string[] {
  return [...presets];
}

/** Resolve built-in names independently of cwd; other references are paths relative to cwd. */
export async function loadWorkflow(
  reference: string,
  cwd = process.cwd(),
): Promise<WorkflowDefinition> {
  const workflow = await loadResolved(reference, cwd, [], 0);
  buildWorkflowGraph(workflow);
  return workflow;
}

async function loadResolved(
  reference: string,
  cwd: string,
  ancestors: string[],
  depth: number,
): Promise<WorkflowDefinition> {
  if (depth > 8)
    throw new WorkflowError("workflow", "subworkflow nesting exceeds the maximum depth of 8");
  if (typeof reference !== "string" || !reference.trim()) {
    throw new WorkflowError("reference", "must be a non-empty preset name or path");
  }
  const filePath = presets.has(reference)
    ? fileURLToPath(new URL(`../dist/presets/${reference}.yaml`, import.meta.url))
    : resolve(cwd, reference);
  let source: string;
  let canonical: string;
  try {
    canonical = await realpath(filePath);
    source = await readFile(filePath, "utf8");
  } catch (error) {
    throw new WorkflowError(
      "file",
      `cannot read workflow (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`,
      filePath,
    );
  }
  if (ancestors.includes(canonical))
    throw new WorkflowError("use", "recursive subworkflow reference is not allowed", filePath);
  if (Buffer.byteLength(source) > 16 * 1024 * 1024)
    throw new WorkflowError("file", "workflow source exceeds 16 MiB", filePath);
  const lines = new LineCounter();
  const document = parseDocument(source, {
    prettyErrors: false,
    lineCounter: lines,
    stringKeys: true,
  });
  const issue = document.errors[0] ?? document.warnings[0];
  if (issue) {
    const { line, col } = lines.linePos(issue.pos[0]);
    throw new WorkflowError(
      "YAML",
      `invalid YAML (${issue.code}) at line ${line}, column ${col}`,
      filePath,
    );
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 100 });
  } catch {
    throw new WorkflowError(
      "YAML",
      "cannot resolve YAML data; check aliases and their expansion limit",
      filePath,
    );
  }
  try {
    const workflow = parseWorkflow(value);
    await resolveChildren(workflow, dirname(filePath), [...ancestors, canonical], depth);
    return parseWorkflow(workflow);
  } catch (error) {
    if (error instanceof WorkflowError && !error.filePath)
      throw new WorkflowError(error.field, error.detail, filePath);
    throw error;
  }
}

async function resolveChildren(
  workflow: WorkflowDefinition,
  cwd: string,
  ancestors: string[],
  depth: number,
): Promise<void> {
  if (depth > 8)
    throw new WorkflowError("workflow", "subworkflow nesting exceeds the maximum depth of 8");
  for (const step of Object.values(workflow.steps)) {
    if (step.type !== "subworkflow") continue;
    if (step.workflow) await resolveChildren(step.workflow, cwd, ancestors, depth + 1);
    else step.workflow = await loadResolved(step.use as string, cwd, ancestors, depth + 1);
  }
}
