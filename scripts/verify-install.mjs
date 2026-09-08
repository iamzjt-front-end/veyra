// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: This standalone installation check is never cached by Turbo.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

/** @param {string} executable @param {string[]} args @param {string} cwd @param {NodeJS.ProcessEnv} env @param {number} [expected] */
async function run(executable, args, cwd, env, expected = 0) {
  try {
    const result = await execute(executable, args, {
      cwd,
      env,
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
    });
    assert.equal(expected, 0, "Expected an unavailable-tool diagnostic.");
    return result.stdout;
  } catch (error) {
    const result = /** @type {{ code?: unknown, stdout?: string }} */ (error);
    if (expected !== 0 && result.code === expected) return result.stdout ?? "";
    throw new Error(`${executable} failed during isolated installation verification.`);
  }
}

async function main() {
  const temporary = await mkdtemp(join(tmpdir(), "veyra-installed-"));
  try {
    const prefix = join(temporary, "global prefix");
    const cache = join(temporary, "cache");
    const consumer = join(temporary, "consumer");
    const bundle = join(temporary, "bundle");
    const nodeBin = join(temporary, "node-bin");
    await mkdir(consumer);
    await mkdir(nodeBin);
    await symlink(process.execPath, join(nodeBin, "node"));
    await writeFile(join(temporary, "user.npmrc"), "");
    await writeFile(join(temporary, "global.npmrc"), "");
    // Public registry reads only. Do not load the maintainer's npm credentials/config.
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      NPM_CONFIG_USERCONFIG: join(temporary, "user.npmrc"),
      NPM_CONFIG_GLOBALCONFIG: join(temporary, "global.npmrc"),
    };
    const manifest = JSON.parse(await readFile(join(root, "apps/cli/package.json"), "utf8"));
    await run(
      process.execPath,
      [
        join(root, "scripts/release.mjs"),
        "pack",
        "--tag",
        `v${manifest.version}`,
        "--dist-tag",
        manifest.version.includes("-") ? "next" : "latest",
        "--out",
        bundle,
      ],
      root,
      env,
    );
    const release = JSON.parse(await readFile(join(bundle, "release.json"), "utf8"));
    const flags = [
      "--global",
      "--prefix",
      prefix,
      "--cache",
      cache,
      "--registry",
      "https://registry.npmjs.org",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ];
    await run(
      "npm",
      [
        "install",
        ...flags,
        ...release.packages.map(
          /** @param {{ filename: string }} item */ (item) => join(bundle, item.filename),
        ),
      ],
      consumer,
      env,
    );
    const ve = join(prefix, "bin/ve");
    const isolated = { ...env, PATH: `${join(prefix, "bin")}:${nodeBin}` };
    assert.deepEqual(JSON.parse(await run(ve, ["version", "--json"], consumer, isolated)), {
      version: manifest.version,
      executable: "ve",
    });
    const workflows = JSON.parse(await run(ve, ["workflow", "list", "--json"], consumer, isolated));
    assert.equal(workflows.workflows.length, 4);
    const missing = JSON.parse(await run(ve, ["doctor", "--json"], consumer, isolated, 1));
    assert.equal(missing.config.status, "missing");
    assert.match(missing.config.message, /ve init/);
    assert.equal(missing.pnpm.ready, false);
    assert.match(missing.pnpm.message, /Install pnpm/);
    assert.equal(
      missing.providers.some(
        /** @param {{ required: boolean }} provider */ (provider) => provider.required,
      ),
      false,
    );
    assert.match(await run(ve, ["doctor"], consumer, isolated, 1), /Install pnpm/);

    await run("npm", ["install", ...flags, "pnpm@10.15.1"], consumer, env);
    const nativeMissing = JSON.parse(await run(ve, ["doctor", "--json"], consumer, isolated, 1));
    assert.equal(nativeMissing.pnpm.ready, true);
    assert.equal(nativeMissing.executor.available, false);
    // This proves installed CLI wiring only. Real native-login acceptance is a separate check.
    const fixtureCodex = join(nodeBin, "fixture-codex");
    await writeFile(
      fixtureCodex,
      '#!/usr/bin/env node\nconsole.log(process.argv[2] === "--version" ? "codex-cli 1.2.3" : "Logged in using ChatGPT");\n',
      { mode: 0o700 },
    );
    const ready = JSON.parse(
      await run(ve, ["doctor", "--codex-executable", fixtureCodex, "--json"], consumer, isolated),
    );
    assert.equal(ready.ready, true);
    assert.equal(ready.executor.authenticationOwner, "native-client");
    assert.equal(ready.pnpm.version, "10.15.1");
    assert.equal(ready.config.status, "missing");
    // Removal is confined to this disposable npm prefix and leaves the project alone.
    await run(
      "npm",
      [
        "uninstall",
        ...flags,
        ...release.packages.map(/** @param {{ name: string }} item */ (item) => item.name),
        "pnpm",
      ],
      consumer,
      env,
    );
    await assert.rejects(lstat(ve), { code: "ENOENT" });
    await assert.rejects(lstat(join(consumer, "veyra.yaml")), { code: "ENOENT" });
    await assert.rejects(lstat(join(consumer, ".veyra")), { code: "ENOENT" });
    console.log(
      `Global npm installation passed: ve ${manifest.version}, four presets, fresh-machine doctor guidance, pnpm/native fixture readiness and uninstall. No package was published.`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Installation verification failed.");
  process.exitCode = 1;
});
