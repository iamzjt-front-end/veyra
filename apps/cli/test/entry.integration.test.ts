import { createRequire } from "node:module";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "@veyra/runtime";
import { describe, expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const tsx = createRequire(import.meta.url).resolve("tsx");
describe("public CLI process", () => {
  // Four fresh Node/tsx processes can exceed Vitest's 5s default on a shared CI runner.
  it(
    "initializes, executes and inspects a real command-only project",
    { timeout: 60_000 },
    async () => {
      await withFixtureWorkspace(async ({ path }) => {
        const ve = (args: string[]) =>
          runProcess({
            executable: process.execPath,
            args: ["--import", tsx, entry, ...args],
            cwd: path,
            timeoutMs: 30_000,
          });
        const initialized = await ve(["init", "--json"]);
        expect(initialized.exitCode, initialized.stderr).toBe(0);
        expect(await readFile(join(path, "veyra.yaml"), "utf8")).toContain("provider: codex");
        await writeFile(
          join(path, "veyra.yaml"),
          JSON.stringify({ version: 1, agents: {}, workflow: { use: "./workflow.yaml" } }),
        );
        await writeFile(
          join(path, "workflow.yaml"),
          JSON.stringify({
            name: "CLI process fixture",
            version: 1,
            start: "verify",
            steps: { verify: { type: "command", run: ["node --test"] } },
          }),
        );
        const run = await ve(["run", "check fixture", "--json", "--non-interactive"]);
        expect(run.exitCode, run.stdout + run.stderr).toBe(0);
        const records = run.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(records.at(-1)).toMatchObject({ type: "result", status: "completed" });
        const status = await ve(["status", "--json"]);
        expect(status.exitCode).toBe(0);
        expect(JSON.parse(status.stdout)).toMatchObject({ status: "completed" });
        expect(await realpath(JSON.parse(status.stdout).cwd)).toBe(await realpath(path));
        const review = await ve(["review", "--json"]);
        expect(review.exitCode).toBe(0);
        expect(JSON.parse(review.stdout)).toMatchObject({
          review: null,
          verification: { success: true },
        });
      });
    },
  );
});
