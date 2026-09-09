import { spawn } from "node:child_process";
import { join } from "node:path";
import { acquireLocalLock } from "@veyraoss/runtime";
import { builtEntry, privateRead, readInstallation } from "./native-installation.js";
export interface ControlMetadata {
  version: 1;
  id: string;
  installationId: string;
  pid: number;
  origin: string;
  launcherKey: string;
}
export async function readControlMetadata(path: string): Promise<ControlMetadata | undefined> {
  const text = await privateRead(path);
  if (!text) return;
  const value = JSON.parse(text) as ControlMetadata;
  if (
    value.version !== 1 ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    !/^[a-f0-9-]{36}$/.test(value.installationId) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(value.origin) ||
    !/^[a-f0-9]{64}$/.test(value.launcherKey)
  )
    throw new Error("Invalid local GUI metadata. Inspect it without overwriting it.");
  return value;
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
export async function openControlCenter(
  statePath: string,
  target: { projectId?: string; runId?: string } = {},
) {
  const installation = await readInstallation(statePath);
  const path = join(installation.registryRoot, "browser", "control.json");
  const lock = await acquireLocalLock({
    directory: join(installation.registryRoot, "browser", ".control-launch-lock"),
    holder: "veyra-control-center",
    waitMs: 10000,
    recoverStale: true,
  });
  try {
    let metadata = await readControlMetadata(path);
    if (metadata && metadata.installationId !== installation.id && alive(metadata.pid))
      throw new Error(
        "Local authorization changed. Close the previous Veyra Control Center first.",
      );
    if (!metadata || !alive(metadata.pid)) {
      const child = spawn(process.execPath, [builtEntry("control-center-entry.js"), statePath], {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
      for (let attempt = 0; attempt < 80; attempt++) {
        metadata = await readControlMetadata(path);
        if (metadata && metadata.pid === child.pid && metadata.installationId === installation.id)
          break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!metadata || metadata.pid !== child.pid)
        throw new Error(
          "Veyra could not open its Control Center. Run ve doctor for local diagnostics.",
        );
    }
    const response = await fetch(`${metadata.origin}/launch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${metadata.launcherKey}`,
      },
      body: JSON.stringify(target),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    const data = (await response.json()) as { url?: string };
    if (!response.ok || !data.url?.startsWith(`${metadata.origin}/#bootstrap=`))
      throw new Error("The local GUI invitation was not confirmed. Reopen Veyra to retry.");
    return { url: data.url, pid: metadata.pid };
  } finally {
    await lock.release();
  }
}
