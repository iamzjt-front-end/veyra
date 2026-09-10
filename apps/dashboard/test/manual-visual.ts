import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
const update = process.argv.includes("--update");
const directory = resolve("../../output/playwright/gui"),
  baseline = resolve("test/visual/baseline");
await mkdir(directory, { recursive: true });
await mkdir(baseline, { recursive: true });
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
  args: ["--disable-font-subpixel-positioning"],
});
const metadata = {
  browser: browser.version(),
  platform: process.platform,
  fonts: "Inter Variable 5.3.0 / JetBrains Mono Variable 5.3.0",
  locale: "en-US",
  languages: ["en", "zh-CN"],
  timezone: "UTC",
  time: "2026-09-09T10:29:14.000Z",
  reducedMotion: true,
  scale: 1,
};
const layouts = [
  ...[
    "unbound",
    "idle",
    "running",
    "verification",
    "completed",
    "failed",
    "paused",
    "cancelled",
    "disconnected",
    "no-projects",
    "codex-unavailable",
    "project-missing",
    "waiting-codex",
  ].map((state) => ({
    name: `side-panel-${state}`,
    route: `/side-panel/${state}`,
    width: 400,
    height: 820,
    dark: false,
  })),
  { name: "side-panel-dark", route: "/side-panel/running", width: 400, height: 820, dark: true },
  ...["overview", "project", "run", "failed", "settings", "missing", "empty"].map((state) => ({
    name: `control-center-${state}`,
    route: `/control-center/${state}`,
    width: 1440,
    height: 980,
    dark: false,
  })),
  {
    name: "control-center-dark",
    route: "/control-center/overview",
    width: 1440,
    height: 980,
    dark: true,
  },
  {
    name: "control-center-run-dark",
    route: "/control-center/run",
    width: 1440,
    height: 980,
    dark: true,
  },
  { name: "popup", route: "/popup", width: 300, height: 310, dark: false },
];
const cases = layouts.flatMap((sample) => [
  { ...sample, locale: "en" },
  { ...sample, name: `${sample.name}-zh`, locale: "zh-CN" },
]);
const results: { name: string; changedPixels: number; ratio: number }[] = [];
try {
  if (!update)
    assert.deepEqual(
      JSON.parse(await readFile(resolve(baseline, "environment.json"), "utf8")),
      metadata,
      "Use the recorded Chromium/platform for pixel regression; update baselines only after reviewing changed screenshots.",
    );
  const context = await browser.newContext({
    viewport: { width: 400, height: 820 },
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    deviceScaleFactor: 1,
    colorScheme: "light",
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const external: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (["http:", "https:"].includes(url.protocol) && url.hostname !== "127.0.0.1") {
      external.push(url.href);
      await route.abort();
    } else await route.continue();
  });
  await page.clock.setFixedTime(new Date(metadata.time));
  const visit = async (route: string, dark = false, locale = "en") => {
    await page.goto(
      `http://127.0.0.1:${address.port}${route}?fixed=1&lang=${locale}&theme=${dark ? "dark" : "light"}`,
    );
    await page.locator(".v-brand").first().waitFor();
    await page.evaluate(() => document.fonts.ready);
  };
  for (const sample of cases) {
    await page.setViewportSize({ width: sample.width, height: sample.height });
    await visit(sample.route, sample.dark, sample.locale);
    assert.equal(await page.locator("html").getAttribute("lang"), sample.locale);
    assert.ok(
      await page.locator("body").evaluate((body) => body.scrollWidth <= innerWidth),
      `${sample.name}: overflow`,
    );
    assert.doesNotMatch(await page.locator("body").innerText(), /\bundefined\b|\bnull\b/);
    const audit = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    assert.deepEqual(
      audit.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
      })),
      [],
      `${sample.name}: accessibility`,
    );
    const actualBytes = await page.screenshot({
      fullPage: true,
      animations: "disabled",
      caret: "hide",
    });
    const path = `${sample.name}.png`;
    await writeFile(resolve(directory, path), actualBytes);
    let changedPixels = 0,
      ratio = 0;
    if (update) await writeFile(resolve(baseline, path), actualBytes);
    else {
      const expected = PNG.sync.read(await readFile(resolve(baseline, path))),
        actual = PNG.sync.read(actualBytes);
      assert.equal(actual.width, expected.width, `${sample.name}: width`);
      assert.equal(actual.height, expected.height, `${sample.name}: height`);
      const diff = new PNG({ width: actual.width, height: actual.height });
      changedPixels = pixelmatch(
        expected.data,
        actual.data,
        diff.data,
        actual.width,
        actual.height,
        { threshold: 0.12, includeAA: false },
      );
      ratio = changedPixels / (actual.width * actual.height);
      if (ratio > 0.001)
        await writeFile(resolve(directory, `${sample.name}-diff.png`), PNG.sync.write(diff));
      assert.ok(
        ratio <= 0.001,
        `${sample.name}: ${changedPixels} differing pixels (${ratio}); inspect the saved diff before updating.`,
      );
    }
    results.push({ name: sample.name, changedPixels, ratio });
  }
  for (const locale of ["en", "zh-CN"])
    for (const width of [320, 360, 400, 420, 460]) {
      await page.setViewportSize({ width, height: 820 });
      await visit("/side-panel/running", false, locale);
      assert.ok(await page.locator("body").evaluate((body) => body.scrollWidth <= innerWidth));
    }
  await page.setViewportSize({ width: 900, height: 980 });
  await visit("/control-center/run");
  assert.ok(await page.locator("body").evaluate((body) => body.scrollWidth <= innerWidth));
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("menu").count(), 0);
  await page.locator(".v-diff-expand").click();
  assert.match(await page.locator(".v-diff-code").innerText(), /session contract stays unchanged/);
  await page
    .getByRole("button", { name: /src\/api\/session.ts/ })
    .first()
    .click();
  assert.match(await page.locator(".v-diff-file-heading").innerText(), /src\/api\/session.ts/);
  for (const name of ["large-projects", "large-runs"]) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await visit(`/control-center/${name}`);
    const list = page.locator(".v-virtual-list");
    await list.waitFor();
    assert.ok((await page.locator(".v-virtual-row").count()) <= 14);
    await list.focus();
    await page.keyboard.press("Home");
    assert.equal(
      await page
        .locator(":focus")
        .evaluate((el) => el.closest("[data-virtual-index]")?.getAttribute("data-virtual-index")),
      "0",
      "Home focuses the first row even before scrolling",
    );
    await page.keyboard.press("End");
    assert.equal(
      await page
        .locator(":focus")
        .evaluate((el) => el.closest("[data-virtual-index]")?.getAttribute("data-virtual-index")),
      "2999",
    );
    assert.ok((await page.locator(".v-virtual-row").count()) <= 14);
    await page.keyboard.press("Home");
    assert.equal(
      await page
        .locator(":focus")
        .evaluate((el) => el.closest("[data-virtual-index]")?.getAttribute("data-virtual-index")),
      "0",
    );
    if (name === "large-projects") {
      await page.getByRole("textbox", { name: "Search projects" }).fill("2999");
      assert.match(await page.locator(".v-project-list").innerText(), /Project 2999/);
    }
  }
  await page.setViewportSize({ width: 400, height: 820 });
  await visit("/side-panel/running");
  await page.getByRole("button", { name: "View run", exact: true }).click();
  assert.equal(await page.locator("dialog[open]").count(), 1);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("dialog[open]").count(), 0);
  assert.ok(
    await page.locator(":focus").evaluate((el) => getComputedStyle(el).outlineStyle !== "none"),
  );
  assert.ok(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches));
  assert.equal(
    await page.evaluate(() =>
      document
        .getAnimations()
        .some((animation) => animation.effect?.getTiming().iterations === Infinity),
    ),
    false,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  if (update)
    await writeFile(
      resolve(baseline, "environment.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
  const report = {
    status: "passed",
    mode: update ? "updated" : "compared",
    metadata,
    screenshots: results,
    accessibility: "No WCAG A/AA automated violations in captured states",
    keyboard: [
      "Tab focus",
      "Enter",
      "Escape",
      "menu arrows",
      "virtual Home/End",
      "diff navigation",
    ],
    largeRows: 3000,
    maximumRenderedRows: 14,
    widths: [320, 360, 400, 420, 460, 900, 1440],
    externalRequests: external,
  };
  await writeFile(resolve(directory, "visual-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      status: report.status,
      mode: report.mode,
      screenshots: results.length,
      changedPixels: results.reduce((sum, item) => sum + item.changedPixels, 0),
      browser: metadata.browser,
      output: directory,
    }),
  );
} finally {
  await browser.close();
  await server.close();
}
