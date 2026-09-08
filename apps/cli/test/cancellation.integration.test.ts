import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "@veyra/runtime";
import { describe, expect, it, vi } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const tsx = createRequire(import.meta.url).resolve("tsx");
const stopped = (pid: number) => {
  let state = "";
  try {
    state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch (error) {
    if ((error as { status?: number }).status !== 1) throw error;
  }
  return state === "" || state.startsWith("Z");
};

describe.skipIf(process.platform === "win32")(
  "CLI cancellation and process trees",
  { timeout: 30_000 },
  () => {
    it.each([
      { signal: "SIGINT", repeated: "SIGINT", exitCode: 130 },
      { signal: "SIGTERM", repeated: "SIGTERM", exitCode: 143 },
      { signal: "SIGINT", repeated: "SIGTERM", exitCode: 130 },
    ] as const)(
      "drains descendants after $signal and repeated $repeated signals",
      async ({ signal, repeated, exitCode }) => {
        await withFixtureWorkspace(async ({ path }) => {
          await writeFile(
            join(path, "veyra.yaml"),
            JSON.stringify({ version: 1, agents: {}, workflow: { use: "./workflow.yaml" } }),
          );
          await writeFile(
            join(path, "workflow.yaml"),
            JSON.stringify({
              version: 1,
              name: "cancel",
              start: "work",
              steps: {
                work: { type: "command", run: ["node worker.cjs", "node must-not-run.cjs"] },
              },
            }),
          );
          await writeFile(
            join(path, "must-not-run.cjs"),
            "require('node:fs').writeFileSync('unexpected','ran');",
          );
          await writeFile(
            join(path, "pid.mjs"),
            // Keep the exit/drain window open so repeated signals exercise it on every host.
            "import {writeFileSync} from 'node:fs';writeFileSync('cli.pid',String(process.pid));process.once('beforeExit',()=>{writeFileSync('cli-draining','ready');setTimeout(()=>{},1000);});",
          );
          const descendant =
            "const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync('tree.json',JSON.stringify([process.ppid,process.pid]));setInterval(()=>{},1000);";
          await writeFile(
            join(path, "worker.cjs"),
            `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000);`,
          );
          const emergency = new AbortController();
          const running = runProcess({
            executable: process.execPath,
            args: [
              "--import",
              join(path, "pid.mjs"),
              "--import",
              tsx,
              entry,
              "run",
              "Cancel fixture",
              "--json",
            ],
            cwd: path,
            timeoutMs: 15_000,
            signal: emergency.signal,
          });
          let cliPid = 0;
          let pids: number[] = [];
          let repeats: ReturnType<typeof setInterval> | undefined;
          try {
            await vi.waitFor(
              async () => {
                cliPid = Number(await readFile(join(path, "cli.pid"), "utf8"));
                pids = JSON.parse(await readFile(join(path, "tree.json"), "utf8"));
                expect(pids).toHaveLength(2);
                expect(pids.every((pid) => Number.isInteger(pid) && pid > 0)).toBe(true);
              },
              { interval: 10, timeout: 10_000 },
            );
            let sent = 1;
            process.kill(cliPid, signal);
            repeats = setInterval(() => {
              try {
                process.kill(cliPid, repeated);
                sent++;
              } catch (error) {
                expect((error as NodeJS.ErrnoException).code, "Fixture interrupt").toBe("ESRCH");
              }
            }, 20);
            await vi.waitFor(
              async () => expect(await readFile(join(path, "cli-draining"), "utf8")).toBe("ready"),
              { interval: 10, timeout: 10_000 },
            );
            // Exercise post-result draining, then stop before Node tears down its native handlers.
            clearInterval(repeats);
            process.kill(cliPid, repeated);
            sent++;
            const result = await running;
            clearInterval(repeats);
            expect(sent).toBeGreaterThan(1);
            expect(result.exitCode, JSON.stringify(result)).toBe(exitCode);
            expect(result.signal).toBeNull();
            expect(result.terminationReason).toBeUndefined();
            expect(pids.every(stopped)).toBe(true);
            const events = result.stdout
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
            const final = events.at(-1);
            expect(final).toMatchObject({
              type: "result",
              status: "failed",
              error: { code: "run_cancelled" },
            });
            expect(events.filter((event) => event.type === "run.failed")).toHaveLength(1);
            expect(
              JSON.parse(
                await readFile(join(path, ".veyra", "runs", final.runId, "state.json"), "utf8"),
              ),
            ).toMatchObject({ status: "failed", error: final.error });
            await expect(readFile(join(path, "unexpected"))).rejects.toMatchObject({
              code: "ENOENT",
            });
            const status = await runProcess({
              executable: process.execPath,
              args: ["--import", tsx, entry, "status"],
              cwd: path,
              timeoutMs: 15_000,
            });
            expect(status.exitCode, status.stderr).toBe(0);
            expect(status.stdout).toContain("Error: run_cancelled");
          } finally {
            clearInterval(repeats);
            emergency.abort();
            await running;
            // Only fixture PIDs are eligible for emergency cleanup after a failing assertion.
            for (const pid of pids) {
              if (stopped(pid)) continue;
              try {
                process.kill(pid, "SIGKILL");
              } catch (error) {
                expect((error as NodeJS.ErrnoException).code, "Scoped fixture cleanup").toBe(
                  "ESRCH",
                );
              }
            }
          }
        });
      },
    );
  },
);
