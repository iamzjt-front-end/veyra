// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: This release CLI runs directly and is never cached by Turbo.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { parseArgs } from "node:util";

const execute = promisify(execFile);
const repository = "iamzjt-front-end/veyra";
const registry = "https://registry.npmjs.org";
class ReleaseError extends Error {}

/** @param {unknown} value @param {string} message @returns {asserts value} */
function requireValue(value, message) {
  if (!value) throw new ReleaseError(message);
}

/** @param {string} executable @param {string[]} args @param {boolean} [missingOkay] */
async function run(executable, args, missingOkay = false) {
  try {
    return (
      await execute(executable, args, {
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout.trim();
  } catch (error) {
    const code = /** @type {{ code?: unknown }} */ (error).code;
    if (missingOkay && code === 1) return "";
    // npm diagnostics may contain credentials. Never echo child output or environment.
    throw new ReleaseError(
      `${executable} failed (${typeof code === "number" ? `exit ${code}` : "process error"}). Inspect tooling, registry permissions and connectivity.`,
    );
  }
}

/** @param {string} path */
async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** @param {Buffer} bytes @param {string} algorithm @param {"hex" | "base64"} encoding */
function hash(bytes, algorithm, encoding) {
  return createHash(algorithm).update(bytes).digest(encoding);
}

/** @typedef {{ name: string, version: string, directory: string, manifest: Record<string, any> }} Package */

/** @param {string} tag @param {string} distTag @param {boolean} ready */
async function inspect(tag, distTag, ready) {
  const version = tag.slice(1);
  requireValue(
    tag.length <= 130 &&
      /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/.test(
        tag,
      ),
    "Release tag must be v followed by a valid SemVer without build metadata.",
  );
  requireValue(
    distTag === (version.includes("-") ? "next" : "latest"),
    "Stable versions require npm tag latest; prereleases require next.",
  );
  requireValue(
    (await json("package.json")).private === true,
    "The repository root must remain private.",
  );
  requireValue(
    (await json("apps/tui/package.json")).private === true,
    "The TUI scaffold must remain private.",
  );
  /** @type {Package[]} */
  const packages = [];
  for (const parent of ["apps", "packages", "plugins"]) {
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(parent, entry.name);
      let manifest;
      try {
        manifest = await json(join(directory, "package.json"));
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") continue;
        throw error;
      }
      if (manifest.private === true) continue;
      requireValue(manifest.name === `@veyraoss/${entry.name}`, "Unexpected public package name.");
      requireValue(
        manifest.version === version,
        "Release tag and official package versions must match.",
      );
      requireValue(
        manifest.publishConfig?.access === "public" &&
          manifest.publishConfig?.registry === registry,
        "Public package registry/access metadata is invalid.",
      );
      requireValue(
        manifest.repository?.url === `git+https://github.com/${repository}.git` &&
          manifest.repository?.directory === directory,
        "Package repository metadata does not match the release repository.",
      );
      requireValue(
        manifest.name === "@veyraoss/cli"
          ? JSON.stringify(manifest.bin) === JSON.stringify({ ve: "./dist/index.js" })
          : manifest.bin === undefined,
        "ve must be the only public executable.",
      );
      packages.push({ name: manifest.name, version, directory, manifest });
    }
  }
  const fixed = (await json(".changeset/config.json")).fixed;
  requireValue(
    packages.length === 14 &&
      fixed.length === 1 &&
      JSON.stringify(packages.map((p) => p.name).sort()) === JSON.stringify([...fixed[0]].sort()),
    "The release set must match the fourteen fixed official packages.",
  );
  /** @type {Package[]} */
  const ordered = [];
  while (ordered.length < packages.length) {
    const next = packages.find(
      (p) =>
        !ordered.includes(p) &&
        Object.keys(p.manifest.dependencies ?? {})
          .filter((name) => name.startsWith("@veyraoss/"))
          .every((name) => ordered.some((item) => item.name === name)),
    );
    requireValue(
      next,
      "Official dependencies are cyclic or reference a package outside the release set.",
    );
    ordered.push(next);
  }
  const commit = await run("git", ["rev-parse", "HEAD"]);
  const existingTag = await run(
    "git",
    ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`],
    true,
  );
  requireValue(
    !existingTag || existingTag === commit,
    "Existing release tag points to a different commit.",
  );
  const dirty = Boolean(await run("git", ["status", "--porcelain"]));
  const pendingNotes = (await readdir(".changeset")).filter(
    (name) => name.endsWith(".md") && name !== "README.md",
  );
  if (ready) {
    requireValue(!dirty, "Release publication requires a clean checkout.");
    requireValue(
      pendingNotes.length === 0,
      "Consume pending release notes with pnpm release:version before publication.",
    );
  }
  return {
    version,
    tag,
    distTag,
    commit,
    publishable: !dirty && pendingNotes.length === 0,
    packages: ordered,
  };
}

/** @param {Awaited<ReturnType<typeof inspect>>} release @param {string} out */
async function pack(release, out) {
  await mkdir(out); // Never overwrite an earlier review bundle.
  const packages = [];
  const notes = [
    `# Veyra ${release.tag}`,
    "",
    `Source commit: ${release.commit}`,
    "",
    release.publishable
      ? "Local release candidate; publication requires human approval."
      : "Validation preview only: the checkout or pending release notes are not ready for publication.",
    "",
  ];
  for (const item of release.packages) {
    const packed = JSON.parse(
      await run("pnpm", ["--dir", item.directory, "pack", "--json", "--pack-destination", out]),
    );
    const filename = `veyraoss-${item.name.split("/")[1]}-${release.version}.tgz`;
    requireValue(
      resolve(packed.filename) === join(out, filename),
      "Unexpected package tarball location.",
    );
    const bytes = await readFile(join(out, filename));
    packages.push({
      name: item.name,
      filename,
      integrity: `sha512-${hash(bytes, "sha512", "base64")}`,
      sha256: hash(bytes, "sha256", "hex"),
    });
    try {
      const changelog = await readFile(join(item.directory, "CHANGELOG.md"), "utf8");
      const section = changelog.split(`## ${release.version}\n`)[1]?.split(/\n## /)[0]?.trim();
      if (section) notes.push(`## ${item.name}`, "", section, "");
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
    }
  }
  await writeFile(
    join(out, "release.json"),
    `${JSON.stringify({ schemaVersion: 1, repository, version: release.version, tag: release.tag, distTag: release.distTag, commit: release.commit, publishable: release.publishable, packages }, null, 2)}\n`,
  );
  await writeFile(
    join(out, "SHA256SUMS"),
    packages.map((p) => `${p.sha256}  ${p.filename}\n`).join(""),
  );
  await writeFile(join(out, "RELEASE_NOTES.md"), `${notes.join("\n")}\n`);
  console.log(
    `Prepared ${packages.length} package tarballs at ${release.tag}; publishable=${release.publishable}. No publication occurred.`,
  );
}

/** @param {Awaited<ReturnType<typeof inspect>>} release @param {string} out */
async function publish(release, out) {
  requireValue(
    process.env.GITHUB_ACTIONS === "true" &&
      process.env.GITHUB_REPOSITORY === repository &&
      process.env.GITHUB_REF === "refs/heads/main" &&
      process.env.GITHUB_SHA === release.commit &&
      process.env.VEYRA_RELEASE_APPROVED === "true",
    "Publication requires the approved main-branch GitHub environment job.",
  );
  const bundle = await json(join(out, "release.json"));
  requireValue(
    bundle.schemaVersion === 1 &&
      bundle.repository === repository &&
      bundle.commit === release.commit &&
      bundle.tag === release.tag &&
      bundle.version === release.version &&
      bundle.distTag === release.distTag &&
      bundle.publishable === true,
    "Release bundle does not match the approved source/version.",
  );
  requireValue(
    Array.isArray(bundle.packages) && bundle.packages.length === release.packages.length,
    "Release bundle package set is invalid.",
  );
  // Validate the entire bundle before any irreversible registry operation.
  for (const [index, item] of release.packages.entries()) {
    const artifact = bundle.packages[index];
    const filename = `veyraoss-${item.name.split("/")[1]}-${release.version}.tgz`;
    requireValue(
      artifact.name === item.name &&
        artifact.filename === filename &&
        basename(filename) === filename,
      "Release bundle package order or filename is invalid.",
    );
    const path = join(out, filename);
    requireValue((await lstat(path)).isFile(), "Release tarballs must be regular files.");
    const bytes = await readFile(path);
    requireValue(
      artifact.integrity === `sha512-${hash(bytes, "sha512", "base64")}` &&
        artifact.sha256 === hash(bytes, "sha256", "hex"),
      "Release tarball digest does not match the reviewed bundle.",
    );
    const manifest = JSON.parse(await run("tar", ["-xOf", path, "package/package.json"]));
    requireValue(
      manifest.name === item.name &&
        manifest.version === release.version &&
        manifest.private !== true,
      "Packed package identity is invalid.",
    );
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      requireValue(
        typeof version === "string" && !/^(workspace:|link:|file:)/.test(version),
        "Packed production dependencies must be registry-installable.",
      );
      if (name.startsWith("@veyraoss/"))
        requireValue(
          release.packages.some((p) => p.name === name) && version === release.version,
          "Packed official dependencies must use the release version.",
        );
    }
  }
  for (const artifact of bundle.packages) {
    await run("npm", [
      "publish",
      join(out, artifact.filename),
      "--registry",
      registry,
      "--access",
      "public",
      "--provenance",
      "--tag",
      release.distTag,
      "--ignore-scripts",
    ]);
    const integrity = JSON.parse(
      await run("npm", [
        "view",
        `${artifact.name}@${release.version}`,
        "dist.integrity",
        "--json",
        "--registry",
        registry,
      ]),
    );
    requireValue(
      integrity === artifact.integrity,
      "Published registry integrity differs from the approved tarball; stop and investigate.",
    );
    console.log(`Verified publication of ${artifact.name}@${release.version}.`);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      tag: { type: "string" },
      "dist-tag": { type: "string" },
      out: { type: "string" },
      ready: { type: "boolean", default: false },
    },
  });
  const mode = positionals[0];
  requireValue(
    positionals.length === 1 &&
      typeof mode === "string" &&
      ["check", "pack", "publish"].includes(mode) &&
      values.tag &&
      values["dist-tag"],
    "Usage: release.mjs <check|pack|publish> --tag v<version> --dist-tag <latest|next> [--out /absolute/directory] [--ready]",
  );
  const release = await inspect(values.tag, values["dist-tag"], values.ready || mode === "publish");
  if (mode === "check")
    console.log(
      `Verified ${release.packages.length} package versions at ${release.tag}; publishable=${release.publishable}.`,
    );
  else {
    requireValue(
      values.out && isAbsolute(values.out),
      "A fresh absolute output directory is required for a release bundle.",
    );
    if (mode === "pack") await pack(release, resolve(values.out));
    else await publish(release, resolve(values.out));
  }
}

main().catch((error) => {
  console.error(
    error instanceof ReleaseError
      ? error.message
      : "Release preparation failed; check local files, arguments and tooling.",
  );
  process.exitCode = 1;
});
