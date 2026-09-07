import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import {
  LocalAgentRuntime,
  ProcessExecutionError,
  type ProcessRequest,
  runProcess,
} from "../src/index.js";

function node(script: string, options: Omit<ProcessRequest, "executable" | "args"> = {}) {
  return runProcess({ executable: process.execPath, args: ["-e", script], ...options });
}

afterEach(() => vi.unstubAllEnvs());

describe("local process runner", () => {
  it("writes UTF-8 stdin literally and closes it", async () => {
    const stdin = "A large prompt: $(not a command) 你好\n".repeat(1000);
    const result = await node(
      "process.stdin.setEncoding('utf8'); let text = ''; process.stdin.on('data', chunk => text += chunk); process.stdin.on('end', () => process.stdout.write(text));",
      { stdin },
    );
    expect(result.stdout).toBe(stdin);
    expect(result.exitCode).toBe(0);
  });

  it("rejects oversized stdin before spawning", async () => {
    await expect(node("", { stdin: "x".repeat(1024 * 1024 + 1) })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("handles a process that exits before consuming stdin", async () => {
    const result = await node("process.exit(4)", { stdin: "x".repeat(1024 * 1024) });
    expect(result.exitCode).toBe(4);
  });
  it("captures both streams and preserves arguments without shell evaluation", async () => {
    const values = ["spaces stay together", "$(echo unsafe); & |", '"quotes"', "你好"];
    const streamed: string[] = [];
    const result = await runProcess({
      executable: process.execPath,
      args: [
        "-e",
        "console.log(JSON.stringify(process.argv.slice(1))); console.error('diagnostic')",
        ...values,
      ],
      onStdout: (chunk) => {
        streamed.push(chunk);
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(JSON.parse(result.stdout)).toEqual(values);
    expect(result.stderr).toBe("diagnostic\n");
    expect(streamed.join("")).toBe(result.stdout);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.terminationReason).toBeUndefined();
  });

  it("returns nonzero exits as objective process results", async () => {
    const result = await node("console.error('failed'); process.exitCode = 7");
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toBe("failed\n");
  });

  it("uses an isolated working directory", async () => {
    await withFixtureWorkspace(async (workspace) => {
      await writeFile(join(workspace.path, "cwd-marker.txt"), "fixture");
      const result = await node(
        "console.log(require('node:fs').readFileSync('cwd-marker.txt', 'utf8'))",
        { cwd: workspace.path },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("fixture\n");
      expect(await readFile(join(workspace.path, "cwd-marker.txt"), "utf8")).toBe("fixture");
    });
  });

  it("inherits, overrides, and removes environment variables without mutating the parent", async () => {
    vi.stubEnv("VEYRA_RUNTIME_INHERITED", "kept");
    vi.stubEnv("VEYRA_RUNTIME_OVERRIDE", "parent");
    vi.stubEnv("VEYRA_RUNTIME_REMOVE", "removed");
    const result = await node(
      "console.log(JSON.stringify([process.env.VEYRA_RUNTIME_INHERITED, process.env.VEYRA_RUNTIME_OVERRIDE, process.env.VEYRA_RUNTIME_REMOVE ?? null]))",
      {
        env: { VEYRA_RUNTIME_OVERRIDE: "child", VEYRA_RUNTIME_REMOVE: undefined },
      },
    );
    expect(JSON.parse(result.stdout)).toEqual(["kept", "child", null]);
    expect(process.env.VEYRA_RUNTIME_OVERRIDE).toBe("parent");
    expect(process.env.VEYRA_RUNTIME_REMOVE).toBe("removed");
  });

  it("retains bounded prefixes while streaming all output", async () => {
    let stdout = "";
    let stderr = "";
    const result = await node(
      "process.stdout.write('a'.repeat(50000)); process.stderr.write('b'.repeat(50000))",
      {
        maxOutputBytes: 64,
        onStdout: (chunk) => {
          stdout += chunk;
        },
        onStderr: (chunk) => {
          stderr += chunk;
        },
      },
    );
    expect(result.stdout).toBe("a".repeat(64));
    expect(result.stderr).toBe("b".repeat(64));
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
    expect(stdout).toHaveLength(50000);
    expect(stderr).toHaveLength(50000);
  });

  it("decodes split UTF-8 chunks and omits an incomplete character at the retention boundary", async () => {
    let streamed = "";
    const result = await node(
      "const bytes = Buffer.from('你好吗'); process.stdout.write(bytes.subarray(0, 1)); setTimeout(() => process.stdout.write(bytes.subarray(1)), 30)",
      {
        maxOutputBytes: 4,
        onStdout: (chunk) => {
          streamed += chunk;
        },
      },
    );
    expect(streamed).toBe("你好吗");
    expect(result.stdout).toBe("你");
    expect(result.stdoutTruncated).toBe(true);
  });

  it("can disable retained output", async () => {
    const result = await node("console.log('output')", { maxOutputBytes: 0 });
    expect(result.stdout).toBe("");
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(false);
  });

  it("stops a process after its timeout", async () => {
    const result = await node("setInterval(() => {}, 1000)", {
      timeoutMs: 100,
      terminationGraceMs: 20,
    });
    expect(result.terminationReason).toBe("timeout");
    expect(result.exitCode).not.toBe(0);
    expect(result.durationMs).toBeLessThan(3000);
  });

  it("cancels after receiving live output and retains that output", async () => {
    const controller = new AbortController();
    const result = await node("console.log('ready'); setInterval(() => {}, 1000)", {
      signal: controller.signal,
      terminationGraceMs: 20,
      onStdout: () => controller.abort(),
    });
    expect(result.terminationReason).toBe("cancelled");
    expect(result.stdout).toBe("ready\n");
  });

  it("does not spawn an already-cancelled request", async () => {
    const result = await runProcess({
      executable: "veyra-nonexistent-executable",
      signal: AbortSignal.abort(),
    });
    expect(result.terminationReason).toBe("cancelled");
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toBe("");
  });

  it.skipIf(process.platform === "win32")("escalates a process that ignores SIGTERM", async () => {
    const controller = new AbortController();
    const result = await node(
      "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
      {
        signal: controller.signal,
        terminationGraceMs: 30,
        onStdout: () => controller.abort(),
      },
    );
    expect(result.signal).toBe("SIGKILL");
    expect(result.terminationReason).toBe("cancelled");
  });

  it.skipIf(process.platform === "win32")(
    "kills descendants even when their parent closes first",
    async () => {
      const controller = new AbortController();
      let descendantPid: number | undefined;
      const descendant =
        "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000)";
      const script = `const { spawn } = require('node:child_process'); process.on('SIGTERM', () => process.exit(0)); const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'pipe', 'ignore'] }); child.stdout.on('data', chunk => process.stdout.write(chunk));`;
      try {
        const result = await node(script, {
          signal: controller.signal,
          timeoutMs: 2000,
          terminationGraceMs: 40,
          onStdout: (chunk) => {
            descendantPid = Number(chunk.trim());
            controller.abort();
          },
        });
        expect(result.terminationReason).toBe("cancelled");
        expect(descendantPid).toBeGreaterThan(0);
        if (descendantPid) {
          // A terminated orphan can briefly remain a zombie awaiting the OS reaper.
          let state = "";
          try {
            state = execFileSync("ps", ["-o", "stat=", "-p", String(descendantPid)], {
              encoding: "utf8",
            }).trim();
          } catch {
            /* No such process is the expected other outcome. */
          }
          expect(state === "" || state.startsWith("Z")).toBe(true);
        }
      } finally {
        if (descendantPid) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {
            /* Already reaped. */
          }
        }
      }
    },
  );

  it("reports an unavailable executable with a typed error and empty output", async () => {
    const result = runProcess({ executable: `veyra-missing-${crypto.randomUUID()}` });
    await expect(result).rejects.toBeInstanceOf(ProcessExecutionError);
    await expect(result).rejects.toMatchObject({
      code: "executable_not_found",
      systemCode: "ENOENT",
      result: { exitCode: null, stdout: "", stderr: "" },
    });
  });

  it("distinguishes an invalid working directory from a missing executable", async () => {
    await expect(
      node("", { cwd: join(process.cwd(), `missing-${crypto.randomUUID()}`) }),
    ).rejects.toMatchObject({ code: "invalid_cwd", systemCode: "ENOENT" });
  });

  it.each([
    { timeoutMs: 0 },
    { timeoutMs: Infinity },
    { maxOutputBytes: -1 },
    { terminationGraceMs: 1.5 },
  ])("rejects invalid process limits %j", async (options) => {
    await expect(node("", options)).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("cleans up and rejects when an output callback fails", async () => {
    await expect(
      node("console.log('ready'); setInterval(() => {}, 1000)", {
        terminationGraceMs: 20,
        onStdout: () => {
          throw new Error("private callback detail");
        },
      }),
    ).rejects.toMatchObject({
      code: "output_callback_failed",
      message: "Process output callback failed.",
      result: { stdout: "ready\n" },
    });
  });
});

it("forwards ephemeral controls to adapters without changing persisted input", async () => {
  const runtime = new LocalAgentRuntime();
  const input = { runId: "run", stepId: "step", role: "executor", goal: "fixture" };
  const options = { cwd: process.cwd(), timeoutMs: 1000, signal: new AbortController().signal };
  const run = vi.fn(async () => ({ status: "success" as const, summary: "done" }));
  expect(await runtime.runAgent({ id: "fake", provider: "fake", run }, input, options)).toEqual({
    status: "success",
    summary: "done",
  });
  expect(run).toHaveBeenCalledWith(input, options);
  expect(input).not.toHaveProperty("signal");
});
