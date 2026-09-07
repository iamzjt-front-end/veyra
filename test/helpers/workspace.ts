import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(new URL("../fixtures/minimal-project/", import.meta.url));

export interface FixtureWorkspace {
  readonly path: string;
  cleanup(): Promise<void>;
}

export async function createFixtureWorkspace(): Promise<FixtureWorkspace> {
  const path = await mkdtemp(join(tmpdir(), "veyra-test-"));
  const cleanup = () => rm(path, { recursive: true, force: true });

  try {
    await cp(fixturePath, path, { recursive: true });
    return { path, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function withFixtureWorkspace<T>(
  run: (workspace: FixtureWorkspace) => Promise<T>,
): Promise<T> {
  const workspace = await createFixtureWorkspace();
  try {
    return await run(workspace);
  } finally {
    await workspace.cleanup();
  }
}
