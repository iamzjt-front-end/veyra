import assert from "node:assert/strict";
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
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(await server.issue());
    await page.getByText("Local browser integration", { exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, "#/overview");
    await page.reload();
    await page.getByText("Local browser integration", { exact: true }).waitFor();
    await page.getByRole("button", { name: /Local browser integration/ }).click();
    await page.getByRole("heading", { name: project.name }).waitFor();
    await page.getByText("Codex · Ready", { exact: true }).waitFor();
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
      }),
    );
  } finally {
    await browser.close();
    await server.stop();
    await daemon.stop();
  }
});
