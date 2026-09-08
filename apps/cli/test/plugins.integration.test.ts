import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "@veyraoss/config";
import { ProcessExecutionError, runProcess, type ProcessRunner } from "@veyraoss/runtime";
import { describe, expect, it, vi } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { runCli, type CliServices } from "../src/application.js";
import { registryForProviders } from "../src/plugins.js";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const tsx = createRequire(import.meta.url).resolve("tsx");
const moduleSource = `import { writeFileSync } from "node:fs";
writeFileSync(new URL("./imported", import.meta.url), "imported");
export default {
  apiVersion: 1, provider: "fixture-plugin", version: "1.2.3",
  createAgent: (config, context) => ({
    id: config.id, provider: "fixture-plugin",
    describe: () => ({ schemaVersion: 1, id: config.id, provider: "fixture-plugin", adapterVersion: "1.2.3", roles: ["planner"], capabilities: ["reasoning"] }),
    run: async (input) => ({ status: "success", summary: context.options.prefix + ":" + config.options.suffix + ":" + input.role })
  }),
  checkReadiness: async (config, context) => {
    writeFileSync(new URL("./probed", import.meta.url), config.id);
    return { status: "ready", scope: "local", message: context.options.message ?? "Fixture readiness checked" };
  }
};`;
async function fixture(path: string) {
  await writeFile(join(path, "plugin.mjs"), moduleSource);
  const config = {
    version: 1,
    agents: { analysis: { provider: "fixture-plugin", options: { suffix: "agent" } } },
    plugins: {
      "fixture-plugin": {
        module: "./plugin.mjs",
        version: "1.2.3",
        options: { prefix: "namespace" },
      },
    },
    workflow: { use: "workflow.yaml" },
  };
  await writeFile(join(path, "veyra.yaml"), JSON.stringify(config));
  await writeFile(
    join(path, "workflow.yaml"),
    JSON.stringify({
      name: "Third-party plugin",
      version: 1,
      start: "work",
      steps: {
        work: {
          type: "agent",
          agent: "analysis",
          requires: { role: "planner", capabilities: ["reasoning"] },
          next: "gate",
        },
        gate: { type: "human", message: "Inspect the plan", next: "again" },
        again: { type: "agent", agent: "analysis", requires: { role: "planner" } },
      },
    }),
  );
  return config;
}
const invoke = async (path: string, args: string[], services: CliServices = {}) => {
  let stdout = "";
  let stderr = "";
  const code = await runCli([...args, "--json"], {
    cwd: path,
    env: {},
    ...services,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return {
    code,
    stdout,
    stderr,
    records: stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
};

describe("CLI plugin composition", () => {
  it("uses the same configured OpenAI credential source for readiness and execution", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        id: "fixture-response",
        object: "response",
        status: "completed",
        error: null,
        usage: null,
        output: [
          {
            id: "message",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  summary: "Plan",
                  instructions: "Check the fixture",
                  acceptanceCriteria: ["Tests pass"],
                  artifactIds: [],
                }),
                annotations: [],
              },
            ],
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetch);
    try {
      const config = parseConfig({
        version: 1,
        workflow: { use: "dev" },
        agents: {
          planner: {
            provider: "openai",
            model: "fixture",
            options: { apiKeyEnv: "AGENT_CREDENTIAL" },
          },
        },
        plugins: { openai: { options: { apiKeyEnv: "NAMESPACE_CREDENTIAL" } } },
      });
      const registry = await registryForProviders(config, ["openai"], process.cwd(), [], {
        env: {
          AGENT_CREDENTIAL: "fixture-selected-key",
          NAMESPACE_CREDENTIAL: "fixture-namespace-key",
          OPENAI_API_KEY: "fixture-default-key",
        },
      });
      const request = {
        id: "planner",
        model: "fixture",
        options: { apiKeyEnv: "AGENT_CREDENTIAL" },
      };
      expect((await registry.checkReadiness("openai", request)).status).toBe("ready");
      expect(fetch).not.toHaveBeenCalled();
      expect(
        (
          await registry
            .createAgent("openai", request)
            .run({ runId: "run", stepId: "plan", role: "planner", goal: "Plan" })
        ).status,
      ).toBe("success");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
        "Bearer fixture-selected-key",
      );
      expect(JSON.stringify(fetch.mock.calls)).not.toContain("fixture-namespace-key");
      expect(JSON.stringify(fetch.mock.calls)).not.toContain("fixture-default-key");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("reports an unconfigured compatible endpoint without choosing an implicit server", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const result = await invoke(path, ["doctor"], {
        runProcess: async () => {
          throw new ProcessExecutionError("executable_not_found", "private");
        },
      });
      expect(
        result.records[0].providers.find(
          (provider: { provider: string }) => provider.provider === "openai-compatible",
        ),
      ).toMatchObject({
        ready: false,
        scope: "configuration",
        message: expect.stringContaining("options.baseURL"),
      });
    });
  });
  it("validates, discovers, runs and resumes a compatible binding through a loopback server", async () => {
    const requests: { authorization?: string; body: string; path?: string }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests.push({ authorization: req.headers.authorization, body, path: req.url });
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    summary: "Plan",
                    instructions: "Run the fixture tests",
                    acceptanceCriteria: ["Tests pass"],
                    artifactIds: [],
                  }),
                },
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture address");
      const baseURL = `http://127.0.0.1:${address.port}/v1`;
      await withFixtureWorkspace(async ({ path }) => {
        await fixture(path);
        await writeFile(
          join(path, "veyra.yaml"),
          JSON.stringify({
            version: 1,
            workflow: { use: "workflow.yaml" },
            agents: {
              analysis: {
                provider: "openai-compatible",
                model: "fixture-local-model",
                options: { role: "planner" },
              },
            },
            plugins: {
              "openai-compatible": {
                options: { baseURL, responseFormat: "json_schema", apiKeyEnv: "LOCAL_KEY" },
              },
            },
          }),
        );
        expect(
          (await invoke(path, ["workflow", "validate", "workflow.yaml", "--config", "veyra.yaml"]))
            .code,
        ).toBe(0);
        const services: CliServices = {
          env: { LOCAL_KEY: "fixture-compatible-key", OPENAI_API_KEY: "wrong-key" },
          runProcess: async () => ({
            exitCode: 0,
            signal: null,
            stdout: "10.15.1",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            durationMs: 1,
          }),
        };
        const doctor = await invoke(path, ["doctor"], services);
        expect(doctor.code, doctor.stdout).toBe(0);
        expect(doctor.records[0].providers[0]).toMatchObject({
          provider: "openai-compatible",
          ready: true,
          scope: "configuration",
          descriptor: {
            model: "fixture-local-model",
            roles: ["planner"],
            capabilities: ["reasoning", "structured-output"],
          },
        });
        expect(requests).toHaveLength(0);
        const run = await invoke(path, ["run", "Plan this task"], services);
        expect(run.code, run.stdout).toBe(3);
        const resumed = await invoke(path, ["resume", "--approve"], services);
        expect(resumed.code, resumed.stdout).toBe(0);
        expect(`${doctor.stdout}${run.stdout}${resumed.stdout}`).not.toContain(
          "fixture-compatible-key",
        );
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request).toMatchObject({
        path: "/v1/chat/completions",
        authorization: "Bearer fixture-compatible-key",
      });
      expect(JSON.parse(request.body)).toMatchObject({
        model: "fixture-local-model",
        response_format: { type: "json_schema" },
      });
      expect(request.body).not.toContain("wrong-key");
    }
  });
  it("reports an absent OpenCode executable without requiring an unconfigured model", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const result = await invoke(path, ["doctor"], {
        runProcess: async () => {
          throw new ProcessExecutionError("executable_not_found", "private detail");
        },
      });
      expect(
        result.records[0].providers.find(
          (provider: { provider: string }) => provider.provider === "opencode",
        ),
      ).toMatchObject({
        ready: false,
        scope: "local",
        message: "OpenCode executable was not found; install it or configure its executable path.",
      });
    });
  });
  it("discovers Gemini bindings with opt-in vision and credential-presence readiness", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await fixture(path);
      await writeFile(
        join(path, "veyra.yaml"),
        JSON.stringify({
          version: 1,
          workflow: { use: "workflow.yaml" },
          agents: {
            analysis: {
              provider: "gemini",
              model: "gemini-2.5-flash",
              options: { role: "planner", vision: true },
            },
          },
        }),
      );
      expect(
        (await invoke(path, ["workflow", "validate", "workflow.yaml", "--config", "veyra.yaml"]))
          .code,
      ).toBe(0);
      const runner: ProcessRunner = async () => ({
        exitCode: 0,
        signal: null,
        stdout: "10.15.1",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 1,
      });
      expect((await invoke(path, ["doctor"], { runProcess: runner })).code).toBe(1);
      const ready = await invoke(path, ["doctor"], {
        runProcess: runner,
        env: { GEMINI_API_KEY: "fixture-google-key" },
      });
      expect(ready.code, ready.stdout).toBe(0);
      expect(ready.records[0].providers[0]).toMatchObject({
        provider: "gemini",
        ready: true,
        scope: "configuration",
        descriptor: {
          roles: ["planner"],
          capabilities: ["reasoning", "structured-output", "vision"],
        },
      });
      expect(ready.stdout).not.toContain("fixture-google-key");
      const run = await invoke(path, ["run", "Plan a change"]);
      expect(run.code).toBe(1);
      expect(run.stdout).toContain("gemini_missing_api_key");
    });
  });
  it.each(["claude-code", "gemini-cli", "opencode"])(
    "validates, discovers and executes %s through injected runtime",
    async (provider) => {
      await withFixtureWorkspace(async ({ path }) => {
        await writeFile(
          join(path, "veyra.yaml"),
          JSON.stringify({
            version: 1,
            workflow: { use: "workflow.yaml" },
            agents: { coding: { provider } },
          }),
        );
        await writeFile(
          join(path, "workflow.yaml"),
          JSON.stringify({
            name: "Native CLI executor fixture",
            version: 1,
            start: "execute",
            steps: {
              execute: {
                type: "agent",
                agent: "coding",
                requires: { role: "executor", capabilities: ["local-cli", "structured-output"] },
              },
            },
          }),
        );
        const calls: string[][] = [];
        const runner: ProcessRunner = async (request) => {
          calls.push([request.executable, ...(request.args ?? [])]);
          const stdout =
            request.executable === "pnpm" || request.executable.endsWith("cmd.exe")
              ? "10.15.1"
              : request.args?.[0] === "--version"
                ? provider === "claude-code"
                  ? "2.1.159 (Claude Code)"
                  : provider === "opencode"
                    ? "1.18.29"
                    : "0.58.0"
                : request.args?.includes("--help")
                  ? "--print --output-format --json-schema --no-session-persistence --permission-mode --prompt --approval-mode --format --dir --title --auto --thinking"
                  : request.args?.[0] === "auth"
                    ? '{"loggedIn":true}'
                    : provider === "opencode"
                      ? [
                          { type: "step_start", part: { type: "step-start", id: "start" } },
                          {
                            type: "text",
                            part: {
                              type: "text",
                              id: "text",
                              time: { end: 2 },
                              text: JSON.stringify({
                                status: "success",
                                summary: "Fixture executor completed",
                                changedFiles: [],
                                commandsRun: [],
                              }),
                            },
                          },
                          {
                            type: "step_finish",
                            part: { type: "step-finish", id: "finish", reason: "stop" },
                          },
                        ]
                          .map((event) =>
                            JSON.stringify({
                              ...event,
                              sessionID: "fixture",
                              part: { ...event.part, sessionID: "fixture", messageID: "message" },
                            }),
                          )
                          .join("\n")
                      : provider === "gemini-cli"
                        ? JSON.stringify({
                            response: JSON.stringify({
                              status: "success",
                              summary: "Fixture executor completed",
                              changedFiles: [],
                              commandsRun: [],
                            }),
                          })
                        : JSON.stringify({
                            type: "result",
                            subtype: "success",
                            is_error: false,
                            structured_output: {
                              status: "success",
                              summary: "Fixture executor completed",
                              changedFiles: [],
                              commandsRun: [],
                            },
                          });
          return {
            exitCode: 0,
            signal: null,
            stdout,
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            durationMs: 1,
          };
        };
        expect(
          (
            await invoke(
              path,
              ["workflow", "validate", "workflow.yaml", "--config", "veyra.yaml"],
              {
                runProcess: runner,
              },
            )
          ).code,
        ).toBe(0);
        expect(calls).toEqual([]);
        const doctor = await invoke(path, ["doctor"], {
          runProcess: runner,
          env: { GEMINI_API_KEY: "fixture-key" },
        });
        expect(doctor.code, doctor.stdout).toBe(0);
        expect(doctor.records[0].providers[0]).toMatchObject({
          provider,
          ready: true,
          scope: provider === "gemini-cli" ? "configuration" : "local",
          descriptor: { roles: ["executor"] },
        });
        const run = await invoke(path, ["run", "Repair fixture"], { runProcess: runner });
        expect(run.code, run.stdout).toBe(0);
        expect(run.stdout).toContain("Fixture executor completed");
        expect(
          calls.filter(
            (call) =>
              call[1] ===
                (provider === "claude-code"
                  ? "--print"
                  : provider === "opencode"
                    ? "run"
                    : "--prompt") && !call.includes("--help"),
          ),
        ).toHaveLength(1);
        const state = await invoke(path, ["status"]);
        expect(state.stdout).toContain("completed");
      });
    },
  );
  it("discovers the Claude built-in and checks only credential presence through doctor", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await fixture(path);
      await writeFile(
        join(path, "veyra.yaml"),
        JSON.stringify({
          version: 1,
          workflow: { use: "workflow.yaml" },
          agents: {
            analysis: { provider: "claude", model: "fixture-model", options: { role: "planner" } },
          },
        }),
      );
      const validation = await invoke(path, [
        "workflow",
        "validate",
        "workflow.yaml",
        "--config",
        "veyra.yaml",
      ]);
      expect(validation.code, validation.stdout).toBe(0);
      const runner: ProcessRunner = async () => ({
        exitCode: 0,
        signal: null,
        stdout: "10.15.1",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 0,
      });
      const missing = await invoke(path, ["doctor"], { runProcess: runner });
      expect(missing.code).toBe(1);
      expect(missing.stdout).toContain("ANTHROPIC_API_KEY");
      const ready = await invoke(path, ["doctor"], {
        runProcess: runner,
        env: { ANTHROPIC_API_KEY: "fixture-anthropic-key" },
      });
      expect(ready.code, ready.stdout).toBe(0);
      expect(ready.records[0].providers[0]).toMatchObject({
        provider: "claude",
        ready: true,
        scope: "configuration",
        descriptor: { roles: ["planner"], capabilities: ["reasoning", "structured-output"] },
      });
      expect(ready.stdout).not.toContain("fixture-anthropic-key");
      const run = await invoke(path, ["run", "Plan"]);
      expect(run.code).toBe(1);
      expect(run.stdout).toContain("claude_missing_api_key");
    });
  });
  it("preserves a plugin setup diagnosis when its adapter cannot yet be constructed", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await fixture(path);
      await writeFile(
        join(path, "plugin.mjs"),
        `export default {
        apiVersion: 1, provider: "fixture-plugin", version: "1.2.3",
        createAgent: () => { throw new Error("private setup error"); },
        checkReadiness: async () => ({ status: "unavailable", scope: "local", message: "Install the provider's local runtime first." })
      };`,
      );
      const runner: ProcessRunner = async () => ({
        exitCode: 0,
        signal: null,
        stdout: "10.15.1",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 0,
      });
      const result = await invoke(path, ["doctor", "--allow-plugin", "fixture-plugin"], {
        runProcess: runner,
      });
      expect(result.code).toBe(1);
      expect(result.records[0].providers[0]).toMatchObject({
        ready: false,
        message: "Install the provider's local runtime first.",
      });
      expect(result.stdout).not.toContain("private setup error");
    });
  });
  it("keeps workflow validation and inspection free of module imports and requires exact trust for run", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await fixture(path);
      const validation = await invoke(path, [
        "workflow",
        "validate",
        "workflow.yaml",
        "--config",
        "veyra.yaml",
      ]);
      expect(validation.code, validation.stdout).toBe(0);
      expect(validation.records[0].valid).toBe(true);
      expect((await invoke(path, ["status"])).records[0].code).toBe("no_run");
      expect((await invoke(path, ["run", "Plan"])).records[0].code).toBe("plugin_not_trusted");
      expect((await invoke(path, ["run", "Plan", "--allow-plugin", "other"])).records[0].code).toBe(
        "plugin_not_trusted",
      );
      await expect(readFile(join(path, "imported"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(path, ".veyra/state/active.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const run = await invoke(path, ["run", "Plan", "--allow-plugin", "fixture-plugin"]);
      expect(run.code, run.stdout).toBe(3);
      expect(run.records).toContainEqual(
        expect.objectContaining({
          type: "agent.completed",
          result: expect.objectContaining({ summary: "namespace:agent:planner" }),
        }),
      );
      await expect(readFile(join(path, "probed"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
  it("runs opted-in plugin doctor hooks and redacts namespace credential variables", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const config = await fixture(path);
      config.plugins["fixture-plugin"].options = {
        ...config.plugins["fixture-plugin"].options,
        ...{ apiKeyEnv: "ODD_CREDENTIAL", message: "fixture-plugin-secret" },
      };
      await writeFile(join(path, "veyra.yaml"), JSON.stringify(config));
      const runner: ProcessRunner = async () => ({
        exitCode: 0,
        signal: null,
        stdout: "10.15.1",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 0,
      });
      const denied = await invoke(path, ["doctor"], { runProcess: runner });
      expect(denied.code).toBe(1);
      expect(denied.stdout).toContain("--allow-plugin fixture-plugin");
      await expect(readFile(join(path, "imported"))).rejects.toMatchObject({ code: "ENOENT" });
      const allowed = await invoke(path, ["doctor", "--allow-plugin", "fixture-plugin"], {
        runProcess: runner,
        env: { ODD_CREDENTIAL: "fixture-plugin-secret" },
      });
      expect(allowed.code, allowed.stdout).toBe(0);
      expect(allowed.records[0].providers[0]).toMatchObject({
        ready: true,
        scope: "local",
        descriptor: { provider: "fixture-plugin", adapterVersion: "1.2.3" },
        message: "[REDACTED]",
      });
      expect(allowed.stdout).not.toContain("fixture-plugin-secret");
      expect(await readFile(join(path, "probed"), "utf8")).toBe("analysis");
    });
  });
  it("applies built-in namespace defaults with per-agent options taking precedence", async () => {
    const config = parseConfig({
      version: 1,
      agents: {},
      workflow: { use: "dev" },
      plugins: {
        openai: { version: "0.1.0", options: { model: "default-model", role: "reviewer" } },
      },
    });
    const registry = await registryForProviders(config, ["openai"], process.cwd());
    expect(
      registry.createAgent("openai", { id: "analysis", options: {} }).describe?.(),
    ).toMatchObject({ model: "default-model", roles: ["reviewer"] });
    expect(
      registry
        .createAgent("openai", {
          id: "analysis",
          model: "chosen-model",
          options: { role: "planner" },
        })
        .describe?.(),
    ).toMatchObject({ model: "chosen-model", roles: ["planner"] });
  });
  it("rejects builtin replacement and incompatible versions before creating a run", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const config = await fixture(path);
      config.agents.analysis.provider = "openai";
      const replacement = {
        ...config,
        plugins: { openai: { module: "./plugin.mjs", version: "1.2.3" } },
      };
      await writeFile(join(path, "veyra.yaml"), JSON.stringify(replacement));
      expect(
        (await invoke(path, ["run", "Plan", "--allow-plugin", "openai"])).records[0].code,
      ).toBe("duplicate_plugin");
      await expect(readFile(join(path, "imported"))).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(
        join(path, "veyra.yaml"),
        JSON.stringify({ ...config, plugins: { openai: { version: "0.2.0" } } }),
      );
      expect((await invoke(path, ["run", "Plan"])).records[0].code).toBe("plugin_version_mismatch");
    });
  });
  it("does not import unused plugins and checks all required trust before any import", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const config = await fixture(path);
      const parsed = parseConfig(config);
      expect((await registryForProviders(parsed, [], path)).list()).toEqual([]);
      parsed.plugins = {
        ...parsed.plugins,
        second: { module: "./second.mjs", version: "1.0.0", options: {} },
      };
      await expect(
        registryForProviders(parsed, ["fixture-plugin", "second"], path, ["fixture-plugin"]),
      ).rejects.toMatchObject({ code: "plugin_not_trusted" });
      await expect(readFile(join(path, "imported"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
  it(
    "loads a real third-party module and resumes across fresh CLI processes with explicit trust each time",
    { timeout: 60_000 },
    async () => {
      await withFixtureWorkspace(async ({ path }) => {
        await fixture(path);
        const ve = (args: string[]) =>
          runProcess({
            executable: process.execPath,
            args: ["--import", tsx, entry, ...args, "--config", join(path, "veyra.yaml"), "--json"],
            cwd: path,
            timeoutMs: 30_000,
          });
        const first = await ve(["run", "Plan", "--allow-plugin", "fixture-plugin"]);
        expect(first.exitCode, first.stdout + first.stderr).toBe(3);
        expect((await ve(["status"])).exitCode).toBe(0);
        const refused = await ve(["resume"]);
        expect(refused.exitCode, refused.stdout).toBe(2);
        expect(refused.stdout).toContain("plugin_not_trusted");
        const resumed = await ve(["resume", "--approve", "--allow-plugin", "fixture-plugin"]);
        expect(resumed.exitCode, resumed.stdout + resumed.stderr).toBe(0);
        expect(resumed.stdout).toContain('"summary":"namespace:agent:planner"');
        expect((await ve(["status"])).stdout).toContain('"status":"completed"');
      });
    },
  );
});
