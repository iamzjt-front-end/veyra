/** Bound response consumption as well as fetch; never leave a stalled body after abort. */
export async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error("Missing response body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) {
      cancel();
      throw new Error("Response aborted.");
    }
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error("Response aborted.");
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 512 * 1024) {
        await reader.cancel();
        throw new Error("Response exceeds 512 KiB.");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
