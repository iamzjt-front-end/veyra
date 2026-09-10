import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { privateRead, privateWrite } from "./native-installation.js";
export type InterfaceLocale = "zh-CN" | "en";
export const validInterfaceLocale = (value: unknown): value is InterfaceLocale =>
  value === "zh-CN" || value === "en";
async function preferencePath(registryRoot: string) {
  const stat = await lstat(registryRoot);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o022
  )
    throw new Error("Unsafe local UI preference directory.");
  return join(registryRoot, "ui-preferences.json");
}
export async function readUiLocale(registryRoot: string): Promise<InterfaceLocale> {
  const source = await privateRead(await preferencePath(registryRoot));
  if (!source) return "zh-CN";
  const value: unknown = JSON.parse(source);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("locale" in value) ||
    !validInterfaceLocale(value.locale) ||
    Object.keys(value).length !== 1
  )
    throw new Error("Invalid local UI preferences; inspect the saved file.");
  return value.locale;
}
export async function writeUiLocale(registryRoot: string, locale: InterfaceLocale) {
  if (!validInterfaceLocale(locale)) throw new Error("Unsupported interface language.");
  await privateWrite(await preferencePath(registryRoot), `${JSON.stringify({ locale })}\n`);
}
