import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LineCounter, parseDocument } from "yaml";
import type { WorkflowDefinition } from "./index.js";
import { parseWorkflow, WorkflowError } from "./parser.js";

const presets = new Set(["dev", "bugfix", "review", "research"]);

/** Resolve built-in names independently of cwd; other references are paths relative to cwd. */
export async function loadWorkflow(
  reference: string,
  cwd = process.cwd(),
): Promise<WorkflowDefinition> {
  if (typeof reference !== "string" || !reference.trim()) {
    throw new WorkflowError("reference", "must be a non-empty preset name or path");
  }
  const filePath = presets.has(reference)
    ? fileURLToPath(new URL(`../../../workflows/${reference}.yaml`, import.meta.url))
    : resolve(cwd, reference);
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    throw new WorkflowError(
      "file",
      `cannot read workflow (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`,
      filePath,
    );
  }
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
    return parseWorkflow(value);
  } catch (error) {
    if (error instanceof WorkflowError)
      throw new WorkflowError(error.field, error.detail, filePath);
    throw error;
  }
}
