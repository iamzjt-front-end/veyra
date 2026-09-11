export const STORAGE_UNAVAILABLE =
  "Extension storage is unavailable. Reopen Veyra; no task was sent or replayed.";
export const CONTEXT_UNAVAILABLE =
  "This extension context was replaced. Reopen Veyra; no task was sent or replayed.";

/** Chrome can expose storage late during worker startup. Wait only for API presence,
 * never retry a storage write, dispatch or delivery, and never use empty state on failure. */
export async function extensionStorage(): Promise<typeof chrome.storage> {
  const runtime = globalThis.chrome?.runtime;
  const id = runtime?.id;
  if (!id) throw new Error(CONTEXT_UNAVAILABLE);
  // At most 2.5 seconds per startup; no polling remains after success or failure.
  for (const delay of [0, 50, 100, 200, 400, 750, 1000]) {
    if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    if (runtime.id !== id || globalThis.chrome?.runtime !== runtime)
      throw new Error(CONTEXT_UNAVAILABLE);
    const storage = globalThis.chrome?.storage;
    if (
      storage &&
      [storage.local, storage.session].every(
        (area) =>
          area &&
          typeof area.get === "function" &&
          typeof area.set === "function" &&
          typeof area.setAccessLevel === "function",
      ) &&
      typeof storage.onChanged?.addListener === "function" &&
      typeof storage.onChanged?.removeListener === "function"
    )
      return storage;
  }
  throw new Error(STORAGE_UNAVAILABLE);
}
