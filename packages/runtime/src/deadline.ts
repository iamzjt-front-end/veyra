/** A cooperative deadline: signal active work, then let the owner drain it before disposal. */
export function createDeadline(
  timeoutMs?: number,
  signal?: AbortSignal,
): {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
} {
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000)
  )
    throw new Error("Execution deadline must be an integer from 1 to 86400000 milliseconds.");
  const controller = new AbortController();
  let expired = false;
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          expired = true;
          abort();
        }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => expired,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    },
  };
}
