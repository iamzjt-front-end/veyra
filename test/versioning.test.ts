import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runProcess } from "../packages/runtime/src/process.js";
import { git, initializeGit } from "./helpers/git.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = join(root, "node_modules/@changesets/cli/bin.js");

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
}

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function command(cwd: string, executable: string, args: string[], expectedExitCode = 0) {
  const result = await runProcess({
    executable,
    args,
    cwd,
    timeoutMs: 30_000,
    env: {
      NODE_PATH: undefined,
      NODE_OPTIONS: undefined,
      npm_config_offline: "true",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(cwd, ".git/unused-global-config"),
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_INDEX_FILE: undefined,
    },
  });
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(expectedExitCode);
  return `${result.stdout}\n${result.stderr}`;
}

const changeset = (cwd: string, args: string[], expectedExitCode = 0) =>
  command(cwd, process.execPath, [cli, ...args], expectedExitCode);

async function withVersioningFixture(
  baseVersion: string,
  action: (cwd: string, packages: Map<string, string>, head: string) => Promise<void>,
) {
  const cwd = await mkdtemp(join(tmpdir(), "veyra-versioning-"));
  try {
    await copyFile(join(root, "package.json"), join(cwd, "package.json"));
    await copyFile(join(root, "pnpm-workspace.yaml"), join(cwd, "pnpm-workspace.yaml"));
    await writeFile(join(cwd, ".gitignore"), "node_modules/\nplan.json\n");
    await mkdir(join(cwd, ".changeset"));
    await copyFile(join(root, ".changeset/config.json"), join(cwd, ".changeset/config.json"));
    await symlink(join(root, "node_modules"), join(cwd, "node_modules"), "dir");
    const packages = new Map<string, string>();
    for (const parent of ["apps", "packages", "plugins"]) {
      for (const entry of await readdir(join(root, parent), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const directory = join(parent, entry.name);
        let manifest: Manifest;
        try {
          manifest = await readJson(join(root, directory, "package.json"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        await mkdir(join(cwd, directory), { recursive: true });
        if (!manifest.private) {
          manifest.version = baseVersion;
          packages.set(manifest.name, directory);
        }
        await writeFile(join(cwd, directory, "package.json"), JSON.stringify(manifest));
      }
    }
    const config = await readJson(join(cwd, ".changeset/config.json"));
    expect([...packages.keys()].sort()).toEqual(config.fixed[0].toSorted());
    expect(packages.size).toBe(14);
    const head = await initializeGit(cwd);
    await action(cwd, packages, head);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("local version and changelog preparation", () => {
  it("runs the documented preparation script with a frozen offline lockfile", async () => {
    await withVersioningFixture("0.1.0", async (cwd, packages, head) => {
      const originalLock = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
      await writeFile(join(cwd, "pnpm-lock.yaml"), originalLock);
      await copyFile(join(root, ".prettierrc.json"), join(cwd, ".prettierrc.json"));
      await copyFile(join(root, ".prettierignore"), join(cwd, ".prettierignore"));
      await writeFile(
        join(cwd, ".changeset/fixture-change.md"),
        '---\n"@veyraoss/sdk": patch\n---\n\nVerify local preparation.\n',
      );
      await command(cwd, "pnpm", ["release:version"]);
      await command(cwd, "pnpm", ["install", "--frozen-lockfile", "--lockfile-only", "--offline"]);
      await command(cwd, "pnpm", ["exec", "prettier", "--check", "."]);
      for (const directory of packages.values())
        expect((await readJson(join(cwd, directory, "package.json"))).version).toBe("0.1.1");
      expect(await readFile(join(cwd, "packages/sdk/CHANGELOG.md"), "utf8")).toContain(
        "Verify local preparation.",
      );
      expect(await readFile(join(root, "pnpm-lock.yaml"), "utf8")).toBe(originalLock);
      expect(await git(cwd, "rev-parse", "HEAD")).toBe(head);
      expect(await git(cwd, "tag", "--list")).toBe("");
    });
  }, 60_000);

  it.each([
    { base: "0.1.0", bump: "patch", next: "0.1.1" },
    { base: "0.1.0", bump: "minor", next: "0.2.0" },
    { base: "1.2.3", bump: "major", next: "2.0.0" },
  ])(
    "prepares a $bump release at $next without publishing, tagging or committing",
    async ({ base, bump, next }) => {
      await withVersioningFixture(base, async (cwd, packages, head) => {
        const note = join(cwd, ".changeset/fixture-change.md");
        await writeFile(note, `---\n"@veyraoss/sdk": ${bump}\n---\n\nFixture public API change.\n`);
        // The highest requested bump governs the fixed group, not the number of notes.
        await writeFile(
          join(cwd, ".changeset/fixture-fix.md"),
          '---\n"@veyraoss/core": patch\n---\n\nFixture repair.\n',
        );
        await changeset(cwd, ["status", "--output", "plan.json"]);
        const plan = await readJson(join(cwd, "plan.json"));
        expect(plan.releases).toHaveLength(14);
        expect(
          new Set(plan.releases.map((release: { newVersion: string }) => release.newVersion)),
        ).toEqual(new Set([next]));
        expect(plan.changesets).toHaveLength(2);
        await changeset(cwd, ["version"]);
        for (const [name, directory] of packages) {
          const manifest: Manifest = await readJson(join(cwd, directory, "package.json"));
          expect(manifest.version, name).toBe(next);
          for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
            if (packages.has(dependency)) expect(version).toBe("workspace:*");
          }
        }
        const changelog = await readFile(join(cwd, "packages/sdk/CHANGELOG.md"), "utf8");
        expect(changelog).toContain(`## ${next}`);
        expect(changelog).toContain("Fixture public API change.");
        const coreLog = await readFile(join(cwd, "packages/core/CHANGELOG.md"), "utf8");
        expect(coreLog).toContain("Fixture repair.");
        expect(coreLog).toContain(`@veyraoss/runtime@${next}`);
        expect(await readdir(join(cwd, ".changeset"))).toEqual(["config.json"]);
        for (const path of ["package.json", "apps/tui/package.json"]) {
          expect((await readJson(join(cwd, path))).version).toBe(
            (await readJson(join(root, path))).version,
          );
          expect((await readJson(join(cwd, path))).private).toBe(true);
        }
        expect(await git(cwd, "rev-parse", "HEAD")).toBe(head);
        expect(await git(cwd, "tag", "--list")).toBe("");
        const before = await readFile(join(cwd, "packages/sdk/CHANGELOG.md"), "utf8");
        await changeset(cwd, ["version"]);
        expect(await readFile(join(cwd, "packages/sdk/CHANGELOG.md"), "utf8")).toBe(before);
        expect((await readJson(join(cwd, "packages/sdk/package.json"))).version).toBe(next);
      });
    },
    60_000,
  );

  it("rejects a release note for an unknown package before changing versions", async () => {
    await withVersioningFixture("0.1.0", async (cwd, packages, head) => {
      await writeFile(
        join(cwd, ".changeset/unknown.md"),
        '---\n"@veyraoss/unknown-fixture": patch\n---\n\nInvalid release target.\n',
      );
      expect(await changeset(cwd, ["version"], 1)).toContain("@veyraoss/unknown-fixture");
      for (const directory of packages.values())
        expect((await readJson(join(cwd, directory, "package.json"))).version).toBe("0.1.0");
      expect(await git(cwd, "rev-parse", "HEAD")).toBe(head);
    });
  }, 60_000);
});
