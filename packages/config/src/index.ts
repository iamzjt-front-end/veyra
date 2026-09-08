import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { LineCounter, parseDocument } from "yaml";

export interface AgentConfig {
  provider: string;
  model?: string;
  options: Record<string, unknown>;
}

export interface PluginConfig {
  module?: string;
  version?: string;
  options: Record<string, unknown>;
}

export interface VeyraConfig {
  version: 1;
  project?: {
    name: string;
  };
  agents: Record<string, AgentConfig>;
  plugins?: Record<string, PluginConfig>;
  workflow: {
    use: string;
  };
  runtime: {
    maxFixIterations: number;
    stateDir: string;
  };
  approval: {
    requiredFor: string[];
  };
}

export class ConfigError extends Error {
  constructor(
    readonly field: string,
    readonly detail: string,
    readonly filePath?: string,
  ) {
    super(`${filePath ?? "config"}: ${field}: ${detail}`);
    this.name = "ConfigError";
  }
}

function object(value: unknown, field: string, keys?: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new ConfigError(field, "must be an object");
  }
  if (keys) {
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) throw new ConfigError(`${field}.${key}`, "unknown field");
    }
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError(field, "must be a non-empty string");
  }
  return value;
}

function optionValue(value: unknown, field: string, parents = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null) {
    throw new ConfigError(field, "must contain only JSON-compatible values");
  }
  if (parents.has(value)) throw new ConfigError(field, "must not contain cyclic values");
  parents.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => optionValue(item, `${field}[${index}]`, parents));
    }
    return Object.fromEntries(
      Object.entries(object(value, field)).map(([key, item]) => {
        // Configuration owns this rejection rule; runtime redaction is a separate
        // boundary and must not become a config -> execution dependency.
        if (
          /(?:api[_-]?key|token|password|passwd|secret|authorization|cookie|private[_-]?key)$|^(?:env|environment)$/i.test(
            key,
          )
        )
          throw new ConfigError(
            `${field}.${key}`,
            "must not contain credentials or environment snapshots; use apiKeyEnv or native provider login",
          );
        if (
          key === "apiKeyEnv" &&
          (typeof item !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(item))
        )
          throw new ConfigError(
            `${field}.${key}`,
            "must name an environment variable of at most 128 characters, not contain a credential",
          );
        return [key, optionValue(item, `${field}.${key}`, parents)];
      }),
    );
  } finally {
    parents.delete(value);
  }
}

/** Validate data without reading files, environment variables, or providers. */
export function parseConfig(value: unknown): VeyraConfig {
  const root = object(value, "root", [
    "version",
    "project",
    "agents",
    "plugins",
    "workflow",
    "runtime",
    "approval",
  ]);
  if (root.version !== 1) throw new ConfigError("version", "expected schema version 1");

  const agents = Object.fromEntries(
    Object.entries(object(root.agents, "agents")).map(([name, value]): [string, AgentConfig] => {
      text(name, "agents key");
      const field = `agents.${name}`;
      const agent = object(value, field, ["provider", "model", "options"]);
      const result: AgentConfig = {
        provider: text(agent.provider, `${field}.provider`),
        options:
          agent.options === undefined
            ? {}
            : (optionValue(object(agent.options, `${field}.options`), `${field}.options`) as Record<
                string,
                unknown
              >),
      };
      if (agent.model !== undefined) result.model = text(agent.model, `${field}.model`);
      return [name, result];
    }),
  );

  const workflow = object(root.workflow, "workflow", ["use"]);
  const runtime =
    root.runtime === undefined
      ? {}
      : object(root.runtime, "runtime", ["maxFixIterations", "stateDir"]);
  const maxFixIterations = runtime.maxFixIterations === undefined ? 3 : runtime.maxFixIterations;
  if (
    typeof maxFixIterations !== "number" ||
    !Number.isSafeInteger(maxFixIterations) ||
    maxFixIterations < 0
  ) {
    throw new ConfigError("runtime.maxFixIterations", "must be a non-negative safe integer");
  }
  const approval =
    root.approval === undefined ? {} : object(root.approval, "approval", ["requiredFor"]);
  const requiredFor = approval.requiredFor === undefined ? [] : approval.requiredFor;
  if (!Array.isArray(requiredFor))
    throw new ConfigError("approval.requiredFor", "must be an array of strings");

  const config: VeyraConfig = {
    version: 1,
    agents,
    workflow: { use: text(workflow.use, "workflow.use") },
    runtime: {
      maxFixIterations,
      stateDir:
        runtime.stateDir === undefined ? ".veyra" : text(runtime.stateDir, "runtime.stateDir"),
    },
    approval: {
      requiredFor: requiredFor.map((item, index) => text(item, `approval.requiredFor[${index}]`)),
    },
  };
  if (root.project !== undefined) {
    const project = object(root.project, "project", ["name"]);
    config.project = { name: text(project.name, "project.name") };
  }
  if (root.plugins !== undefined) {
    const entries = Object.entries(object(root.plugins, "plugins"));
    if (entries.length > 64) throw new ConfigError("plugins", "at most 64 plugins are allowed");
    config.plugins = Object.fromEntries(
      entries.map(([name, value]) => {
        const field = `plugins.${name}`;
        if (name.length > 128 || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(name))
          throw new ConfigError(field, "expected a lowercase provider identifier");
        const raw = object(value, field, ["module", "version", "options"]);
        const plugin: PluginConfig = {
          options:
            raw.options === undefined
              ? {}
              : (optionValue(object(raw.options, `${field}.options`), `${field}.options`) as Record<
                  string,
                  unknown
                >),
        };
        if (Buffer.byteLength(JSON.stringify(plugin.options)) > 256 * 1024)
          throw new ConfigError(`${field}.options`, "must be at most 256 KiB of JSON");
        if (raw.version !== undefined) {
          plugin.version = text(raw.version, `${field}.version`);
          if (
            plugin.version.length > 128 ||
            !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
              plugin.version,
            )
          )
            throw new ConfigError(`${field}.version`, "expected an exact version, not a range");
        }
        if (raw.module !== undefined) {
          plugin.module = text(raw.module, `${field}.module`);
          if (
            (!isAbsolute(plugin.module) &&
              !plugin.module.startsWith("./") &&
              !plugin.module.startsWith("../")) ||
            ![".js", ".mjs", ".cjs"].includes(extname(plugin.module))
          )
            throw new ConfigError(
              `${field}.module`,
              "expected an explicit local .js, .mjs or .cjs file path",
            );
          if (!plugin.version)
            throw new ConfigError(
              `${field}.version`,
              "an exact version is required for local modules",
            );
        }
        return [name, plugin];
      }),
    );
  }
  return config;
}

/** Load YAML with file/field diagnostics that do not echo configuration values. */
export async function loadConfig(path: string): Promise<VeyraConfig> {
  const filePath = resolve(path);
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    throw new ConfigError("file", `cannot read configuration (${code})`, filePath);
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
    throw new ConfigError(
      "YAML",
      `invalid YAML (${issue.code}) at line ${line}, column ${col}`,
      filePath,
    );
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 100 });
  } catch {
    throw new ConfigError(
      "YAML",
      "cannot resolve YAML data; check aliases and their expansion limit",
      filePath,
    );
  }
  try {
    return parseConfig(value);
  } catch (error) {
    if (error instanceof ConfigError) throw new ConfigError(error.field, error.detail, filePath);
    throw error;
  }
}
