/// <reference types="chrome" />
import { initializeNativeProject } from "../../cli/src/project-init.js";
import { readControlMetadata } from "../../cli/src/control-launcher.js";
import { setTimeout as delay } from "node:timers/promises";
import { setupNative } from "../../cli/src/native-installation.js";
import { browserRegressions } from "./browser-regressions.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { startDaemon, stopDaemon } from "@veyraoss/daemon";
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
 if(match)sessionStorage.setItem('fixture-plan',match[1]);
 if(sessionStorage.getItem('pauseFixture')==='yes')return;
 if(!match && text!=='Implement the fixture feature')return;
 const source=match?match[1]:sessionStorage.getItem('fixture-plan');if(!source)return;
 const handoff=JSON.parse(source);handoff.context.goal=turns++===0?'First fixture implementation':'Repair after failed verifier';handoff.requestedVerification=[{id:'verify',kind:'test'}];
 const stop=document.createElement('button');stop.dataset.testid='stop-button';document.body.append(stop);
 const article=document.createElement('article'), assistant=document.createElement('div');assistant.dataset.messageAuthorRole='assistant';assistant.dataset.messageId=crypto.randomUUID();
 const pre=document.createElement('pre'), code=document.createElement('code');code.className='language-veyra-handoff';code.textContent='{';pre.append(code);assistant.append(pre);article.append(assistant);main.append(article);
 setTimeout(()=>{code.textContent='VEYRA_HANDOFF_BEGIN\\n'+JSON.stringify(handoff)+'\\nVEYRA_HANDOFF_END';stop.remove();const copy=document.createElement('button');copy.dataset.testid='copy-turn-action-button';article.append(copy);},100);
};
</script></body></html>`;

const native = process.argv.includes("--native");
const root = await mkdtemp(join(tmpdir(), "veyra-extension-browser-"));
const project = await initializeProject(root);
const registryRoot = join(root, "registry");
if (native) {
  const executable = join(root, "codex");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs=require('node:fs');const {randomUUID}=require('node:crypto');
if(process.env.OPENAI_API_KEY)process.exit(2);
if(process.argv[2]==='--version')console.log('codex-cli 1.2.3');
else if(process.argv[2]==='login')console.log('Logged in using ChatGPT');
else {
 fs.readFileSync(0,'utf8');
 const count=fs.existsSync('executions.txt')?Number(fs.readFileSync('executions.txt','utf8'))+1:1;
 fs.writeFileSync('executions.txt',String(count));fs.writeFileSync('answer.txt',count===1?'WRONG':'42');
 console.log(JSON.stringify({type:'thread.started',thread_id:randomUUID()}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'success',summary:'Fixture native executor',changedFiles:['answer.txt'],commandsRun:[]})}}));
 console.log(JSON.stringify({type:'turn.completed'}));
}
`,
    { mode: 0o700 },
  );
  await writeFile(
    join(root, "veyra.yaml"),
    JSON.stringify({
      version: 1,
      agents: { executor: { provider: "codex" } },
      workflow: { use: "./workflow.yaml" },
    }),
  );
  await writeFile(
    join(root, "workflow.yaml"),
    JSON.stringify({
      version: 1,
      name: "fixture",
      start: "verify",
      steps: {
        verify: {
          type: "command",
          run: [
            `${process.execPath} -e 'if(require("node:fs").readFileSync("answer.txt","utf8")!=="42")process.exit(1)'`,
          ],
        },
      },
    }),
  );
}
await new ProjectRegistry({ root: registryRoot }).register(root);
let executed = 0;
const env: NodeJS.ProcessEnv = {
  ...process.env,
  ...(native ? { PATH: `${root}:${process.env.PATH ?? ""}` } : {}),
};
delete env.OPENAI_API_KEY;
if (native) await initializeNativeProject(root, { registryRoot, env });
const daemon = native
  ? undefined
  : await startDaemon({
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
let controlPid: number | undefined;
try {
  const extension = resolve("dist");
  if (native)
    await setupNative({
      registryRoot,
      manifestDirs: [join(root, "browser", "NativeMessagingHosts")],
      env,
    });
  context = await chromium.launchPersistentContext(join(root, "browser"), {
    channel: "chromium",
    executablePath: process.env.CHROMIUM_EXECUTABLE,
    headless: true,
    env,
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
  await worker.evaluate(() => chrome.storage.local.set({ locale: "en" }));
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const conversation = "https://chatgpt.com/c/412bdbd3-48e2-45d1-947e-f4f865488614";
  await page.goto(conversation);
  const popup = await context.newPage();
  // Standalone test tabs emulate visible docked extension surfaces while ChatGPT stays active.
  await popup.addInitScript(() => Object.defineProperty(document, "hidden", { get: () => false }));
  await popup.goto(`${EXTENSION_ORIGIN}/diagnostics.html`);
  let invitation: { code: string } | undefined;
  if (!native) {
    if (!daemon?.http) throw new Error("Missing HTTP transport");
    invitation = JSON.parse(await readFile(daemon.http.pairingFile, "utf8"));
    await popup.locator("#diagnostics").evaluate((node) => {
      (node as HTMLDetailsElement).open = true;
    });
    await popup.locator("#pairing").evaluate((node) => {
      const details = node.closest("details");
      if (details) details.open = true;
    });
    await popup.locator("#pairing").setInputFiles(daemon.http.pairingFile);
    await popup.locator("#pair").click();
  }
  await popup
    .waitForFunction(
      () => (document.querySelector<HTMLSelectElement>("#project")?.options.length ?? 0) > 1,
      undefined,
      { timeout: 15000 },
    )
    .catch(async () => {
      throw new Error(`Connection failed: ${await popup.locator("#error").textContent()}`);
    });
  await popup.locator("#diagnostics").evaluate((node) => {
    (node as HTMLDetailsElement).open = true;
  });
  if (native) {
    await popup.locator("#diagnostics details").evaluate((node) => {
      (node as HTMLDetailsElement).open = true;
    });
    await popup.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>("#use-native")?.disabled,
    );
    // Exercise migration from an explicitly selected HTTP fallback; no manual project refresh.
    await worker.evaluate(() => chrome.storage.session.set({ state: { transport: "http" } }));
    await popup.locator("#project").evaluate((node) => node.replaceChildren());
    await popup.locator("#use-native").click();
    await popup.waitForFunction(
      (id) => !!document.querySelector(`#project option[value="${id}"]`),
      project.id,
    );
  }
  const panel = await context.newPage();
  await panel.addInitScript(() => Object.defineProperty(document, "hidden", { get: () => false }));
  await panel.goto(`${EXTENSION_ORIGIN}/sidepanel.html`);
  await panel.locator(".v-panel-header").waitFor();
  const chatTabId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id,
    conversation,
  );
  assert.equal(typeof chatTabId, "number");
  assert.equal(
    (await worker.evaluate((id) => chrome.sidePanel.getOptions({ tabId: id }), chatTabId)).enabled,
    true,
  );
  await popup.locator("#project").selectOption(project.id);
  await popup.locator("#limit").selectOption("2");
  await page.bringToFront();
  if (native) await page.evaluate(() => sessionStorage.setItem("pauseFixture", "yes"));
  // The extension's own popup controls are exercised while the conversation remains active.
  await popup.waitForFunction(() => {
    const bind = document.querySelector<HTMLButtonElement>("#bind");
    if (!bind || bind.disabled) return false;
    bind.click();
    return true;
  });
  if (native) {
    await popup.waitForFunction(() =>
      document.querySelector("#conversation")?.textContent?.includes("explicitly bound"),
    );
    let armed: { binding?: { epoch: string; bootstrapped?: boolean; phase: string } } = {};
    for (let attempt = 0; attempt < 100; attempt++) {
      armed =
        ((await worker.evaluate(
          async () => (await chrome.storage.session.get("state")).state,
        )) as typeof armed) ?? {};
      if (armed.binding?.bootstrapped && armed.binding.phase === "armed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(armed.binding?.bootstrapped, true);
    const epoch = armed.binding?.epoch;
    await page.reload();
    let recovered = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = (await worker.evaluate(
        async () => (await chrome.storage.session.get("state")).state,
      )) as typeof armed;
      if (
        state?.binding?.bootstrapped &&
        state.binding.epoch !== epoch &&
        state.binding.phase === "armed"
      ) {
        recovered = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(recovered, true, "Armed same-conversation binding restores without another Bind");
    assert.equal(
      await page.locator('[data-message-author-role="user"]').count(),
      0,
      "No bootstrap replay on refresh",
    );
    // Only the simulated ChatGPT app keeps its own fixture plan, as a real planner would.
    await page.evaluate(() => sessionStorage.removeItem("pauseFixture"));
    await page.locator("#prompt-textarea").fill("Implement the fixture feature");
    await page.locator('[data-testid="send-button"]').click();
  }
  const deadline = Date.now() + 45000;
  let state: { binding?: { phase: string; message: string; count: number } } = {};
  while (Date.now() < deadline) {
    state =
      ((await worker.evaluate(
        async () => (await chrome.storage.session.get("state")).state,
      )) as typeof state) ?? {};
    if (state.binding?.phase === "stopped") break;
    if (state.binding?.phase === "paused") throw new Error(state.binding.message);
    if (!state.binding && Date.now() > deadline - 35000)
      throw new Error(
        `Binding failed: ${await popup.locator("#error").textContent()} ${await popup.locator("#status").textContent()}`,
      );
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
  if (native) executed = Number(await readFile(join(root, "executions.txt"), "utf8"));
  assert.equal(executed, 2);
  assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "42");
  const messages = await page.locator('[data-message-author-role="user"]').allTextContents();
  assert.equal(messages.length, 3, "One binding plus exactly one return per run");
  assert.match(messages[1] ?? "", /"status":"failed"/);
  assert.match(messages[2] ?? "", /"status":"completed"/);
  assert.match(messages[1] ?? "", /"exitCode":1/);
  assert.match(messages[2] ?? "", /"exitCode":0/);
  const pairing = native
    ? undefined
    : parsePairing(
        await worker.evaluate(
          async () =>
            ((await chrome.storage.session.get("state")).state as { pairing?: unknown }).pairing,
        ),
      );
  await popup.waitForFunction(() =>
    document.querySelector("#last-result")?.textContent?.includes("Confirmed"),
  );
  assert.match(await popup.locator("#project-detail").innerText(), new RegExp(project.id));
  assert.match(await popup.locator("#native").innerText(), /Ready/);
  await panel.waitForFunction(() =>
    document.querySelector(".v-result-summary")?.textContent?.includes("Result returned"),
  );
  assert.match(await panel.locator(".v-task-title").innerText(), /Repair after failed verifier/);
  assert.match(await panel.locator(".v-project-bound").innerText(), /veyra-extension-browser/);
  assert.match(await panel.locator('.v-stepper [data-state="pending"]').innerText(), /Review/);

  assert.equal(
    await page.locator('[data-veyra-status="true"]').count(),
    native ? 4 : 5,
    "Current machine handoffs/results fold reversibly (native binding preceded refresh)",
  );
  // Preference updates repaint only extension UI and its own folded labels, never rebind/replay.
  const stateBeforeLanguage = await worker.evaluate(
    async () => (await chrome.storage.local.get("bindings")).bindings,
  );
  const runsBeforeLanguage = executed;
  await popup.locator("#locale").selectOption("zh-CN");
  await panel.getByRole("button", { name: "查看运行详情", exact: true }).waitFor();
  await page.waitForFunction(() =>
    document.querySelector('[data-veyra-status="true"]')?.textContent?.includes("原始"),
  );
  assert.equal(await popup.locator("html").getAttribute("lang"), "zh-CN");
  await popup.locator("#locale").selectOption("en");
  await panel.getByRole("button", { name: "View run", exact: true }).waitFor();
  await page.waitForFunction(() =>
    document.querySelector('[data-veyra-status="true"]')?.textContent?.includes("raw payload"),
  );
  assert.deepEqual(
    await worker.evaluate(async () => (await chrome.storage.local.get("bindings")).bindings),
    stateBeforeLanguage,
  );
  assert.equal(executed, runsBeforeLanguage);
  if (native) {
    await panel
      .getByRole("button", { name: "View run", exact: true })
      .evaluate((node) => (node as HTMLButtonElement).click());
    const opened = context.waitForEvent("page");
    await panel
      .getByRole("button", { name: "Open Control Center" })
      .evaluate((node) => (node as HTMLButtonElement).click());
    const control = await opened;
    await control
      .getByRole("heading", { name: "Repair after failed verifier", exact: true })
      .waitFor();
    controlPid = (await readControlMetadata(join(registryRoot, "browser", "control.json")))?.pid;
    assert.ok(controlPid);
    await control.getByRole("heading", { name: "验证", exact: true }).waitFor();
    await control.getByRole("button", { name: "语言 / Language", exact: true }).click();
    await control.getByRole("menuitem", { name: "English", exact: true }).click();
    await control.getByRole("heading", { name: "Verification", exact: true }).waitFor();
    assert.match(await control.locator(".v-review").innerText(), /Review pending/);
    assert.match(new URL(control.url()).hash, new RegExp(project.id));
    await control.close();
    await page.bringToFront();
    // Finished budget stays stopped across refresh; no duplicate binding/dispatch is sent.
    await page.reload();
    await popup.waitForFunction(() =>
      document.querySelector("#bound-project")?.textContent?.includes("veyra-extension-browser"),
    );
    assert.equal(executed, 2);
    assert.equal(await page.locator('[data-message-author-role="user"]').count(), 0);
    await popup.locator("#unbind").click();
    const stored = await worker.evaluate(
      async () => (await chrome.storage.local.get("bindings")).bindings,
    );
    assert.deepEqual(stored, {});
  }
  await page.goto("https://chatgpt.com/c/b7a2b48e-eeb6-4e85-af8f-1bd2d44a28ea");
  await popup.waitForFunction(() =>
    document.querySelector("#bound-project")?.textContent?.includes("not bound"),
  );
  if (!native) {
    assert.ok(daemon?.http);
    assert.ok(pairing);
    assert.ok(invitation);
    await popup.locator("#unpair").click();
    await popup.waitForFunction(() =>
      document.querySelector("#grant")?.textContent?.includes("revoked"),
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
  }
  const regressions = await browserRegressions(context);
  console.log(
    JSON.stringify({
      regressions,
      proof: "offline Chromium extension fixture; simulated ChatGPT and executor",
      transport: native
        ? "chrome.runtime.connectNative → real stdio host → lazy coordinator → native adapter fixture"
        : "loopback HTTP",
      browser: context.browser()?.version(),
      executions: executed,
      sameConversationReturns: 2,
      ...(native
        ? { armedRefreshRestored: true, bootstrapReplayed: false, lazyCoordinator: true }
        : {}),
      verifier: ["failed", "passed"],
      apiKeyRequired: false,
      publicNetworkUsed: false,
      ...(native
        ? {
            nativeAuthorizationVerified: true,
            unbindVerified: true,
            scopedControlCenterVerified: true,
          }
        : { revocationVerified: true }),
    }),
  );
} finally {
  await context?.close();
  const remainingControl = await readControlMetadata(join(registryRoot, "browser", "control.json"));
  controlPid ??= remainingControl?.pid;
  if (controlPid && remainingControl?.pid === controlPid) {
    try {
      process.kill(controlPid, "SIGTERM");
    } catch {
      /* Already idle-stopped. */
    }
    for (let i = 0; i < 100; i++) {
      if (!(await readControlMetadata(join(registryRoot, "browser", "control.json")))) break;
      await delay(30);
    }
  }
  if (daemon) await daemon.stop();
  else await stopDaemon({ registryRoot });
  await rm(root, { recursive: true, force: true });
}
