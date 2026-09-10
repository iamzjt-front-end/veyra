import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";
const output = resolve("../../output/playwright/gui");
await mkdir(output, { recursive: true });
const server = await createServer({
  root: resolve("dev"),
  server: { host: "127.0.0.1", port: 0 },
  logLevel: "error",
});
await server.listen();
const address = server.httpServer?.address();
assert.ok(address && typeof address !== "string");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE,
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 980 },
    reducedMotion: "reduce",
    colorScheme: "light",
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const state of ["overview", "projects", "project", "runs", "settings", "run", "failed"]) {
    await page.goto(`http://127.0.0.1:${address.port}/control-center/${state}?lang=en`);
    await page.locator(".v-page-heading h1").waitFor();
    assert.doesNotMatch(
      await page.locator("body").innerText(),
      /\bundefined\b|\bnull\b|ChatGPT approved/,
    );
    assert.ok(await page.locator("body").evaluate((body) => body.scrollWidth <= innerWidth));
    await page.screenshot({
      path: resolve(output, `control-center-${state}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
  await page.goto(`http://127.0.0.1:${address.port}/control-center/run?lang=en`);
  await page.getByRole("navigation", { name: "Changed files" }).waitFor();
  await page
    .getByRole("button", { name: /src\/api\/session.ts/ })
    .first()
    .click();
  assert.match(await page.locator(".v-diff-file-heading").innerText(), /src\/api\/session.ts/);
  await page.locator(".v-verification-list summary").first().click();
  assert.match(await page.locator(".v-command-evidence").first().innerText(), /pnpm test/);
  await page.goto(`http://127.0.0.1:${address.port}/control-center/run?lang=en&theme=dark`);
  await page.locator(".v-diff").waitFor();
  await page.screenshot({ path: resolve(output, "control-center-run-dark.png"), fullPage: true });
  await page.goto(`http://127.0.0.1:${address.port}/control-center/overview?lang=en&theme=dark`);
  await page.locator(".v-active-run").waitFor();
  await page.screenshot({ path: resolve(output, "control-center-dark.png"), fullPage: true });
  await page.setViewportSize({ width: 900, height: 900 });
  assert.ok(await page.locator("body").evaluate((body) => body.scrollWidth <= innerWidth));
  await page.keyboard.press("Tab");
  assert.ok(await page.locator(":focus").count());
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      status: "passed",
      views: 7,
      widths: [900, 1440],
      themes: ["light", "dark"],
      output,
    }),
  );
} finally {
  await browser.close();
  await server.close();
}
