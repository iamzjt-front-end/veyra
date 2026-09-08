import { type AgentInput, type JsonObject, isJsonValue } from "@veyraoss/protocol";
import type { SecretRedactor } from "@veyraoss/runtime";
import { object } from "./output.js";

/** Exact models whose image input + structured text output are documented in GEMINI.md. */
export const visionModels: readonly string[] = Object.freeze([
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.5-flash-lite",
]);

export function requestParts(
  input: AgentInput,
  vision: boolean,
  redactor: SecretRedactor,
): JsonObject[] {
  if (!isJsonValue(input)) throw new Error("Input must contain plain JSON data.");
  const safe = redactor.json(input) as JsonObject;
  const context = object(safe.context) ? safe.context : undefined;
  const images = context?.images;
  const parts: JsonObject[] = [];
  if (images !== undefined) {
    if (!Array.isArray(images) || images.length > 4)
      throw new Error("context.images must be an array of at most four inline images.");
    if (images.length && !vision)
      throw new Error("Inline images require vision: true and a documented supported model.");
    for (const image of images) {
      if (
        !object(image) ||
        Object.keys(image).length !== 2 ||
        typeof image.mimeType !== "string" ||
        !["image/png", "image/jpeg", "image/webp"].includes(image.mimeType) ||
        typeof image.data !== "string" ||
        !image.data.length ||
        image.data.length > 192 * 1024 ||
        image.data.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) ||
        Buffer.from(image.data, "base64").toString("base64") !== image.data
      )
        throw new Error(
          "Each image must contain only mimeType (PNG/JPEG/WebP) and canonical base64 data of at most 192 KiB; paths and URLs are not supported.",
        );
      parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
    }
    if (context)
      context.images = images.map((image, index) => ({
        index,
        mimeType: (image as JsonObject).mimeType as string,
      }));
  }
  return [{ text: JSON.stringify(safe) }, ...parts];
}
