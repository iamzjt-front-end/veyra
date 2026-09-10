import { describe, expect, it, vi } from "vitest";
import type { ProcessRunner } from "@veyraoss/runtime";
import { nativeHostEnvironment } from "../src/native-environment.js";

const system = `<dictionary> {
  ExceptionsList : <array> {
    0 : 192.168.0.0/16
    1 : *.example.test
    2 : localhost
  }
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
}`;
function runner(stdout = system) {
  return vi.fn<ProcessRunner>(async () => ({
    stdout,
    stderr: "",
    exitCode: 0,
    signal: null,
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
  }));
}
describe("Finder-launched native host network environment", () => {
  it("reuses enabled macOS static proxies without editing the caller environment or credentials", async () => {
    const runProcess = runner();
    const env = { PATH: "/usr/bin", NO_PROXY: "internal.test", no_proxy: "other.test" };
    const result = await nativeHostEnvironment(env, { platform: "darwin", runProcess });
    expect(result).toEqual({
      PATH: env.PATH,
      HTTP_PROXY: "http://127.0.0.1:7897",
      http_proxy: "http://127.0.0.1:7897",
      HTTPS_PROXY: "http://127.0.0.1:7897",
      https_proxy: "http://127.0.0.1:7897",
      NO_PROXY: "internal.test,other.test,localhost,127.0.0.1,::1,192.168.0.0/16,.example.test",
      no_proxy: "internal.test,other.test,localhost,127.0.0.1,::1,192.168.0.0/16,.example.test",
    });
    expect(env).toEqual({ PATH: "/usr/bin", NO_PROXY: "internal.test", no_proxy: "other.test" });
    expect(runProcess).toHaveBeenCalledExactlyOnceWith({
      executable: "/usr/sbin/scutil",
      args: ["--proxy"],
      timeoutMs: 2000,
      maxOutputBytes: 16384,
    });
  });
  it.each([
    { HTTPS_PROXY: "http://chosen.test:8080" },
    { http_proxy: "http://chosen.test:8080" },
    { ALL_PROXY: "socks5://chosen.test:1080" },
    { https_proxy: "" },
    { NO_PROXY: "*" },
  ])("preserves explicit native proxy choices %j without a system probe", async (env) => {
    const runProcess = runner();
    expect(await nativeHostEnvironment(env, { platform: "darwin", runProcess })).toEqual(env);
    expect(runProcess).not.toHaveBeenCalled();
  });
  it("does not probe macOS settings on other platforms", async () => {
    const runProcess = runner();
    expect(await nativeHostEnvironment({}, { platform: "linux", runProcess })).toEqual({});
    expect(runProcess).not.toHaveBeenCalled();
  });
  it.each([
    "pac",
    "autodiscovery",
    "disabled",
    "credentials",
    "bad-port",
    "duplicate",
    "not-dictionary",
  ])("does not turn %s configuration into a proxy or executable request", async (mode) => {
    let value = system;
    if (mode === "pac")
      value = value.replace("ProxyAutoConfigEnable : 0", "ProxyAutoConfigEnable : 1");
    if (mode === "autodiscovery")
      value = value.replace("ProxyAutoConfigEnable : 0", "ProxyAutoDiscoveryEnable : 1");
    if (mode === "disabled") value = value.replaceAll("Enable : 1", "Enable : 0");
    if (mode === "credentials")
      value = value.replaceAll("Proxy : 127.0.0.1", "Proxy : user:secret@proxy.test/path");
    if (mode === "bad-port") value = value.replaceAll("Port : 7897", "Port : 65536");
    if (mode === "duplicate")
      value = value.replace(/\n\}$/, "\n  HTTPPort : 1234\n  HTTPSPort : 1234\n}");
    if (mode === "not-dictionary") value = "scutil is unavailable";
    const runProcess = runner(value);
    const result = await nativeHostEnvironment({}, { platform: "darwin", runProcess });
    expect(result).toEqual({});
    expect(runProcess).toHaveBeenCalledTimes(1);
  });
  it("supports IPv6 addresses and ignores malformed bypass entries", async () => {
    const runProcess = runner(
      system
        .replaceAll("Proxy : 127.0.0.1", "Proxy : ::1")
        .replace("*.example.test", "user@host/path"),
    );
    const env = await nativeHostEnvironment({}, { platform: "darwin", runProcess });
    expect(env.HTTPS_PROXY).toBe("http://[::1]:7897");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1,192.168.0.0/16");
  });
  it.each(["failed", "timeout", "truncated", "unavailable"])(
    "bounds a %s system probe",
    async (mode) => {
      const runProcess = runner();
      if (mode === "unavailable") runProcess.mockRejectedValue(new Error("unavailable"));
      else
        runProcess.mockResolvedValue({
          stdout: system,
          stderr: "",
          exitCode: mode === "failed" ? 1 : 0,
          signal: null,
          stdoutTruncated: mode === "truncated",
          stderrTruncated: false,
          durationMs: 1,
          ...(mode === "timeout" ? { terminationReason: "timeout" as const } : {}),
        });
      expect(
        await nativeHostEnvironment({ PATH: "/bin" }, { platform: "darwin", runProcess }),
      ).toEqual({ PATH: "/bin" });
    },
  );
});
