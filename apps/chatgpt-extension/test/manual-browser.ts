/// <reference types="chrome" />
import { browserRegressions } from "./browser-regressions.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { startDaemon } from "@veyraoss/daemon";
import { initializeProject, ProjectRegistry } from "@veyraoss/project";
import { parseConfig } from "@veyraoss/config";
import { EXTENSION_ORIGIN, parsePairing } from "../src/contracts.js";

// This is an offline fixture, not a ChatGPT account/native-auth acceptance claim.
const fixtureHtml = `<!doctype html><html><body><main></main><div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">Send</button><script>
let turns=0;
const main=document.querySelector('main'), editor=document.querySelector('#prompt-textarea');
document.querySelector('button').onclick=()=>{
 const text=editor.innerText.replace(/\u00a0/g,' '); editor.textContent='';
 const user=document.createElement('div');user.dataset.messageAuthorRole='user';user.textContent=text;main.append(user);
 const match=[...text.matchAll(/VEYRA_HANDOFF_BEGIN\\n([\\s\\S]*?)\\nVEYRA_HANDOFF_END/g)].at(-1);
 if(!match)return;
 const handoff=JSON.parse(match[1]);handoff.context.goal=turns++===0?'First fixture implementation':'Repair after failed verifier';handoff.requestedVerification=[{id:'verify',kind:'test'}];
 const stop=document.createElement('button');stop.dataset.testid='stop-button';document.body.append(stop);
 const article=document.createElement('article'), assistant=document.createElement('div');assistant.dataset.messageAuthorRole='assistant';assistant.dataset.messageId=crypto.randomUUID();
 const pre=document.createElement('pre'), code=document.createElement('code');code.className='language-veyra-handoff';code.textContent='{';pre.append(code);assistant.append(pre);article.append(assistant);main.append(article);
 setTimeout(()=>{code.textContent='VEYRA_HANDOFF_BEGIN\\n'+JSON.stringify(handoff)+'\\nVEYRA_HANDOFF_END';stop.remove();const copy=document.createElement('button');copy.dataset.testid='copy-turn-action-button';article.append(copy);},100);
};
</script></body></html>`;

