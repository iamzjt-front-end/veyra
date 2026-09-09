import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { DaemonClient, startDaemon } from "../../../packages/daemon/src/index.js";
import { initializeProject } from "../../../packages/project/src/index.js";
import { startControlServer } from "../../cli/src/control-server.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
await withFixtureWorkspace(async ({ path }) => {
  const registryRoot = join(path, "registry");
  const project = await initializeProject(path, { name: "Local browser integration" });
  const daemon = await startDaemon({ registryRoot });
  const client = new DaemonClient({ registryRoot });
  await client.call("projects.register", { path });
  for (let i = 0; i < 35; i++) {
    const root = join(path, `project-${i}`);
    await mkdir(root);
    await initializeProject(root, { name: `Sample Project ${String(i).padStart(2, "0")}` });
    await client.call("projects.register", { path: root });
  }
  const server = await startControlServer({
    assets: resolve("dist"),
    registryRoot,
    client: async () => client,
    authorize: async () => {},
    inspect: async () => ({
      ready: true,
      message: "Deterministic integration fixture",
      checks: [],
    }),
  });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE,
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [],
      requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/")) requests.push(request.url());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(await server.issue());
    await page.locator(".v-project-list-row").first().waitFor();
    assert.equal(new URL(page.url()).hash, "#/overview");
    await page.getByRole("link", { name: "Projects", exact: true }).click();
    await page.locator(".v-virtual-list").waitFor();
    assert.ok((await page.locator(".v-virtual-row").count()) <= 14);
    assert.equal(
      await page
        .locator(".v-virtual-list")
        .evaluate((el) => Math.round(el.getBoundingClientRect().height)),
      624,
      "production CSP permits numeric virtual layout",
    );
    await page.getByRole("textbox", { name: "Search projects" }).fill("Local browser integration");
    await page.getByRole("button", { name: /Local browser integration/ }).click();
    await page.getByRole("heading", { name: project.name, exact: true }).waitFor();
    await page.reload();
    await page.getByRole("heading", { name: project.name, exact: true }).waitFor();
    await page.getByText("Codex · Ready", { exact: true }).waitFor();
    await delay(700);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const metric = async () =>
      (await cdp.send("Performance.getMetrics")).metrics.find(
        (item) => item.name === "TaskDuration",
      )?.value ?? 0;
    const before = await metric(),
      count = requests.length;
    await page.evaluate(() => {
      const root = document.getElementById("root");
      if (!root) throw new Error("Missing UI");
      root.dataset.idleMutations = "0";
      new MutationObserver(() => {
        const value = Number(root.dataset.idleMutations);
        root.dataset.idleMutations = String(value + 1);
      }).observe(root, { childList: true, subtree: true, characterData: true });
    });
    console.log(
      "Control Center: measuring 60 seconds production idle, real local session, 36 Projects.",
    );
    await delay(60000);
    const idleTaskSeconds = Number(((await metric()) - before).toFixed(4));
    assert.equal(requests.length, count, "idle has no API requests");
    assert.equal(
      await page.locator("#root").getAttribute("data-idle-mutations"),
      "0",
      "idle has no UI mutations",
    );
    assert.ok(idleTaskSeconds < 0.5, `idle TaskDuration ${idleTaskSeconds}s`);
    await writeFile(
      resolve("../../output/playwright/gui/control-center-performance.json"),
      `${JSON.stringify({ idleSeconds: 60, idleTaskSeconds, idleApiRequests: 0, idleMutations: 0, projects: 36, maximumRenderedRows: 14 }, null, 2)}\n`,
    );
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("heading", { name: "Appearance" }).waitFor();
    await page.getByRole("button", { name: "Sign out of this window" }).click();
    await page.getByRole("heading", { name: "The local connection needs attention" }).waitFor();
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        status: "passed",
        productionAssets: true,
        realLocalDaemon: true,
        sessionRestore: true,
        scopedProject: true,
        signOut: true,
        idleTaskSeconds,
        idleApiRequests: 0,
        idleUiMutations: 0,
      }),
    );
  } finally {
    await browser.close();
    await server.stop();
    await daemon.stop();
  }
});
