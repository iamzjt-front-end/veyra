import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectInstruction } from "@veyraoss/protocol";

/** Snapshot only the execution root's explicit project rule file; never traverse ancestors/includes. */
export async function readProjectInstructions(cwd: string): Promise<ProjectInstruction[]> {
  const path = join(cwd, "AGENTS.md");
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Cannot inspect project instructions: ${path}`);
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 32768)
    throw new Error(`Project instructions must be a regular file of at most 32 KiB: ${path}`);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.ino !== info.ino || current.dev !== info.dev)
      throw new Error(`Project instruction file changed during inspection: ${path}`);
    const buffer = Buffer.alloc(32769);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > 32768) throw new Error(`Project instructions exceed 32 KiB: ${path}`);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
    } catch {
      throw new Error(`Project instructions must be UTF-8: ${path}`);
    }
    return [{ source: "AGENTS.md", text }];
  } finally {
    await handle.close();
  }
}
