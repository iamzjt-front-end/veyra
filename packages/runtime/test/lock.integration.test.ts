import { readFile, readdir, writeFile, symlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { acquireLocalLock, runProcess } from "../src/index.js";

const moduleUrl = new URL("../src/index.ts", import.meta.url).href;

async function killedOwner(path: string, choosing = false) {
  const source = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
if (${choosing}) {
  const link = fs.promises.link;
  fs.promises.link = async (...args) => { await link(...args); process.kill(process.pid,'SIGKILL'); };
  syncBuiltinESMExports();
}
const { acquireLocalLock } = await import(${JSON.stringify(moduleUrl)});
await acquireLocalLock({directory:process.argv[1],holder:'fixture'});
process.kill(process.pid,'SIGKILL');`;
  const child = await runProcess({
    executable: process.execPath,
    args: ["--import", "tsx", "--input-type=module", "-e", source, path],
    timeoutMs: 30_000,
  });
  expect(child.signal, child.stderr).toBe("SIGKILL");
}

describe("local file coordination", { timeout: 30_000 }, () => {
  it("serializes independent participants in one process and releases exactly once", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      let count = 0;
      let active = 0;
      await Promise.all(
        Array.from({ length: 6 }, async () => {
          for (let index = 0; index < 6; index++) {
            const lock = await acquireLocalLock({
              directory: join(path, "lock"),
              holder: "fixture",
              waitMs: 10_000,
            });
            try {
              active++;
              expect(active).toBe(1);
              const previous = count;
              await delay(1);
              count = previous + 1;
            } finally {
              active--;
              await Promise.all([lock.release(), lock.release()]);
            }
          }
        }),
      );
      expect(count).toBe(36);
      expect(await readdir(join(path, "lock"))).toEqual([]);
    });
  });

  for (const stale of [false, true]) {
    it.skipIf(stale && process.platform === "win32")(
      `excludes independent processes without lost updates (stale recovery=${stale})`,
      async () => {
        await withFixtureWorkspace(async ({ path }) => {
          const directory = join(path, "lock");
          if (stale) await killedOwner(directory);
          await writeFile(join(path, "counter.txt"), "0");
          const source = `import {open,readFile,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {acquireLocalLock} from ${JSON.stringify(moduleUrl)};
const root=process.argv[1];
for(let i=0;i<8;i++) {
  const lock=await acquireLocalLock({directory:join(root,'lock'),holder:'fixture',waitMs:20000,recoverStale:${stale}});
  try {
    const marker=await open(join(root,'inside'),'wx'); await marker.close();
    const count=Number(await readFile(join(root,'counter.txt'),'utf8'));
    await delay(2);
    await writeFile(join(root,'counter.txt'),String(count+1));
    await unlink(join(root,'inside'));
  } finally { await lock.release(); }
}`;
          const results = await Promise.all(
            Array.from({ length: 4 }, () =>
              runProcess({
                executable: process.execPath,
                args: ["--import", "tsx", "--input-type=module", "-e", source, path],
                timeoutMs: 30_000,
              }),
            ),
          );
          for (const result of results) expect(result.exitCode, result.stderr).toBe(0);
          expect(await readFile(join(path, "counter.txt"), "utf8")).toBe("32");
          expect((await readdir(directory)).filter((name) => name.endsWith(".json"))).toEqual([]);
        });
      },
    );
  }

  it("does not steal a live lock based on age, even with recovery enabled", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const directory = join(path, "lock");
      const lock = await acquireLocalLock({ directory, holder: "fixture" });
      try {
        const name = (await readdir(directory))[0] as string;
        await utimes(join(directory, name), new Date(0), new Date(0));
        await expect(
          acquireLocalLock({ directory, holder: "fixture", recoverStale: true, waitMs: 20 }),
        ).rejects.toMatchObject({ code: "lock_timeout" });
        expect(await readdir(directory)).toEqual([name]);
      } finally {
        await lock.release();
      }
    });
  });

  it.skipIf(process.platform === "win32").each([false, true])(
    "recovers a dead published owner only explicitly (choosing=%s)",
    async (choosing) => {
      await withFixtureWorkspace(async ({ path }) => {
        const directory = join(path, "lock");
        await killedOwner(directory, choosing);
        await expect(acquireLocalLock({ directory, holder: "fixture" })).rejects.toMatchObject({
          code: "lock_busy",
        });
        await expect(
          acquireLocalLock({ directory, holder: "other", recoverStale: true }),
        ).rejects.toMatchObject({ code: "lock_busy" });
        const lock = await acquireLocalLock({ directory, holder: "fixture", recoverStale: true });
        await lock.release();
        expect((await readdir(directory)).filter((name) => name.endsWith(".json"))).toEqual([]);
      });
    },
  );

  it.each(["foreign", "malformed", "overflow"])(
    "preserves %s ownership evidence",
    async (fault) => {
      await withFixtureWorkspace(async ({ path }) => {
        const directory = join(path, "lock");
        const lock = await acquireLocalLock({ directory, holder: "fixture" });
        const file = join(directory, (await readdir(directory))[0] as string);
        const original = await readFile(file, "utf8");
        const value = JSON.parse(original);
        if (fault === "foreign") value.owner.host = "fixture-other-host";
        if (fault === "overflow") value.number = Number.MAX_SAFE_INTEGER;
        const changed = fault === "malformed" ? '{"owner":' : JSON.stringify(value);
        await writeFile(file, changed);
        try {
          await expect(
            acquireLocalLock({ directory, holder: "fixture", recoverStale: true }),
          ).rejects.toMatchObject({ code: fault === "foreign" ? "lock_busy" : "invalid_lock" });
          expect(await readFile(file, "utf8")).toBe(changed);
        } finally {
          await writeFile(file, original);
          await lock.release();
        }
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses symlinked scopes and records without touching their targets",
    async () => {
      await withFixtureWorkspace(async ({ path }) => {
        const directory = join(path, "lock");
        const lock = await acquireLocalLock({ directory, holder: "fixture" });
        const alias = join(path, "alias");
        await symlink(directory, alias);
        await expect(
          acquireLocalLock({ directory: alias, holder: "fixture" }),
        ).rejects.toMatchObject({ code: "invalid_lock" });
        const target = join(path, "unrelated.json");
        await writeFile(target, "preserve");
        await symlink(target, join(directory, "linked.json"));
        try {
          await expect(acquireLocalLock({ directory, holder: "fixture" })).rejects.toMatchObject({
            code: "invalid_lock",
          });
          expect(await readFile(target, "utf8")).toBe("preserve");
        } finally {
          await lock.release();
        }
      });
    },
  );
});
