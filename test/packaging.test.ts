import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runProcess } from "../packages/runtime/src/process.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const candidates = [
  "packages/protocol",
  "packages/config",
  "packages/runtime",
  "packages/project",
  "packages/daemon",
  "packages/workflow",
  "packages/verifier",
  "packages/sdk",
  "packages/core",
  "plugins/openai",
  "plugins/codex",
  "plugins/claude",
  "plugins/claude-code",
  "plugins/gemini",
  "plugins/opencode",
  "apps/cli",
];

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  publishConfig?: { access: string; registry: string };
  license: string;
  type: string;
  types?: string;
  exports?: Record<string, unknown>;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
}

async function command(executable: string, args: string[], cwd: string) {
  const result = await runProcess({
    executable,
    args,
    cwd,
    timeoutMs: 30_000,
    env: { NODE_PATH: undefined, NODE_OPTIONS: undefined },
  });
  expect(result.exitCode, `${executable}: ${result.stdout}\n${result.stderr}`).toBe(0);
  return result.stdout;
}

it("packs only runtime assets and resolves exports, types, presets and ve outside the checkout", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "veyra-packed-"));
  try {
    const consumer = join(temporary, "consumer with spaces");
    await mkdir(consumer);
    await writeFile(join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
    const license = await readFile(join(root, "LICENSE"), "utf8");
    const names: string[] = [];
    const manifests: Manifest[] = [];
    const external = new Set<string>();
    for (const directory of candidates) {
      const source = join(root, directory);
      const packed = JSON.parse(
        await command("pnpm", ["pack", "--json", "--pack-destination", temporary], source),
      ) as { filename: string; files: { path: string }[] };
      for (const { path } of packed.files) {
        expect(
          /^(package\.json|README\.md|CHANGELOG\.md|LICENSE|dist\/[\w/-]+\.(js|js\.map|d\.ts)|dist\/presets\/(dev|bugfix|review|research)\.yaml|schema\/workflow-v1\.schema\.json)$/.test(
            path,
          ) ||
            (directory === "apps/cli" &&
              /^dist\/browser-extension\/(manifest\.json|popup\.html|popup\.css|sidepanel\.html|sidepanel\.css|diagnostics\.html|diagnostics\.css)$/.test(
                path,
              )),
          `${directory} packs unexpected file: ${path}`,
        ).toBe(true);
      }
      const staging = join(temporary, directory);
      await mkdir(staging, { recursive: true });
      await command(
        "tar",
        ["-xzf", packed.filename, "-C", staging, "--strip-components", "1"],
        root,
      );
      const manifest = JSON.parse(
        await readFile(join(staging, "package.json"), "utf8"),
      ) as Manifest;
      expect(manifest.name).toBe(`@veyraoss/${directory.split("/")[1]}`);
      expect(manifest.private).toBeUndefined();
      expect(manifest.publishConfig).toEqual({
        access: "public",
        registry: "https://registry.npmjs.org",
      });
      expect(manifest.license).toBe("MIT");
      expect(manifest.type).toBe("module");
      expect(await readFile(join(staging, "LICENSE"), "utf8")).toBe(license);
      expect(await readFile(join(staging, "README.md"), "utf8")).not.toBe("");
      if (manifest.name === "@veyraoss/cli") {
        expect(manifest.bin).toEqual({ ve: "./dist/index.js" });
        const browser = JSON.parse(
          await readFile(join(staging, "dist/browser-extension/manifest.json"), "utf8"),
        );
        expect(browser.manifest_version).toBe(3);
        expect(browser.permissions).toContain("nativeMessaging");
        for (const asset of ["background.js", "content.js", "popup.js", "popup.html", "popup.css"])
          expect(await readFile(join(staging, "dist/browser-extension", asset), "utf8")).not.toBe(
            "",
          );
        expect(await readFile(join(staging, "dist/native-host.js"), "utf8")).toContain(
          "serveNative",
        );
        expect(await readFile(join(staging, "dist/index.js"), "utf8")).toMatch(
          /^#!\/usr\/bin\/env node\n/,
        );
      } else {
        expect(manifest.bin).toBeUndefined();
        expect(manifest.types).toBe("./dist/index.d.ts");
        expect(manifest.exports?.["."]).toEqual({
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
        });
      }
      const installed = join(consumer, "node_modules", manifest.name);
      await mkdir(dirname(installed), { recursive: true });
      // Only extracted tarballs supply @veyraoss modules. Third-party dependencies reuse the frozen install.
      await symlink(staging, installed, "dir");
      // Resolve peers of each tarball through this isolated dependency tree.
      await symlink(join(consumer, "node_modules"), join(staging, "node_modules"), "dir");
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        if (dependency.startsWith("@veyraoss/") || external.has(dependency)) continue;
        const link = join(consumer, "node_modules", dependency);
        await mkdir(dirname(link), { recursive: true });
        await symlink(join(source, "node_modules", dependency), link, "dir");
        external.add(dependency);
      }
      names.push(manifest.name);
      manifests.push(manifest);
    }
    for (const manifest of manifests)
      for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
        expect(version).not.toMatch(/^(workspace:|link:|file:)/);
        if (dependency.startsWith("@veyraoss/"))
          expect(version).toBe(manifests.find((entry) => entry.name === dependency)?.version);
      }
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8")).private).toBe(true);
    expect(JSON.parse(await readFile(join(root, "apps/tui/package.json"), "utf8")).private).toBe(
      true,
    );

    await writeFile(
      join(consumer, "check.mjs"),
      `
      import assert from 'node:assert/strict';
      import { readFile } from 'node:fs/promises';
      import { createRequire } from 'node:module';
      for (const name of ${JSON.stringify(names.filter((name) => name !== "@veyraoss/cli"))}) {
        assert.ok(Object.keys(await import(name)).length > 0, name);
      }
      const { loadWorkflow, listBuiltinWorkflows } = await import('@veyraoss/workflow');
      assert.deepEqual(listBuiltinWorkflows(), ['dev', 'bugfix', 'review', 'research']);
      for (const preset of listBuiltinWorkflows()) assert.ok((await loadWorkflow(preset)).steps);
      const schema = createRequire(import.meta.url).resolve('@veyraoss/workflow/workflow-v1.schema.json');
      assert.equal(JSON.parse(await readFile(schema, 'utf8')).type, 'object');
      console.log('isolated package imports, presets and schema passed');
    `,
    );
    expect(await command(process.execPath, ["check.mjs"], consumer)).toContain("passed");
    const cli = join(consumer, "node_modules/@veyraoss/cli/dist/index.js");
    expect((await command(process.execPath, [cli, "version"], consumer)).trim()).toBe(
      `ve ${manifests.find((manifest) => manifest.name === "@veyraoss/cli")?.version}`,
    );
    const list = JSON.parse(
      await command(process.execPath, [cli, "workflow", "list", "--json"], consumer),
    );
    expect(list.workflows).toHaveLength(4);

    const nodeTypes = join(consumer, "node_modules/@types/node");
    await mkdir(dirname(nodeTypes), { recursive: true });
    await symlink(join(root, "node_modules/@types/node"), nodeTypes, "dir");
    await writeFile(
      join(consumer, "check.mts"),
      `
      import type { AgentAdapter, AgentInput } from '@veyraoss/sdk';
      import { loadWorkflow, type WorkflowDefinition } from '@veyraoss/workflow';
      import { LocalAgentRuntime } from '@veyraoss/runtime';
      const input: AgentInput = { runId: 'fixture', stepId: 'step', role: 'reviewer', goal: 'verify types' };
      const adapter: AgentAdapter = { id: 'fixture', provider: 'fixture', async run(input) { return { status: 'success', summary: input.goal }; } };
      const workflow: WorkflowDefinition = await loadWorkflow('dev');
      await new LocalAgentRuntime().runAgent(adapter, { ...input, stepId: workflow.start });
    `,
    );
    await command(
      process.execPath,
      [
        join(root, "node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--strict",
        "--module",
        "NodeNext",
        "--target",
        "ES2022",
        "--types",
        "node",
        "--skipLibCheck",
        "check.mts",
      ],
      consumer,
    );

    // Exercise a future version without changing source or rebuilding. Fresh processes
    // must report the installed manifests, including both variants of shared plugins.
    const futureVersion = "0.9.7-test.1";
    for (const directory of candidates) {
      const path = join(temporary, directory, "package.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, JSON.stringify({ ...manifest, version: futureVersion }));
    }
    await writeFile(
      join(consumer, "versions.mjs"),
      `
      import assert from 'node:assert/strict';
      import { pathToFileURL } from 'node:url';
      const { builtinPlugins } = await import(pathToFileURL(${JSON.stringify(join(consumer, "node_modules/@veyraoss/cli/dist/plugins.js"))}));
      const plugins = builtinPlugins({ env: {} });
      assert.equal(plugins.length, 8);
      for (const plugin of plugins) {
        assert.equal(plugin.version, ${JSON.stringify(futureVersion)}, plugin.provider);
        const adapter = plugin.createAgent({ id: 'fixture', model: plugin.provider === 'opencode' ? 'fixture/model' : 'fixture-model', options: {} }, { options: { ...(plugin.provider === 'openai-compatible' ? { baseURL: 'http://127.0.0.1:1/v1' } : {}) } });
        assert.equal((await adapter.describe()).adapterVersion, ${JSON.stringify(futureVersion)}, plugin.provider);
      }
      console.log('all installed adapter versions passed');
    `,
    );
    expect(await command(process.execPath, ["versions.mjs"], consumer)).toContain("passed");
    expect(
      JSON.parse(await command(process.execPath, [cli, "version", "--json"], consumer)),
    ).toEqual({
      version: futureVersion,
      executable: "ve",
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 60_000);
