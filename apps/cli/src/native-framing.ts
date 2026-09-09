import { endianness } from "node:os";
import type { Readable, Writable } from "node:stream";
export const MAX_NATIVE_BYTES = 256 * 1024;
const little = endianness() === "LE";
export function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (!payload.length || payload.length > MAX_NATIVE_BYTES)
    throw new Error("Native payload exceeds 256 KiB.");
  const header = Buffer.alloc(4);
  if (little) header.writeUInt32LE(payload.length);
  else header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}
/** Bounded Chrome stdio framing. No human text may ever be written to this output. */
export async function serveNative(
  input: Readable,
  output: Writable,
  handle: (value: unknown) => Promise<unknown>,
) {
  let buffer = Buffer.alloc(0);
  let partial: ReturnType<typeof setTimeout> | undefined;
  try {
    for await (const chunk of input) {
      // Stream chunks can contain several frames; process one bounded frame at a time.
      let remaining = Buffer.from(chunk as Uint8Array);
      while (remaining.length) {
        const length =
          buffer.length < 4 ? 4 : (little ? buffer.readUInt32LE() : buffer.readUInt32BE()) + 4;
        if (length > MAX_NATIVE_BYTES + 4 || (length === 4 && buffer.length === 4))
          throw new Error("Invalid native frame length.");
        const take = Math.min(remaining.length, length - buffer.length);
        buffer = Buffer.concat([buffer, remaining.subarray(0, take)]);
        remaining = remaining.subarray(take);
        if (buffer.length >= 4) {
          const bytes = little ? buffer.readUInt32LE() : buffer.readUInt32BE();
          if (!bytes || bytes > MAX_NATIVE_BYTES) throw new Error("Invalid native frame length.");
          if (buffer.length === bytes + 4) {
            clearTimeout(partial);
            partial = undefined;
            const source = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(4));
            buffer = Buffer.alloc(0);
            const reply = frame(await handle(JSON.parse(source)));
            await new Promise<void>((resolve, reject) =>
              output.write(reply, (error) => (error ? reject(error) : resolve())),
            );
          }
        }
        if (buffer.length && !partial)
          partial = setTimeout(() => input.destroy(new Error("Incomplete native frame.")), 10000);
      }
    }
    if (buffer.length) throw new Error("Truncated native frame.");
  } finally {
    clearTimeout(partial);
  }
}
