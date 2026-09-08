import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { ConfigError, loadConfig, parseConfig } from "../src/index.js";

const minimal = () => ({
  version: 1,
  agents: { planner: { provider: "fake" } },
  workflow: { use: "dev" },
});

describe("parseConfig", () => {
  it.each(["credentials", "AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID"])(
    "rejects credential-shaped option %s without echoing its value",
    (name) => {
      const value = {
        ...minimal(),
        agents: {
          planner: { provider: "fixture", options: { [name]: "fixture-private-material" } },
        },
      };
      expect(() => parseConfig(value)).toThrow(/must not contain credentials/);
      try {
        parseConfig(value);
      } catch (error) {
        expect(String(error)).not.toContain("fixture-private-material");
      }
    },
  );

  it("validates a minimal config and applies independent defaults", () => {
    const config = parseConfig(minimal());
    expect(config).toEqual({
      version: 1,
      agents: { planner: { provider: "fake", options: {} } },
      workflow: { use: "dev" },
      runtime: { maxFixIterations: 3, stateDir: ".veyra" },
      approval: { requiredFor: [] },
    });
    config.approval.requiredFor.push("changed");
    assert(config.agents.planner);
    config.agents.planner.options.changed = true;
    expect(parseConfig(minimal()).approval.requiredFor).toEqual([]);
    expect(parseConfig(minimal()).agents.planner?.options).toEqual({});
  });

  it("supports a full provider-neutral config without mutating its input", () => {
    const value = {
      ...minimal(),
      project: { name: "fixture" },
      agents: {
        planner: {
          provider: "local",
          model: "model-name",
          options: {
            temperature: 0,
            flags: [true, null],
            nested: { endpoint: "http://localhost" },
          },
        },
        executor: { provider: "fake" },
        reviewer: { provider: "another-provider" },
      },
      runtime: { maxFixIterations: 0, stateDir: "./custom-state" },
      approval: { requiredFor: ["architecture_change"] },
    };
    const before = structuredClone(value);
    const config = parseConfig(value);
    expect(config.project?.name).toBe("fixture");
    expect(config.runtime).toEqual(value.runtime);
    expect(config.agents.planner).toEqual(value.agents.planner);
    expect(config.approval).toEqual(value.approval);
    assert(config.agents.planner);
    config.agents.planner.options.nested = null;
    config.approval.requiredFor.push("changed");
    expect(value).toEqual(before);
  });

  it("allows empty agents for command-only workflows", () => {
    expect(parseConfig({ ...minimal(), agents: {} }).agents).toEqual({});
  });

  it.each([
    [undefined, "root"],
    [null, "root"],
    [[], "root"],
    [{ ...minimal(), version: undefined }, "version"],
    [{ ...minimal(), version: 2 }, "version"],
    [{ ...minimal(), version: "1" }, "version"],
    [{ ...minimal(), agents: undefined }, "agents"],
    [{ ...minimal(), workflow: undefined }, "workflow"],
    [{ ...minimal(), unexpected: true }, "root.unexpected"],
    [{ ...minimal(), project: {} }, "project.name"],
    [{ ...minimal(), project: { name: 12 } }, "project.name"],
    [{ ...minimal(), workflow: { use: " " } }, "workflow.use"],
    [{ ...minimal(), workflow: { use: "dev", path: "x" } }, "workflow.path"],
    [{ ...minimal(), agents: [] }, "agents"],
    [{ ...minimal(), agents: { planner: {} } }, "agents.planner.provider"],
    [{ ...minimal(), agents: { planner: { provider: 12 } } }, "agents.planner.provider"],
    [
      { ...minimal(), agents: { planner: { provider: "fake", model: "" } } },
      "agents.planner.model",
    ],
    [
      { ...minimal(), agents: { planner: { provider: "fake", options: [] } } },
      "agents.planner.options",
    ],
    [
      { ...minimal(), agents: { planner: { provider: "fake", apiKey: "not-a-real-secret" } } },
      "agents.planner.apiKey",
    ],
    [{ ...minimal(), runtime: null }, "runtime"],
    [{ ...minimal(), runtime: { maxFixIterations: null } }, "runtime.maxFixIterations"],
    [{ ...minimal(), runtime: { maxFixIterations: -1 } }, "runtime.maxFixIterations"],
    [{ ...minimal(), runtime: { maxFixIterations: 1.5 } }, "runtime.maxFixIterations"],
    [{ ...minimal(), runtime: { maxFixIterations: "3" } }, "runtime.maxFixIterations"],
    [
      { ...minimal(), runtime: { maxFixIterations: Number.POSITIVE_INFINITY } },
      "runtime.maxFixIterations",
    ],
    [{ ...minimal(), runtime: { stateDir: null } }, "runtime.stateDir"],
    [{ ...minimal(), runtime: { retry: 2 } }, "runtime.retry"],
    [{ ...minimal(), approval: { requiredFor: "deploy" } }, "approval.requiredFor"],
    [{ ...minimal(), approval: { requiredFor: [12] } }, "approval.requiredFor[0]"],
    [{ ...minimal(), approval: { required: true } }, "approval.required"],
  ])("rejects invalid input %# at its field", (value, field) => {
    expect(() => parseConfig(value)).toThrow(ConfigError);
    expect(() => parseConfig(value)).toThrow(String(field));
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, undefined, () => true, 1n, new Date()])(
    "rejects non-JSON provider option %#",
    (value) => {
      expect(() =>
        parseConfig({
          ...minimal(),
          agents: { planner: { provider: "fake", options: { invalid: value } } },
        }),
      ).toThrow("agents.planner.options.invalid");
    },
  );

  it("rejects cyclic options", () => {
    const options: Record<string, unknown> = {};
    options.self = options;
    expect(() =>
      parseConfig({ ...minimal(), agents: { planner: { provider: "fake", options } } }),
    ).toThrow("cyclic");
  });
});

