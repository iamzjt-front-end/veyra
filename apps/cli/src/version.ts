import { readFileSync } from "node:fs";

/** The CLI package manifest is the release version source of truth. */
export const CLI_VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
