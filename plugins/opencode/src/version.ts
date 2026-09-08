import { readFileSync } from "node:fs";

/** Version of this installed adapter package, shared by its provider variants. */
export const ADAPTER_VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
