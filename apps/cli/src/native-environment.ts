import { isIP } from "node:net";
import { runProcess, type ProcessRunner } from "@veyraoss/runtime";

const proxyKeys = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
];
const loopback = ["localhost", "127.0.0.1", "::1"];

function hostname(value: string): boolean {
  return (
    isIP(value) !== 0 ||
    (value.length <= 253 &&
      value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)))
  );
}

/** Parse only scutil's static, unauthenticated proxy addresses. Never evaluate PAC or read credentials. */
function staticProxies(output: string): NodeJS.ProcessEnv {
  if (!output.startsWith("<dictionary> {") || !output.trimEnd().endsWith("}")) return {};
  const scalar = (key: string) => {
    const values = [...output.matchAll(new RegExp(`^  ${key} : ([^\\r\\n]+)\\r?$`, "gm"))];
    return values.length === 1 ? values[0]?.[1]?.trim() : undefined;
  };
  if (scalar("ProxyAutoConfigEnable") === "1" || scalar("ProxyAutoDiscoveryEnable") === "1")
    return {};
  const proxies: NodeJS.ProcessEnv = {};
  for (const protocol of ["HTTP", "HTTPS"] as const) {
    if (scalar(`${protocol}Enable`) !== "1") continue;
    const host = scalar(`${protocol}Proxy`) ?? "";
    const rawPort = scalar(`${protocol}Port`) ?? "";
    const port = Number(rawPort);
    if (!hostname(host) || !/^\d{1,5}$/.test(rawPort) || port < 1 || port > 65535) continue;
    const address = `http://${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
    proxies[`${protocol}_PROXY`] = address;
    proxies[`${protocol.toLowerCase()}_proxy`] = address;
  }
  if (!Object.keys(proxies).length) return {};
  const exceptions =
    /\n {2}ExceptionsList : <array> \{\r?\n([\s\S]*?)\n {2}\}/.exec(output)?.[1] ?? "";
  const bypass = exceptions
    .split(/\r?\n/)
    .map((line) => /^ {4}\d+ : (\S+)$/.exec(line)?.[1] ?? "")
    .filter((entry) => {
      if (hostname(entry.replace(/^\*\./, ""))) return true;
      const [address, bits, extra] = entry.split("/");
      const family = isIP(address ?? "");
      return (
        extra === undefined &&
        family !== 0 &&
        /^\d{1,3}$/.test(bits ?? "") &&
        Number(bits) <= (family === 4 ? 32 : 128)
      );
    })
    .map((entry) => entry.replace(/^\*\./, "."));
  proxies.NO_PROXY = [...new Set([...loopback, ...bypass])].join(",");
  proxies.no_proxy = proxies.NO_PROXY;
  return proxies;
}

/** Finder-launched Chrome does not inherit shell proxy variables. Keep recovery local to this host. */
export async function nativeHostEnvironment(
  env: NodeJS.ProcessEnv,
  dependencies: { platform?: NodeJS.Platform; runProcess?: ProcessRunner } = {},
): Promise<NodeJS.ProcessEnv> {
  const resolved = { ...env };
  if (
    (dependencies.platform ?? process.platform) !== "darwin" ||
    proxyKeys.some((key) => env[key] !== undefined) ||
    [env.NO_PROXY, env.no_proxy].some((value) =>
      value?.split(",").some((part) => part.trim() === "*"),
    )
  )
    return resolved;
  try {
    const result = await (dependencies.runProcess ?? runProcess)({
      executable: "/usr/sbin/scutil",
      args: ["--proxy"],
      timeoutMs: 2000,
      maxOutputBytes: 16 * 1024,
    });
    if (
      result.exitCode !== 0 ||
      result.signal ||
      result.terminationReason ||
      result.stdoutTruncated
    )
      return resolved;
    const proxies = staticProxies(result.stdout);
    if (!proxies.NO_PROXY) return resolved;
    proxies.NO_PROXY = [
      ...new Set([
        ...(env.NO_PROXY?.split(",") ?? []),
        ...(env.no_proxy?.split(",") ?? []),
        proxies.NO_PROXY,
      ]),
    ]
      .filter(Boolean)
      .join(",");
    proxies.no_proxy = proxies.NO_PROXY;
    return { ...resolved, ...proxies };
  } catch {
    // An unsupported/failed system probe cannot overwrite native configuration or prompt for secrets.
    return resolved;
  }
}
