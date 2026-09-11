import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, writeFile, readFile, lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { initializeProject, ProjectRegistry, saveProjectBindings } from "@veyraoss/project";
import { EXTENSION_ORIGIN } from "../src/contracts.js";

const exec = promisify(execFile);
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const cli = join(repository, "apps/cli/dist/index.js");
const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

/** Creates a new proof without overwriting earlier evidence. Tests must supply an isolated parent. */
export async function prepareLiveProject(parentDirectory: string, executable = "codex") {
  await mkdir(parentDirectory, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(parentDirectory, "veyra-pro-proof-"));
  try {
    const root = join(directory, "project");
    await cp(join(repository, "test/fixtures/minimal-project"), root, { recursive: true });
    await mkdir(join(root, "scripts"));
    await writeFile(
      join(root, "src/message.js"),
      "export function message() { return 'BROKEN'; }\n",
    );
    await writeFile(join(root, ".gitignore"), ".veyra/\nbuild/\n");
    await writeFile(
      join(root, "AGENTS.md"),
      "# Disposable Veyra bridge acceptance Project\nChange only src/message.js. The target is message() returning exactly 'Hello from the Veyra fixture'. Preserve all tests, scripts, configuration, metadata and instructions. No dependencies, commits, pushes, publication, deployment, credential access or chat history access. Veyra runs trusted checks after execution.\n",
    );
    await writeFile(
      join(root, "scripts/build.mjs"),
      "import { mkdir, copyFile } from 'node:fs/promises';\nawait mkdir('build', { recursive: true });\nawait copyFile('src/message.js', 'build/message.js');\n",
    );
    await writeFile(
      join(root, "veyra.yaml"),
      JSON.stringify({ version: 1, agents: {}, workflow: { use: "./checks.yaml" } }),
    );
    await writeFile(
      join(root, "checks.yaml"),
      JSON.stringify({
        version: 1,
        name: "bridge-proof-checks",
        start: "test",
        steps: {
          test: { type: "command", run: ["node --test"], next: "build", timeoutMs: 10000 },
          build: {
            type: "command",
            run: ["node --check src/message.js", "node scripts/build.mjs"],
            next: "diff",
            timeoutMs: 10000,
          },
          diff: {
            type: "command",
            run: ["git diff --no-ext-diff --no-textconv -- src/message.js"],
            timeoutMs: 10000,
          },
        },
      }),
    );
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    const git = (...args: string[]) => exec("git", args, { cwd: root, env, timeout: 15000 });
    await git("init", "--quiet");
    await git("add", ".");
    await git(
      "-c",
      "user.name=Veyra fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Disposable bridge acceptance baseline",
    );
    const project = await initializeProject(root, { name: "veyra-pro-proof" });
    const registryRoot = join(directory, "registry");
    await new ProjectRegistry({ root: registryRoot }).register(root);
    await saveProjectBindings(
      project,
      { executor: { provider: "codex", mode: "native", executable } },
      0,
    );
    const paths = [
      "AGENTS.md",
      ".gitignore",
      "package.json",
      "test/message.test.js",
      "scripts/build.mjs",
      "veyra.yaml",
      "checks.yaml",
      ".veyra/project.yaml",
    ];
    const protectedFiles = Object.fromEntries(
      await Promise.all(
        paths.map(async (file) => [file, await readFile(join(root, file), "utf8")]),
      ),
    );
    const setup = {
      version: 1,
      directory,
      project,
      registryRoot,
      executable,
      port: 3181,
      protectedFiles,
    };
    await writeFile(join(directory, "acceptance.json"), JSON.stringify(setup, null, 2), {
      mode: 0o600,
    });
    for (const [file, args] of [
      [
        "start-daemon.sh",
        [
          "daemon",
          "start",
          "--registry",
          registryRoot,
          "--http-port",
          "3181",
          "--http-origin",
          EXTENSION_ORIGIN,
          "--http-project",
          project.id,
        ],
      ],
      ["stop-daemon.sh", ["daemon", "stop", "--registry", registryRoot]],
      ["daemon-status.sh", ["daemon", "status", "--registry", registryRoot, "--json"]],
      ["native-doctor.sh", ["doctor", "--codex-executable", executable, "--json"]],
    ] as const) {
      await writeFile(
        join(directory, file),
        `#!/bin/sh\nset -eu\ncd ${quote(root)}\nexec env -u OPENAI_API_KEY ${[process.execPath, cli, ...args].map(quote).join(" ")}\n`,
        { mode: 0o700 },
      );
    }
    return {
      directory,
      project,
      registryRoot,
      extension: join(repository, "apps/chatgpt-extension/dist"),
      port: 3181,
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function inspectLiveProject(directory: string) {
  const setup = JSON.parse(await readFile(join(directory, "acceptance.json"), "utf8"));
  const root: string = setup.project.root;
  for (const [file, expected] of Object.entries(setup.protectedFiles)) {
    const path = join(root, file);
    const info = await lstat(path);
    assert.ok(
      info.isFile() && !info.isSymbolicLink() && info.nlink === 1,
      `Unsafe protected file: ${file}`,
    );
    assert.equal(await readFile(path, "utf8"), expected, `Protected file changed: ${file}`);
  }
  const tests = await exec(process.execPath, ["--test"], { cwd: root, timeout: 10000 });
  const build = await exec(process.execPath, ["scripts/build.mjs"], { cwd: root, timeout: 10000 });
  const diff = await exec("git", ["diff", "--name-only"], { cwd: root, timeout: 5000 });
  assert.deepEqual(diff.stdout.trim().split("\n"), ["src/message.js"]);
  const untracked = await exec("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: root,
    timeout: 5000,
  });
  assert.equal(untracked.stdout, "");
  return {
    projectId: setup.project.id,
    protectedFilesUnchanged: true,
    changedFiles: ["src/message.js"],
    test: "passed",
    build: "passed",
    outputBytes: tests.stdout.length + build.stdout.length,
    note: "Local file verification only. Real same-conversation ChatGPT delivery must still be observed.",
  };
}
