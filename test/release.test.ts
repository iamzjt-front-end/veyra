import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runProcess } from "../packages/runtime/src/process.js";
import { git, initializeGit } from "./helpers/git.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = join(root, "scripts/release.mjs");
const tag = "v0.1.0";
interface Fixture {
  cwd: string;
  out: string;
  directory: string;
  commit: string;
  env: NodeJS.ProcessEnv;
}

async function command(fixture: Fixture, mode: string, args: string[] = [], expected = 0) {
  const result = await runProcess({
    executable: process.execPath,
    args: [script, mode, "--tag", tag, "--dist-tag", "latest", ...args],
    cwd: fixture.cwd,
    timeoutMs: 45_000,
    env: fixture.env,
  });
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(expected);
  return `${result.stdout}\n${result.stderr}`;
}

async function json(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function withReleaseFixture(action: (fixture: Fixture) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "veyra-release-test-"));
  const cwd = join(directory, "checkout");
  try {
    await mkdir(cwd);
    for (const name of ["package.json", "pnpm-workspace.yaml"])
      await copyFile(join(root, name), join(cwd, name));
    await writeFile(join(cwd, ".gitignore"), "node_modules/\n");
    await symlink(join(root, "node_modules"), join(cwd, "node_modules"), "dir");
    await mkdir(join(cwd, ".changeset"));
    await copyFile(join(root, ".changeset/config.json"), join(cwd, ".changeset/config.json"));
    const workspaces = new Map<
      string,
      { directory: string; dependencies: Record<string, string> }
    >();
    for (const parent of ["apps", "packages", "plugins"]) {
      for (const entry of await readdir(join(root, parent), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const path = join(parent, entry.name);
        let manifest: { name: string; version: string; dependencies?: Record<string, string> };
        try {
          manifest = await json(join(root, path, "package.json"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        manifest.version = "0.1.0";
        workspaces.set(manifest.name, {
          directory: path,
          dependencies: manifest.dependencies ?? {},
        });
        await mkdir(join(cwd, path, "dist"), { recursive: true });
        await writeFile(join(cwd, path, "package.json"), JSON.stringify(manifest));
        await writeFile(join(cwd, path, "dist/index.js"), "export const fixture = true;\n");
        await writeFile(
          join(cwd, path, "dist/index.d.ts"),
          "export declare const fixture: true;\n",
        );
        await writeFile(join(cwd, path, "README.md"), "# Disposable release test fixture\n");
        await writeFile(
          join(cwd, path, "CHANGELOG.md"),
          `# ${manifest.name}\n\n## 0.1.0\n\nFixture release note.\n`,
        );
        await copyFile(join(root, "LICENSE"), join(cwd, path, "LICENSE"));
      }
    }
    // pnpm pack resolves workspace:* through installed workspace links. Keep those
    // links within this fixture so tarball versions come from the copied graph.
    for (const workspace of workspaces.values()) {
      for (const dependency of Object.keys(workspace.dependencies)) {
        const target = workspaces.get(dependency);
        if (!target) continue;
        await mkdir(join(cwd, workspace.directory, "node_modules/@veyraoss"), { recursive: true });
        await symlink(
          join(cwd, target.directory),
          join(cwd, workspace.directory, "node_modules", dependency),
          "dir",
        );
      }
    }
    const commit = await initializeGit(cwd);
    const out = join(directory, "bundle");
    const bin = join(directory, "bin");
    await mkdir(bin);
    // Only this disposable fake executable handles publication in these tests.
    const npm = join(bin, "npm");
    await writeFile(
      npm,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RELEASE_FIXTURE_CALLS, JSON.stringify(args) + '\\n');
if (process.env.RELEASE_FIXTURE_FAIL === 'true') { console.error('fixture-secret-do-not-log'); process.exit(1); }
if (args[0] === 'view') {
  const bundle = JSON.parse(fs.readFileSync(process.env.RELEASE_FIXTURE_BUNDLE, 'utf8'));
  const artifact = bundle.packages.find(p => args[1] === p.name + '@' + bundle.version);
  console.log(JSON.stringify(process.env.RELEASE_FIXTURE_BAD_INTEGRITY === 'true' ? 'sha512-wrong' : artifact.integrity));
}
`,
    );
    await chmod(npm, 0o755);
    const env: NodeJS.ProcessEnv = {
      PATH: `${bin}:${process.env.PATH}`,
      NODE_PATH: undefined,
      NODE_OPTIONS: undefined,
      npm_config_offline: "true",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(cwd, ".git/unused-global-config"),
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_INDEX_FILE: undefined,
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "iamzjt-front-end/veyra",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: commit,
      VEYRA_RELEASE_APPROVED: "true",
      RELEASE_FIXTURE_CALLS: join(directory, "npm-calls.jsonl"),
      RELEASE_FIXTURE_BUNDLE: join(out, "release.json"),
    };
    await action({ directory, cwd, out, commit, env });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function noPublication(fixture: Fixture) {
  await expect(readFile(join(fixture.directory, "npm-calls.jsonl"))).rejects.toMatchObject({
    code: "ENOENT",
  });
}

describe("release preparation and publication boundaries", () => {
  it("packs fifteen real tarballs in dependency order with matching hashes and notes", async () => {
    await withReleaseFixture(async (fixture) => {
      expect(await command(fixture, "check", ["--ready"])).toContain("publishable=true");
      await command(fixture, "pack", ["--out", fixture.out]);
      const bundle = await json(join(fixture.out, "release.json"));
      expect(bundle).toMatchObject({
        schemaVersion: 1,
        commit: fixture.commit,
        tag,
        version: "0.1.0",
        publishable: true,
      });
      expect(bundle.packages).toHaveLength(15);
      const seen = new Set<string>();
      for (const artifact of bundle.packages) {
        const bytes = await readFile(join(fixture.out, artifact.filename));
        expect(artifact.integrity).toBe(
          `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        );
        expect(artifact.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
        const name = artifact.name.split("/")[1];
        const parent =
          name === "cli"
            ? "apps"
            : ["openai", "codex", "claude", "claude-code", "gemini", "opencode"].includes(name)
              ? "plugins"
              : "packages";
        const manifest = await json(join(fixture.cwd, parent, name, "package.json"));
        for (const dependency of Object.keys(manifest.dependencies ?? {}))
          if (dependency.startsWith("@veyraoss/")) expect(seen.has(dependency)).toBe(true);
        seen.add(artifact.name);
      }
      expect(bundle.packages.at(-1).name).toBe("@veyraoss/cli");
      expect(await readFile(join(fixture.out, "RELEASE_NOTES.md"), "utf8")).toContain(
        "Fixture release note.",
      );
      expect(
        (await readFile(join(fixture.out, "SHA256SUMS"), "utf8")).trim().split("\n"),
      ).toHaveLength(15);
      await command(fixture, "pack", ["--out", fixture.out], 1);
      await noPublication(fixture);
      expect(await git(fixture.cwd, "tag", "--list")).toBe("");
    });
  }, 60_000);

  it.each([
    { args: ["--tag", "v0.1.1"], message: "versions must match" },
    { args: ["--tag", "v01.1.0"], message: "valid SemVer" },
    { args: ["--tag", "v0.1.0-01"], message: "valid SemVer" },
    { args: ["--dist-tag", "next"], message: "Stable versions require" },
  ])("rejects invalid release identity $args before publication", async ({ args, message }) => {
    await withReleaseFixture(async (fixture) => {
      expect(await command(fixture, "check", args, 1)).toContain(message);
      await noPublication(fixture);
    });
  });

  it("refuses stale tags, dirty checkouts and unconsumed notes in a publication request", async () => {
    await withReleaseFixture(async (fixture) => {
      await git(fixture.cwd, "tag", tag);
      await git(fixture.cwd, "commit", "--allow-empty", "-m", "Later fixture source");
      expect(await command(fixture, "check", [], 1)).toContain("different commit");
      await git(fixture.cwd, "tag", "-d", tag);
      await writeFile(
        join(fixture.cwd, ".changeset/pending.md"),
        '---\n"@veyraoss/sdk": patch\n---\n\nPending fixture.\n',
      );
      expect(await command(fixture, "check", ["--ready"], 1)).toContain("clean checkout");
      await git(fixture.cwd, "add", ".changeset/pending.md");
      await git(fixture.cwd, "commit", "-m", "Pending release note");
      expect(await command(fixture, "check", ["--ready"], 1)).toContain(
        "Consume pending release notes",
      );
      expect(await command(fixture, "check")).toContain("publishable=false");
      await noPublication(fixture);
    });
  });

  it("refuses local/unapproved publication and validates every digest before invoking npm", async () => {
    await withReleaseFixture(async (fixture) => {
      await command(fixture, "pack", ["--out", fixture.out]);
      fixture.env.VEYRA_RELEASE_APPROVED = undefined;
      expect(await command(fixture, "publish", ["--out", fixture.out], 1)).toContain(
        "approved main-branch",
      );
      fixture.env.VEYRA_RELEASE_APPROVED = "true";
      const bundle = await json(join(fixture.out, "release.json"));
      await writeFile(join(fixture.out, bundle.packages.at(-1).filename), "tampered fixture");
      expect(await command(fixture, "publish", ["--out", fixture.out], 1)).toContain("digest");
      await noPublication(fixture);
    });
  }, 60_000);

  it("uses exact packed bytes, public access, provenance and verified registry integrity", async () => {
    await withReleaseFixture(async (fixture) => {
      await command(fixture, "pack", ["--out", fixture.out]);
      await command(fixture, "publish", ["--out", fixture.out]);
      const calls = (await readFile(join(fixture.directory, "npm-calls.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const bundle = await json(join(fixture.out, "release.json"));
      expect(calls).toHaveLength(bundle.packages.length * 2);
      for (const [index, artifact] of bundle.packages.entries()) {
        expect(calls[index * 2]).toEqual([
          "publish",
          join(fixture.out, artifact.filename),
          "--registry",
          "https://registry.npmjs.org",
          "--access",
          "public",
          "--provenance",
          "--tag",
          "latest",
          "--ignore-scripts",
        ]);
        expect(calls[index * 2 + 1]).toContain(`${artifact.name}@0.1.0`);
      }
      expect(await git(fixture.cwd, "tag", "--list")).toBe("");
    });
  }, 60_000);

  it.each(["RELEASE_FIXTURE_FAIL", "RELEASE_FIXTURE_BAD_INTEGRITY"])(
    "stops on %s without exposing child diagnostics",
    async (flag) => {
      await withReleaseFixture(async (fixture) => {
        await command(fixture, "pack", ["--out", fixture.out]);
        fixture.env[flag] = "true";
        const output = await command(fixture, "publish", ["--out", fixture.out], 1);
        expect(output).not.toContain("fixture-secret-do-not-log");
        const calls = (await readFile(join(fixture.directory, "npm-calls.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(calls.filter((args) => args[0] === "publish")).toHaveLength(1);
      });
    },
    60_000,
  );
});
