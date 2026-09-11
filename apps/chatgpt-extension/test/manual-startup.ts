/// <reference types="chrome" />
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page, type Worker } from "playwright";
import { EXTENSION_ORIGIN } from "../src/contracts.js";

// Real MV3 lifecycle, deterministic API-availability faults, no ChatGPT account or Project.
// Only a temporary COPY is instrumented; production assets and the user's registry stay untouched.
const id = new URL(EXTENSION_ORIGIN).hostname;
const root = await mkdtemp(join(tmpdir(), "veyra-storage-startup-"));
const extension = join(root, "extension");
await cp(resolve("dist"), extension, { recursive: true });
const background = await readFile(join(extension, "background.js"), "utf8");
const surfaces = new Map(
  await Promise.all(
    ["popup", "sidepanel", "diagnostics"].map(
      async (name) => [name, await readFile(join(extension, `${name}.js`), "utf8")] as const,
    ),
  ),
);
const fault = (delay: number) =>
  `(()=>{const storage=chrome.storage,start=Date.now();Object.defineProperty(chrome,'storage',{configurable:true,get:()=>Date.now()-start<${delay}?undefined:storage});})();\n`;
const profile = join(root, "browser");
await mkdir(join(profile, "NativeMessagingHosts"), { recursive: true });
const unavailableHost = join(root, "native-unavailable");
await writeFile(unavailableHost, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
await writeFile(
  join(profile, "NativeMessagingHosts/com.veyraoss.bridge.json"),
  JSON.stringify({
    name: "com.veyraoss.bridge",
    description: "Startup fixture; never reaches the personal coordinator",
    path: unavailableHost,
    type: "stdio",
    allowed_origins: [`${EXTENSION_ORIGIN}/`],
  }),
);
let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    executablePath: process.env.CHROMIUM_EXECUTABLE,
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging"],
  });
  const failures: string[] = [];
  context.on("weberror", (error) => failures.push(error.error().message));
  await context.route(/^https?:/, (route) => route.abort());
  const manager = await context.newPage();
  await manager.goto("chrome://extensions/");
  await manager.evaluate(async () => {
    const api = (chrome as unknown as { developerPrivate: DeveloperPrivate }).developerPrivate;
    await api.updateProfileConfiguration({ inDeveloperMode: true });
  });
  const cdp = await context.browser()?.newBrowserCDPSession();
  assert.ok(cdp);
  const first = context.waitForEvent("serviceworker");
  assert.equal((await cdp.send("Extensions.loadUnpacked", { path: extension })).id, id);
  let worker = await first;
  await worker.evaluate(() =>
    chrome.storage.local.set({
      locale: "en",
      theme: "dark",
      startupProof: "retained",
      bindings: {},
    }),
  );
  const reload = async (): Promise<Worker> => {
    assert.ok(context);
    const next = context.waitForEvent("serviceworker", { timeout: 15000 });
    await manager.evaluate(async (id) => {
      const api = (chrome as unknown as { developerPrivate: DeveloperPrivate }).developerPrivate;
      await api.reload(id);
    }, id);
    return next;
  };
  const snapshot = (page: Page) =>
    page.evaluate(() => chrome.runtime.sendMessage({ type: "snapshot" }));
  const recordedErrors = () =>
    manager.evaluate(async (id) => {
      const api = (chrome as unknown as { developerPrivate: DeveloperPrivate }).developerPrivate;
      return (await api.getExtensionInfo(id)).runtimeErrors.map((error) => ({
        id: error.id,
        message: error.message,
        occurrences: error.occurrences,
      }));
    }, id);
  const open = async (name = "popup", delay = 0) => {
    assert.ok(context);
    // Inject at the copied bundle boundary: Chrome can install its extension APIs
    // after Playwright's document-init hook and overwrite an earlier fault shim.
    await writeFile(
      join(extension, `${name}.js`),
      (delay ? fault(delay) : "") + surfaces.get(name),
    );
    const page = await context.newPage();
    await page.goto(`${EXTENSION_ORIGIN}/${name}.html`);
    return page;
  };
  const preserved = async (worker: Worker) => {
    assert.deepEqual(
      await worker.evaluate(() => chrome.storage.local.get(["startupProof", "bindings"])),
      { startupProof: "retained", bindings: {} },
    );
  };
  // Exercise an actual upgrade from the reported crash. Chrome retains historical
  // runtime errors across reload; checking that the worker exists is insufficient.
  await writeFile(
    join(extension, "background.js"),
    fault(300) + "void chrome.storage.local.get('locale');\n" + background,
  );
  await reload();
  let historicalErrors = await recordedErrors();
  for (let attempt = 0; historicalErrors.length === 0 && attempt < 50; attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    historicalErrors = await recordedErrors();
  }
  assert.equal(historicalErrors.length, 1);
  assert.match(historicalErrors[0]?.message ?? "", /undefined.*local/);
  const priorFailures = failures.length;
  await writeFile(join(extension, "background.js"), background);
  for (let n = 0; n < 10; n++) {
    worker = await reload();
    const page = await open(n % 2 ? "sidepanel" : "popup");
    assert.equal((await snapshot(page)).ok, true);
    await page.waitForFunction(() => document.documentElement.lang === "en");
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    await page.close();
    await preserved(worker);
    assert.deepEqual(await recordedErrors(), historicalErrors);
  }
  console.log(
    "MV3: upgraded from the real storage crash; 10 reloads preserve popup/panel startup and saved state. The old error remains with unchanged ID/count; no new errors.",
  );
  for (const name of ["popup", "sidepanel", "diagnostics"]) {
    const page = await open(name, 300);
    await page.waitForFunction(() => document.documentElement.lang === "en");
    assert.equal(await page.locator("[data-veyra-startup-error]").count(), 0);
    assert.equal((await snapshot(page)).ok, true);
    await page.close();
    const blocked = await open(name, 60000);
    await blocked.locator('[data-veyra-startup-error="true"]').waitFor();
    assert.match(await blocked.locator("body").innerText(), /本地存储暂时不可用/);
    await blocked.close();
  }
  console.log(
    "UI: all three real extension surfaces recover from delayed storage or show a bounded error.",
  );
  await writeFile(join(extension, "background.js"), fault(300) + background);
  worker = await reload();
  const delayed = await open();
  assert.equal((await snapshot(delayed)).ok, true);
  await preserved(worker);
  await delayed.close();
  await writeFile(join(extension, "background.js"), fault(60000) + background);
  await reload();
  const blocked = await open();
  for (let n = 0; n < 2; n++) {
    const reply = await snapshot(blocked);
    assert.equal(reply.ok, false);
    assert.match(reply.error, /Extension storage is unavailable/);
  }
  await blocked.close();
  // Recover via a new lifecycle, not by retrying any failed business operation.
  await writeFile(join(extension, "background.js"), background);
  worker = await reload();
  await preserved(worker);
  const restored = await open();
  assert.equal((await snapshot(restored)).ok, true);
  await restored.close();
  assert.deepEqual(await recordedErrors(), historicalErrors);
  assert.deepEqual(failures.slice(priorFailures), []);
  console.log(
    "Worker: delayed API recovered, permanent absence failed closed twice, fresh reload recovered; no new Chrome runtime errors or repeated historical errors.",
  );
  await cdp.detach();
} finally {
  await context?.close();
  await rm(root, { recursive: true, force: true });
}

interface DeveloperPrivate {
  updateProfileConfiguration(value: { inDeveloperMode: boolean }): Promise<void>;
  reload(id: string): Promise<void>;
  getExtensionInfo(id: string): Promise<{
    runtimeErrors: { id: number; message: string; occurrences: number }[];
  }>;
}