describe("loadConfig", () => {
  it("loads the complete repository example", async () => {
    const path = fileURLToPath(new URL("../../../veyra.example.yaml", import.meta.url));
    const config = await loadConfig(path);
    expect(config.version).toBe(1);
    expect(config.project?.name).toBe("example-project");
    expect(Object.keys(config.agents)).toEqual(["planner", "executor", "reviewer"]);
    expect(config.approval.requiredFor).toEqual(["architecture_change", "production_deploy"]);
  });

  it("loads a fixture veyra.yaml without writing or changing it", async () => {
    await withFixtureWorkspace(async (workspace) => {
      const path = join(workspace.path, "veyra.yaml");
      const source = "version: 1\nagents: {}\nworkflow:\n  use: dev\n";
      await writeFile(path, source);
      expect((await loadConfig(path)).runtime.maxFixIterations).toBe(3);
      expect(await readFile(path, "utf8")).toBe(source);
    });
  });

  it.each([
    "version: [not-a-real-secret",
    "version: 1\nversion: 1\n",
    "version: !unsupported not-a-real-secret\n",
    "version: 1\n---\nversion: 1\n",
  ])("reports malformed or unsupported YAML %# without echoing values", async (source) => {
    await withFixtureWorkspace(async (workspace) => {
      const path = join(workspace.path, "veyra.yaml");
      await writeFile(path, source);
      const failure = await loadConfig(path).then(
        () => null,
        (error: unknown) => error,
      );
      assert(failure instanceof ConfigError);
      expect(failure.message).toContain(path);
      expect(failure.message).toContain("YAML");
      expect(failure.message).toContain("line");
      expect(failure.message).not.toContain("not-a-real-secret");
    });
  });

  it("reports both the file path and invalid field", async () => {
    await withFixtureWorkspace(async (workspace) => {
      const path = join(workspace.path, "veyra.yaml");
      await writeFile(path, "version: 1\nagents:\n  planner: {}\nworkflow:\n  use: dev\n");
      await expect(loadConfig(path)).rejects.toMatchObject({
        filePath: path,
        field: "agents.planner.provider",
      });
    });
  });

  it("reports missing config files with an actionable error", async () => {
    await withFixtureWorkspace(async (workspace) => {
      const path = join(workspace.path, "missing.yaml");
      await expect(loadConfig(path)).rejects.toMatchObject({ filePath: path, field: "file" });
      await expect(loadConfig(path)).rejects.toThrow("ENOENT");
    });
  });
});
