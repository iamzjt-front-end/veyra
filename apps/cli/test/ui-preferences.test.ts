import { chmod, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { readUiLocale, writeUiLocale } from "../src/ui-preferences.js";

it("stores only a private UI preference, separate from Project evidence and browser ports", async () =>
  withFixtureWorkspace(async ({ path }) => {
    expect(await readUiLocale(path)).toBe("zh-CN");
    await writeUiLocale(path, "en");
    expect(await readUiLocale(path)).toBe("en");
    expect(JSON.parse(await readFile(join(path, "ui-preferences.json"), "utf8"))).toEqual({
      locale: "en",
    });
    expect((await lstat(join(path, "ui-preferences.json"))).mode & 0o777).toBe(0o600);
    await writeUiLocale(path, "zh-CN");
    expect(await readUiLocale(path)).toBe("zh-CN");
  }));
it("rejects links, insecure directories, invalid values and malformed saved preferences", async () =>
  withFixtureWorkspace(async ({ path }) => {
    const directory = join(path, "registry");
    await mkdir(directory, { mode: 0o700 });
    const target = join(path, "target");
    await writeFile(target, '{"locale":"en"}', { mode: 0o600 });
    await symlink(target, join(directory, "ui-preferences.json"));
    await expect(readUiLocale(directory)).rejects.toThrow();
    await expect(writeUiLocale(directory, "zh-CN")).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe('{"locale":"en"}');
    await symlink(directory, join(path, "link"));
    await expect(writeUiLocale(join(path, "link"), "en")).rejects.toThrow("Unsafe");
    await chmod(directory, 0o777);
    await expect(readUiLocale(directory)).rejects.toThrow("Unsafe");
    await writeFile(join(path, "ui-preferences.json"), '{"locale":"fr"}', { mode: 0o600 });
    await expect(readUiLocale(path)).rejects.toThrow("Invalid");
    await expect(writeUiLocale(path, "fr" as "en")).rejects.toThrow("Unsupported");
    expect(await readFile(join(path, "ui-preferences.json"), "utf8")).toBe('{"locale":"fr"}');
  }));
