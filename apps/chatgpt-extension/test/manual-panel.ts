import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";

const directory = resolve("../../output/playwright/gui");
await mkdir(directory, { recursive: true });
const server = await createServer({
  root: resolve("dev"),
  server: { host: "127.0.0.1", port: 0 },
  logLevel: "error",
});
await server.listen();
const address = server.httpServer?.address();
if (!address || typeof address === "string") throw new Error("Fixture server address unavailable");
const browser = await chromium.launch({
  channel: "chromium",
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE,
});
try {
  const page = await browser.newPage({
    viewport: { width: 400, height: 820 },
    reducedMotion: "reduce",
    colorScheme: "light",
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const language of ["zh-CN", "en"]) {
    await page.goto(`http://127.0.0.1:${address.port}/side-panel/unbound?lang=${language}`);
    await page
      .getByRole("button", {
        name: language === "en" ? "Choose an existing Codex task" : "选择 Codex 已有对话",
      })
      .click();
    await page
      .getByLabel(language === "en" ? "Search Codex task titles" : "搜索 Codex 对话标题")
      .fill("确认旧代码已删除");
    await page
      .getByRole("button", { name: language === "en" ? "Search" : "搜索", exact: true })
      .click();
    await page.getByRole("button", { name: /确认旧代码已删除/ }).waitFor();
    await page.screenshot({
      path: resolve(directory, `codex-task-picker-${language}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: /确认旧代码已删除/ }).click();
    assert.match(await page.locator(".v-native-target").innerText(), /确认旧代码已删除/);
    assert.match(await page.locator(".v-native-target").innerText(), /etf-quant-monitor/);
    assert.equal(
      await page
        .getByRole("button", {
          name: language === "en" ? "Bind conversation" : "绑定当前对话",
          exact: true,
        })
        .isEnabled(),
      true,
    );
    await page.screenshot({
      path: resolve(directory, `codex-task-selected-${language}.png`),
      fullPage: true,
    });
    for (const width of [320, 400, 460]) {
      await page.setViewportSize({ width, height: 820 });
      assert.equal(
        await page.locator("body").evaluate((body) => body.scrollWidth <= innerWidth),
        true,
      );
    }
    await page.setViewportSize({ width: 400, height: 820 });
  }
  for (const state of [
    "unbound",
    "idle",
    "running",
    "verification",
    "completed",
    "failed",
    "review-approved",
    "review-changes",
    "review-human",
    "paused",
    "disconnected",
    "no-projects",
  ]) {
    await page.goto(`http://127.0.0.1:${address.port}/side-panel/${state}?lang=en`);
    await page.locator(".v-panel-header").waitFor();
    assert.equal(
      await page.locator("body").evaluate((body) => body.scrollWidth <= innerWidth),
      true,
      `${state} fits 400px`,
    );
    assert.doesNotMatch(await page.locator("body").innerText(), /\bundefined\b|\bnull\b/);
    if (state.startsWith("review-")) {
      const rows = await page.getByRole("main").locator(".v-run-outcomes").innerText();
      assert.match(rows, /Completed/);
      assert.match(rows, state === "review-changes" ? /3 passed/ : /1 failed · 2 passed/);
      assert.match(
        rows,
        state === "review-approved"
          ? /Approved/
          : state === "review-changes"
            ? /Needs changes/
            : /Needs your decision/,
      );
      assert.doesNotMatch(rows, /All checks passed/);
    }
    await page.screenshot({
      path: resolve(directory, `side-panel-${state}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
  await page.goto(`http://127.0.0.1:${address.port}/side-panel/running?lang=en&theme=dark`);
  await page.locator(".v-panel-header").waitFor();
  await page.screenshot({
    path: resolve(directory, "side-panel-dark.png"),
    fullPage: true,
    animations: "disabled",
  });
  for (const width of [320, 360, 420, 460]) {
    await page.setViewportSize({ width, height: 820 });
    assert.equal(
      await page.locator("body").evaluate((body) => body.scrollWidth <= innerWidth),
      true,
      `fits ${width}px`,
    );
  }
  await page.getByRole("button", { name: "View run" }).click();
  assert.equal(
    await page.locator("dialog").evaluate((dialog) => (dialog as HTMLDialogElement).open),
    true,
  );
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator("dialog").evaluate((dialog) => (dialog as HTMLDialogElement).open),
    false,
  );
  await page.setViewportSize({ width: 300, height: 290 });
  await page.goto(`http://127.0.0.1:${address.port}/popup?lang=en`);
  await page.getByRole("button", { name: "Open Veyra" }).waitFor();
  await page.screenshot({
    path: resolve(directory, "popup.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Open Veyra" }).click();
  await page.getByRole("button", { name: "Bind conversation" }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      status: "passed",
      screenshots: directory,
      browser: browser.version(),
      states: 13,
      widths: [320, 360, 400, 420, 460],
      keyboard: "drawer Escape and native focus",
    }),
  );
} finally {
  await browser.close();
  await server.close();
}
