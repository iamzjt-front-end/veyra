import { hostname } from "node:os";

/** Local process metadata, never evidence of filesystem or external-effect completion. */
export interface ProcessOwner {
  pid: number;
  host: string;
  startedAt: string;
}

export type ProcessLiveness = "alive" | "dead" | "unknown";

export function currentProcessOwner(): ProcessOwner {
  return {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  };
}

export function isProcessOwner(value: unknown): value is ProcessOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  return (
    Object.keys(owner).length === 3 &&
    Number.isSafeInteger(owner.pid) &&
    (owner.pid as number) > 0 &&
    (owner.pid as number) <= 2_147_483_647 &&
    typeof owner.host === "string" &&
    owner.host.length > 0 &&
    owner.host.length <= 1024 &&
    !owner.host.includes("\0") &&
    typeof owner.startedAt === "string" &&
    /^\d{4}-\d\d-\d\dT/.test(owner.startedAt) &&
    Number.isFinite(Date.parse(owner.startedAt))
  );
}

/** Signal zero only. PID reuse is conservatively alive; foreign/denied probes are unknown. */
export function inspectProcessOwner(owner?: ProcessOwner): ProcessLiveness {
  if (!isProcessOwner(owner) || owner.host !== hostname()) return "unknown";
  try {
    process.kill(owner.pid, 0);
    return "alive";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
}