const root = await mkdtemp(join(tmpdir(), "veyra-extension-browser-"));
const project = await initializeProject(root);
const registryRoot = join(root, "registry");
await new ProjectRegistry({ root: registryRoot }).register(root);
let executed = 0;
const env = { ...process.env };
delete env.OPENAI_API_KEY;
const daemon = await startDaemon({
  registryRoot,
  env,
  http: {
    port: 0,
    origin: EXTENSION_ORIGIN,
    projectIds: [project.id],
    inspectProject: async () => ({
      ready: true,
      message: "Fixture executor; not native authentication proof",
      checks: [{ id: "verify" }],
    }),
  },
  resolveExecution: () => ({
    config: parseConfig({ version: 1, agents: {}, workflow: { use: "fixture" } }),
    workflow: {
      version: 1,
      name: "fixture",
      start: "execute",
      steps: {
        execute: { type: "agent", agent: "executor", next: "verify" },
        verify: {
          type: "command",
          run: [
            `${process.execPath} -e 'if(require("node:fs").readFileSync("answer.txt","utf8")!=="42")process.exit(1)'`,
          ],
        },
      },
    },
    agents: {
      executor: {
        id: "fixture",
        provider: "fake",
        async run() {
          executed++;
          await writeFile(join(root, "answer.txt"), executed === 1 ? "WRONG" : "42");
          return {
            status: "success",
            summary: "Fixture implementation",
            data: { changedFiles: ["answer.txt"] },
          };
        },
      },
    },
  }),
});
let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
try {
  const extension = resolve("dist");
  context = await chromium.launchPersistentContext(join(root, "browser"), {
    channel: "chromium",
    executablePath: process.env.CHROMIUM_EXECUTABLE,
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "https://chatgpt.com")
      return route.fulfill({ contentType: "text/html", body: fixtureHtml });
    if (url.hostname === "127.0.0.1" || url.protocol === "chrome-extension:")
      return route.continue();
    return route.abort();
  });
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 10000 }));
  assert.equal(worker.url(), `${EXTENSION_ORIGIN}/background.js`);
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const conversation = "https://chatgpt.com/c/412bdbd3-48e2-45d1-947e-f4f865488614";
  await page.goto(conversation);
  const popup = await context.newPage();
  await popup.goto(`${EXTENSION_ORIGIN}/popup.html`);
  if (!daemon.http) throw new Error("Missing transport");
  const invitation = JSON.parse(await readFile(daemon.http.pairingFile, "utf8"));
  await popup.locator("#pairing").setInputFiles(daemon.http.pairingFile);
  await popup.locator("#pair").click();
  await popup
    .waitForFunction(
      () => document.querySelector("#status")?.textContent?.includes("已连接"),
      undefined,
      { timeout: 10000 },
    )
    .catch(async () => {
      throw new Error(`Pairing failed: ${await popup.locator("#status").textContent()}`);
    });
  await popup.locator("#project").selectOption(project.id);
  await popup.locator("#limit").selectOption("2");
  await page.bringToFront();
  // The extension's own popup controls are exercised while the conversation remains active.
  await popup.waitForFunction(() => {
    const bind = document.querySelector<HTMLButtonElement>("#bind");
    if (!bind || bind.disabled) return false;
    bind.click();
    return true;
  });
  const deadline = Date.now() + 45000;
  let state: { binding?: { phase: string; message: string; count: number } } = {};
  while (Date.now() < deadline) {
    state = (await worker.evaluate(
      async () => (await chrome.storage.session.get("state")).state,
    )) as typeof state;
    if (state.binding?.phase === "stopped") break;
    if (state.binding?.phase === "paused") throw new Error(state.binding.message);
    if (!state.binding && Date.now() > deadline - 35000)
      throw new Error(`Binding failed: ${await popup.locator("#status").textContent()}`);
    if (pageErrors.length) throw new Error(`Fixture page error: ${pageErrors.join("; ")}`);
    await new Promise((done) => setTimeout(done, 250));
  }
  assert.equal(
    state.binding?.phase,
    "stopped",
    JSON.stringify({
      message: state.binding?.message,
      count: state.binding?.count,
      dom: await page.evaluate(() => ({
        assistants: document.querySelectorAll('[data-message-author-role="assistant"]').length,
        users: document.querySelectorAll('[data-message-author-role="user"]').length,
        codeBlocks: document.querySelectorAll("code.language-veyra-handoff").length,
        copyButtons: document.querySelectorAll('[data-testid="copy-turn-action-button"]').length,
        streaming: !!document.querySelector('[data-testid="stop-button"]'),
      })),
    }),
  );
  assert.equal(state.binding?.count, 2);
  assert.equal(executed, 2);
  assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "42");
  const messages = await page.locator('[data-message-author-role="user"]').allTextContents();
  assert.equal(messages.length, 3, "One binding plus exactly one return per run");
  assert.match(messages[1] ?? "", /"status":"failed"/);
  assert.match(messages[2] ?? "", /"status":"completed"/);
  assert.match(messages[1] ?? "", /"exitCode":1/);
  assert.match(messages[2] ?? "", /"exitCode":0/);
  const pairing = parsePairing(
    await worker.evaluate(
      async () =>
        ((await chrome.storage.session.get("state")).state as { pairing?: unknown }).pairing,
    ),
  );
  await popup.waitForFunction(() =>
    document.querySelector("#last-result")?.textContent?.includes("confirmed"),
  );
  assert.match(await popup.locator("#bound-project").innerText(), new RegExp(project.id));
  assert.match(await popup.locator("#native").innerText(), /Ready/);
  await page.goto("https://chatgpt.com/c/b7a2b48e-eeb6-4e85-af8f-1bd2d44a28ea");
  await popup.waitForFunction(() =>
    document.querySelector("#bound-project")?.textContent?.includes("未绑定"),
  );
  await popup.locator("#unpair").click();
  await popup.waitForFunction(() =>
    document.querySelector("#grant")?.textContent?.includes("已撤销"),
  );
  assert.equal(
    (
      await fetch(`${daemon.http.url}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${pairing.token}` },
        body: JSON.stringify({ version: 1, method: "projects.list" }),
      })
    ).status,
    401,
  );
  assert.equal(executed, 2, "Navigation and revocation must not start another run");
  assert.equal(
    await worker.evaluate(
      async () =>
        !!((await chrome.storage.session.get("state")).state as { pairing?: unknown }).pairing,
    ),
    false,
  );
  assert.equal(
    messages.some(
      (message) => message.includes(pairing.token) || message.includes(invitation.code),
    ),
    false,
  );
  const regressions = await browserRegressions(context);
  console.log(
    JSON.stringify({
      regressions,
      proof: "offline Chromium extension fixture; simulated ChatGPT and executor",
      browser: context.browser()?.version(),
      executions: executed,
      sameConversationReturns: 2,
      verifier: ["failed", "passed"],
      apiKeyRequired: false,
      publicNetworkUsed: false,
      revocationVerified: true,
    }),
  );
} finally {
  await context?.close();
  await daemon.stop();
  await rm(root, { recursive: true, force: true });
}
