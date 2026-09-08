import type { ProcessRunner } from "@veyra/runtime";
import { afterEach, expect, it, vi } from "vitest";
import { ShellVerifier } from "../src/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([
  { platform: "darwin", comSpec: "ignored.exe", executable: "/bin/sh", prefix: ["-c"] },
  { platform: "linux", comSpec: "ignored.exe", executable: "/bin/sh", prefix: ["-c"] },
  {
    platform: "win32",
    comSpec: "C:\\Windows With Spaces\\System32\\cmd.exe",
    executable: "C:\\Windows With Spaces\\System32\\cmd.exe",
    prefix: ["/d", "/s", "/c"],
  },
  { platform: "win32", comSpec: undefined, executable: "cmd.exe", prefix: ["/d", "/s", "/c"] },
])("selects the documented shell for $platform ($comSpec)", async (fixture) => {
  vi.stubEnv("ComSpec", fixture.comSpec);
  vi.stubEnv("SHELL", "/unavailable/interactive-shell");
  vi.stubGlobal(
    "process",
    new Proxy(process, {
      get(target, key) {
        return key === "platform" ? fixture.platform : Reflect.get(target, key);
      },
    }),
  );
  const run = vi.fn<ProcessRunner>(async () => ({
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 0,
  }));
  const command = 'echo "literal 你好" && echo second';
  const cwd = "fixture directory";
  const env = { VEYRA_PLATFORM_VALUE: "literal argument" };
  await new ShellVerifier({ runProcess: run }).verify({ commands: [command], cwd, env });
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({
      executable: fixture.executable,
      args: [...fixture.prefix, command],
      cwd,
      env,
    }),
  );
});
