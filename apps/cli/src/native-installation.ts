import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAdapter } from "@veyraoss/codex";
import { ProjectRegistry } from "@veyraoss/project";
import { acquireLocalLock, type ProcessRunner } from "@veyraoss/runtime";

export const NATIVE_HOST = "com.veyraoss.bridge";
export const BROWSER_ORIGIN = "chrome-extension://meibodpmcjcjdpfaaejdpiclijnpcclh";
export interface Installation {
  version: 1;
  id: string;
  registryRoot: string;
  executable?: string;
  grants: Record<string, { root: string; expiresAt: number }>;
  extensionSeenAt?: number;
}
export async function privateRead(path: string): Promise<string | undefined> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o077 ||
        stat.size > 65536
      )
        throw new Error("Unsafe local bridge file; preserve it for inspection.");
      const buffer = Buffer.alloc(65537);
      let size = 0;
      while (size < buffer.length) {
        const read = await file.read(buffer, size, buffer.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size > 65536) throw new Error("Local bridge file exceeds limit.");
      return buffer.subarray(0, size).toString("utf8");
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        await lstat(path);
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === "ENOENT") return;
      }
    }
    throw error;
  }
}
export async function privateWrite(path: string, source: string) {
  if (Buffer.byteLength(source) > 65536) throw new Error("Local bridge file exceeds limit.");
  await privateRead(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(source);
    await file.sync();
    await file.close();
    await rename(temporary, path);
  } finally {
    await file.close();
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
export async function readInstallation(path: string): Promise<Installation> {
  const source = await privateRead(path);
  if (!source) throw new Error("Veyra is not set up. Run ve setup once.");
  const value = JSON.parse(source) as Installation;
  if (
    value.version !== 1 ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    !isAbsolute(value.registryRoot) ||
    !value.grants ||
    typeof value.grants !== "object" ||
    Array.isArray(value.grants) ||
    Object.keys(value.grants).length > 100 ||
    Object.entries(value.grants).some(
      ([id, grant]) =>
        !/^[a-f0-9-]{36}$/.test(id) ||
        !grant ||
        !isAbsolute(grant.root) ||
        !Number.isFinite(grant.expiresAt),
    )
  )
    throw new Error("Invalid Veyra installation; run ve setup after inspecting its diagnostics.");
  return value;
}
export async function detectCodex(env: NodeJS.ProcessEnv = process.env) {
  const candidates = [
    ...(env.PATH ?? "")
      .split(":")
      .filter(isAbsolute)
      .map((dir) => join(dir, "codex")),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    join(homedir(), "Applications/Codex.app/Contents/Resources/codex"),
    join(homedir(), "Applications/ChatGPT.app/Contents/Resources/codex"),
  ];
  for (const path of new Set(candidates)) {
    try {
      await access(path, constants.X_OK);
      const target = await realpath(path);
      if ((await lstat(target)).isFile()) return target;
    } catch {
      /* Try the next known executable, never scan user files. */
    }
  }
  return undefined;
}
export function builtEntry(name: string) {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here.endsWith("/src") ? resolve(here, "../dist") : here, name);
}
export function manifestDirectories(home: string, platform = process.platform) {
  if (platform === "darwin")
    return ["Google/Chrome", "Chromium", "Google/ChromeForTesting"].map((name) =>
      join(home, "Library/Application Support", name, "NativeMessagingHosts"),
    );
  if (platform === "linux")
    return ["google-chrome", "chromium", "google-chrome-for-testing"].map((name) =>
      join(home, ".config", name, "NativeMessagingHosts"),
    );
  throw new Error("Native bridge setup currently supports macOS and Linux.");
}
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
export async function setupNative(
  options: {
    home?: string;
    registryRoot?: string;
    env?: NodeJS.ProcessEnv;
    runProcess?: ProcessRunner;
    manifestDirs?: string[];
    entry?: string;
    revoke?: boolean;
  } = {},
) {
  const registryRoot = new ProjectRegistry(
    options.registryRoot ? { root: options.registryRoot } : {},
  ).root;
  await mkdir(registryRoot, { recursive: true, mode: 0o700 });
  const registryStat = await lstat(registryRoot);
  if (
    !registryStat.isDirectory() ||
    registryStat.isSymbolicLink() ||
    registryStat.uid !== process.getuid?.() ||
    registryStat.mode & 0o022
  )
    throw new Error("Unsafe registry root for native installation.");
  const directory = join(registryRoot, "browser");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077
  )
    throw new Error("Bridge directory must be private and owned by this user.");
  const statePath = join(directory, "installation.json");
  const previous = (await privateRead(statePath)) ? await readInstallation(statePath) : undefined;
  if (previous && previous.registryRoot !== registryRoot)
    throw new Error("Installation registry changed; refusing replacement.");
  const env = options.env ?? process.env;
  const executable = await detectCodex(env);
  const readiness = await new CodexAdapter(
    { executable: executable ?? "codex" },
    { env, runProcess: options.runProcess },
  ).doctor({ cwd: registryRoot, timeoutMs: 5000 });
  const state: Installation = {
    version: 1,
    id: options.revoke ? randomUUID() : (previous?.id ?? randomUUID()),
    registryRoot,
    executable,
    grants: options.revoke ? {} : (previous?.grants ?? {}),
    ...(!options.revoke && previous?.extensionSeenAt
      ? { extensionSeenAt: previous.extensionSeenAt }
      : {}),
  };
  const entry = options.entry ?? builtEntry("native-host.js");
  await access(entry);
  const launcher = join(directory, "native-host");
  const launcherText = `#!/bin/sh\n# Veyra owned native messaging launcher v1\nexec ${quote(process.execPath)} ${quote(entry)} ${quote(statePath)} "$@"\n`;
  const oldLauncher = await privateRead(launcher);
  if (
    oldLauncher &&
    !oldLauncher.startsWith("#!/bin/sh\n# Veyra owned native messaging launcher v1\n")
  )
    throw new Error("Refusing to replace an unrelated native launcher.");
  const manifests = (options.manifestDirs ?? manifestDirectories(options.home ?? homedir())).map(
    (dir) => join(dir, `${NATIVE_HOST}.json`),
  );
  const manifest = JSON.stringify(
    {
      name: NATIVE_HOST,
      description: "Veyra local Project bridge",
      path: launcher,
      type: "stdio",
      allowed_origins: [`${BROWSER_ORIGIN}/`],
    },
    null,
    2,
  );
  // Preflight every destination before changing any owned installation file.
  for (const path of manifests) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const parent = await lstat(dirname(path));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== process.getuid?.() ||
      parent.mode & 0o022
    )
      throw new Error("Unsafe browser manifest directory.");
    const source = await privateRead(path);
    if (
      source &&
      (JSON.parse(source).path !== launcher ||
        JSON.parse(source).name !== NATIVE_HOST ||
        JSON.stringify(JSON.parse(source).allowed_origins) !==
          JSON.stringify([`${BROWSER_ORIGIN}/`]) ||
        JSON.parse(source).type !== "stdio")
    )
      throw new Error("Refusing to overwrite another native messaging installation.");
  }
  const lock = await acquireLocalLock({
    directory: join(directory, ".grant-lock"),
    holder: "veyra-native-setup",
    waitMs: 5000,
    recoverStale: true,
  });
  try {
    const latest = (await privateRead(statePath)) ? await readInstallation(statePath) : undefined;
    if (latest && latest.registryRoot !== registryRoot)
      throw new Error("Installation registry changed during setup.");
    if (!options.revoke && latest) {
      state.id = latest.id;
      state.grants = latest.grants;
      state.extensionSeenAt = latest.extensionSeenAt;
    }
    await privateWrite(statePath, JSON.stringify(state));
    await privateWrite(launcher, launcherText);
    await chmod(launcher, 0o700);
    for (const path of manifests) await privateWrite(path, manifest);
  } finally {
    await lock.release();
  }
  return {
    native: readiness,
    extension: state.extensionSeenAt ? "previously-connected" : "awaiting-extension",
    extensionSeenAt: state.extensionSeenAt,
    extensionDirectory: builtEntry("browser-extension"),
    manifests,
    installationId: state.id,
    statePath,
  };
}
