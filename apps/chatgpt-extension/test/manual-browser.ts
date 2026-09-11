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
import {
  initializeProject,
  ProjectRegistry,
  ProjectHandoffStore,
  ProjectStateStore,
} from "@veyraoss/project";
import { parseConfig } from "@veyraoss/config";
import { EXTENSION_ORIGIN, parsePairing } from "../src/contracts.js";
import type { SessionState } from "../src/controller.js";
import { sectionTurnMarkup } from "./fixtures/chatgpt-turn.js";

// This is an offline fixture, not a ChatGPT account/native-auth acceptance claim.
const native = process.argv.includes("--native");
const fixtureHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body><main></main><div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">Send</button><script>
let turns=0;
const main=document.querySelector('main'), editor=document.querySelector('#prompt-textarea');
document.querySelector('button').onclick=()=>{
 const text=editor.innerText.replace(/\u00a0/g,' '); editor.textContent='';
 const user=document.createElement('div');user.dataset.messageAuthorRole='user';user.textContent=text;main.append(user);
 const match=[...text.matchAll(/VEYRA_HANDOFF_BEGIN\\n([\\s\\S]*?)\\nVEYRA_HANDOFF_END/g)].at(-1);
 if(match)sessionStorage.setItem('fixture-plan',match[1]);
 if(sessionStorage.getItem('pauseFixture')==='yes')return;
 const returned=/VEYRA_RESULT_BEGIN\\n([\\s\\S]*?)\\nVEYRA_RESULT_END/.exec(text);
 if(!match && !returned && text!=='Implement the fixture feature')return;
 const source=match?match[1]:returned?null:sessionStorage.getItem('fixture-plan');
 const result=returned?JSON.parse(returned[1]):null;
 const review=result?{version:1,projectId:result.projectId,runId:result.runId,resultId:result.id,handoffId:result.handoffId,verdict:result.status==='failed'?'PASS':'FAIL',summary:result.status==='failed'?'Read-only evidence collected despite the deliberate failure.':'Checks pass; the reviewer still requests changes.',findings:[{severity:'warning',description:'Review and verification are independent.'}],nextAction:result.status==='failed'?'complete':'repair'}:null;
 let handoff;if(source){try{handoff=JSON.parse(source);}catch{throw new Error('Invalid fixture plan: '+JSON.stringify(source.slice(0,180)));}handoff.context.goal=turns++===0?'First fixture implementation':'Repair after failed verifier';if(handoff.context.plan){handoff.context.plan.summary=handoff.context.goal;handoff.context.plan.tasks[0].description=handoff.context.goal;}handoff.requestedVerification=[{id:'verify',kind:'test'},{id:'build',kind:'build'},{id:'diff',kind:'shell'}];}
 const stop=document.createElement('button');stop.dataset.testid='stop-button';document.body.append(stop);
 const sectionLayout=${native};
 const turn=document.createElement(sectionLayout?'section':'article');
 if(sectionLayout){turn.dataset.testid='conversation-turn-'+turns;turn.dataset.turn='assistant';turn.innerHTML=${JSON.stringify(sectionTurnMarkup)};}
 const assistant=sectionLayout?turn.querySelector('[data-message-author-role="assistant"]'):document.createElement('div');assistant.dataset.messageAuthorRole='assistant';assistant.dataset.messageId=crypto.randomUUID();
 const body=document.createElement(sectionLayout?'p':'code');body.textContent='Preparing the structured response…';if(sectionLayout)assistant.append(body);else{const pre=document.createElement('pre');body.className='language-veyra-handoff';pre.append(body);assistant.append(pre);turn.append(assistant);}main.append(turn);
 const actions=sectionLayout?turn.querySelector('[role="group"]'):turn;
 const copy=document.createElement('button');copy.dataset.testid='copy-turn-action-button';actions.append(copy);
 // Complete-looking prose must not consume this identity before the final body commit.
 setTimeout(()=>{stop.dataset.testid='fixture-finished-control';setTimeout(()=>{body.textContent=handoff?'VEYRA_HANDOFF_BEGIN\\n'+JSON.stringify(handoff)+'\\nVEYRA_HANDOFF_END':'';if(review){const pre=document.createElement('pre');pre.textContent='VEYRA_REVIEW_BEGIN\\n'+JSON.stringify(review)+'\\nVEYRA_REVIEW_END';assistant.prepend(pre);if(sectionLayout && handoff){const task=document.createElement('pre');task.textContent=body.textContent;body.replaceWith(task);}}},800);},100);
};
</script></body></html>`;

const root = await mkdtemp(join(tmpdir(), "veyra-extension-browser-"));
console.log(`Disposable browser fixture: ${root}`);
const project = await initializeProject(root);
const registryRoot = join(root, "registry");
const fixtureChecks = {
  verify: {
    type: "command" as const,
    run: [
      `${process.execPath} -e 'if(require("node:fs").readFileSync("answer.txt","utf8")!=="42")process.exit(1)'`,
    ],
    next: "build",
    on: { failure: "build" },
    retry: { max: 1 },
  },
  build: {
    type: "command" as const,
    run: [`${process.execPath} -e 'console.log("fixture build evidence")'`],
    next: "diff",
    on: { failure: "diff" },
    retry: { max: 1 },
  },
  diff: {
    type: "command" as const,
    run: [`${process.execPath} -e 'console.log("fixture diff evidence")'`],
    retry: { max: 1 },
  },
};
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
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:count===1?'failure':'success',summary:'Fixture native executor',changedFiles:['answer.txt'],commandsRun:[]})}}));
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
      steps: fixtureChecks,
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
          checks: [{ id: "verify" }, { id: "build" }, { id: "diff" }],
        }),
      },
      resolveExecution: () => ({
        config: parseConfig({ version: 1, agents: {}, workflow: { use: "fixture" } }),
        workflow: {
          version: 1,
          name: "fixture",
          start: "execute",
          steps: {
            execute: {
              type: "agent",
              agent: "executor",
              next: "verify",
              on: { failure: "verify" },
            },
            ...fixtureChecks,
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
                status: executed === 1 ? "failure" : "success",
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
    ignoreDefaultArgs: native ? ["--disable-extensions"] : undefined,
    args: native
      ? ["--enable-unsafe-extension-debugging"]
      : [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  if (native) {
    // Only this disposable test profile: reproduce the user's Developer Mode + Load unpacked.
    // In this Chromium, command-line loading alone is disabled on runtime.reload. Writing a
    // Preferences file is insufficient: use Chrome's own profile configuration operation.
    const manager = await context.newPage();
    await manager.goto("chrome://extensions/");
    await manager.evaluate(async () => {
      const api = (
        chrome as unknown as {
          developerPrivate: {
            updateProfileConfiguration(
              options: { inDeveloperMode: boolean },
              done: () => void,
            ): void;
            getProfileConfiguration(done: (value: { inDeveloperMode: boolean }) => void): void;
          };
        }
      ).developerPrivate;
      await new Promise<void>((done) =>
        api.updateProfileConfiguration({ inDeveloperMode: true }, done),
      );
      const profile = await new Promise<{ inDeveloperMode: boolean }>((done) =>
        api.getProfileConfiguration(done),
      );
      if (!profile.inDeveloperMode) throw new Error("Fixture Developer Mode was not enabled");
    });
    const browser = context.browser();
    assert.ok(browser);
    const extensions = await browser.newBrowserCDPSession();
    try {
      const loaded = await extensions.send("Extensions.loadUnpacked", { path: extension });
      assert.equal(`chrome-extension://${loaded.id}`, EXTENSION_ORIGIN);
    } finally {
      await extensions.detach();
      await manager.close();
    }
  }
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "https://chatgpt.com")
      return route.fulfill({ contentType: "text/html", body: fixtureHtml });
    if (url.hostname === "127.0.0.1" || url.protocol === "chrome-extension:")
      return route.continue();
    return route.abort();
  });
  let worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 10000 }));
  assert.equal(worker.url(), `${EXTENSION_ORIGIN}/background.js`);
  await worker.evaluate(() => chrome.storage.local.set({ locale: "en" }));
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const conversation = "https://chatgpt.com/c/412bdbd3-48e2-45d1-947e-f4f865488614";
  await page.goto(conversation);
  let popup = await context.newPage();
  // Standalone test tabs emulate visible docked extension surfaces while ChatGPT stays active.
  await popup.addInitScript(() => Object.defineProperty(document, "hidden", { get: () => false }));
  await popup.goto(`${EXTENSION_ORIGIN}/diagnostics.html`);
  let invitation: { code: string } | undefined;
  if (!native) {
    if (!daemon?.http) throw new Error("Missing HTTP transport");
    invitation = JSON.parse(await readFile(daemon.http.pairingFile, "utf8"));
    // Let the default native probe finish before uploading the explicit HTTP fallback.
    await popup.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>("#detect")?.disabled,
    );
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
  let panel = await context.newPage();
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
  if (native) {
    // Match the real report: reload the extension while keeping the existing ChatGPT document.
    await page.bringToFront();
    const pageIdentity = await page.evaluate(() => {
      const id = crypto.randomUUID();
      Object.assign(window, { fixtureDocumentIdentity: id });
      return id;
    });
    const workerUrl = worker.url();
    await worker.evaluate(() => {
      Object.assign(globalThis, { fixtureBeforeExtensionReload: true });
      // Return the evaluation before Chrome destroys its execution context.
      setTimeout(() => chrome.runtime.reload(), 50);
    });
    await delay(200);
    // Reopen only the extension's surfaces; the ChatGPT page is deliberately not refreshed.
    if (!popup.isClosed()) await popup.close();
    if (!panel.isClosed()) await panel.close();
    popup = await context.newPage();
    await popup.addInitScript(() =>
      Object.defineProperty(document, "hidden", { get: () => false }),
    );
    await popup.goto(`${EXTENSION_ORIGIN}/diagnostics.html`);
    panel = await context.newPage();
    await panel.addInitScript(() =>
      Object.defineProperty(document, "hidden", { get: () => false }),
    );
    await panel.goto(`${EXTENSION_ORIGIN}/sidepanel.html`);
    await panel.locator(".v-panel-header").waitFor();
    await popup.waitForFunction(
      () => (document.querySelector<HTMLSelectElement>("#project")?.options.length ?? 0) > 1,
    );
    await popup.locator("#diagnostics").evaluate((node) => {
      (node as HTMLDetailsElement).open = true;
    });
    let restarted = false;
    const reloadDeadline = Date.now() + 15000;
    while (Date.now() < reloadDeadline) {
      await delay(100);
      const candidate = [...context.serviceWorkers()]
        .reverse()
        .find((item) => item.url() === workerUrl);
      if (!candidate) continue;
      // Chromium can reuse its worker target object. Prove lost globals, not object identity.
      const fresh = await Promise.race([
        candidate
          .evaluate(() => !!chrome.runtime.id && !("fixtureBeforeExtensionReload" in globalThis))
          .catch(() => false),
        delay(1000).then(() => false),
      ]);
      if (fresh) {
        worker = candidate;
        restarted = true;
        break;
      }
    }
    assert.equal(restarted, true, "The extension must actually reload with fresh worker globals");
    const absent = await worker.evaluate(async (id) => {
      try {
        await chrome.tabs.sendMessage(id as number, { type: "prepare" }, { frameId: 0 });
        return "unexpected receiver";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }, chatTabId);
    assert.equal(absent, "Could not establish connection. Receiving end does not exist.");
    assert.equal(
      await page.evaluate(
        () => (window as unknown as { fixtureDocumentIdentity: string }).fixtureDocumentIdentity,
      ),
      pageIdentity,
    );
    assert.equal(await page.locator('[data-message-author-role="user"]').count(), 0);
    console.log(
      "Page recovery: real extension reload reproduced the missing receiver; binding without page refresh.",
    );
  }
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
    // Real re-binding can make ChatGPT review a historical Project snapshot. It must
    // not pause the new binding or pretend that an unassociated verdict was saved.
    await page.evaluate(() => {
      const turn = document.createElement("article");
      const message = document.createElement("div");
      message.dataset.messageAuthorRole = "assistant";
      message.dataset.messageId = "unsolicited-historical-review";
      message.textContent =
        'VEYRA_REVIEW_BEGIN\n{"verdict":"PASS","summary":"Historical result","findings":[],"nextAction":"complete"}\nVEYRA_REVIEW_END';
      const copy = document.createElement("button");
      copy.dataset.testid = "copy-turn-action-button";
      turn.append(message, copy);
      document.querySelector("main")?.append(turn);
    });
    await delay(1200);
    const afterHistoricalReview = (await worker.evaluate(
      async () => (await chrome.storage.session.get("state")).state,
    )) as SessionState;
    assert.ok(afterHistoricalReview.binding);
    assert.equal(afterHistoricalReview.binding.phase, "armed");
    assert.equal(afterHistoricalReview.binding.count, 0);
    assert.equal(afterHistoricalReview.binding.review, undefined);
    assert.match(
      await page.locator('[data-message-id="unsolicited-historical-review"]').innerText(),
      /VEYRA_REVIEW_BEGIN/,
      "An ignored review must not be folded as recorded",
    );
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
    const beforeIdle = JSON.parse(
      await readFile(join(registryRoot, "daemon", "daemon.json"), "utf8"),
    );
    console.log("Native recovery: waiting for the real 60-second coordinator idle shutdown.");
    await delay(60000);
    await delay(6000);
    const idleMetadata = await readFile(join(registryRoot, "daemon", "daemon.json"), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    assert.equal(idleMetadata, undefined, "No active run: coordinator actually idles down");
    const evictAndWake = async (wake: () => Promise<unknown>) => {
      assert.ok(context);
      const cdp = await context.newCDPSession(panel);
      const workerUrl = worker.url();
      const cleanups: (() => void)[] = [];
      type Version = { versionId: string; scriptURL: string; runningStatus: string };
      const versionAt = (status: string) => {
        const pending = new Promise<Version>((resolve, reject) => {
          const listener = ({ versions }: { versions: Version[] }) => {
            const version = versions.find(
              (item) => item.scriptURL === workerUrl && item.runningStatus === status,
            );
            if (version) {
              cleanup();
              resolve(version);
            }
          };
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Fixture worker did not become ${status}`));
          }, 10000);
          const cleanup = () => {
            clearTimeout(timer);
            cdp.off("ServiceWorker.workerVersionUpdated", listener);
          };
          cleanups.push(cleanup);
          cdp.on("ServiceWorker.workerVersionUpdated", listener);
        });
        void pending.catch(() => {});
        return pending;
      };
      try {
        const running = versionAt("running");
        await cdp.send("ServiceWorker.enable");
        const version = await running;
        await worker.evaluate(() => Object.assign(globalThis, { veyraColdWorkerProbe: true }));
        const stopped = versionAt("stopped");
        // Chromium retains the DevTools worker target across restarts. Use the actual
        // service-worker lifecycle plus a lost global to prove a cold execution context.
        await cdp.send("ServiceWorker.stopWorker", { versionId: version.versionId });
        await stopped;
        const resumed = versionAt("running");
        await wake();
        await resumed;
        const activeWorker = context.serviceWorkers().find((item) => item.url() === workerUrl);
        assert.ok(activeWorker);
        worker = activeWorker;
        assert.equal(
          await worker.evaluate(() => "veyraColdWorkerProbe" in globalThis),
          false,
          "Worker globals must be lost; a warm snapshot is not recovery proof",
        );
      } finally {
        for (const cleanup of cleanups) cleanup();
        await cdp.detach();
      }
    };
    await evictAndWake(async () => {
      const response = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "snapshot" }));
      assert.equal(response.ok, true);
      assert.equal(
        response.data.connectivity.status,
        "connected",
        "Cold snapshots must rehydrate without Reconnect",
      );
      assert.equal(response.data.currentBound, true);
      assert.equal(response.data.selected.readiness.ready, true);
      assert.equal(response.data.binding.count, 0, "Snapshot recovery cannot replay a task");
      await panel.evaluate(() => window.dispatchEvent(new Event("focus")));
    });
    const afterIdle = JSON.parse(
      await readFile(join(registryRoot, "daemon", "daemon.json"), "utf8"),
    );
    assert.notEqual(afterIdle.id, beforeIdle.id, "The coordinator was restarted lazily");
    assert.equal(
      await page.locator('[data-message-author-role="user"]').count(),
      0,
      "Recovery cannot resend bootstrap",
    );
    assert.match(await panel.locator(".v-panel-header").innerText(), /Ready/);
    // Now test an incoming handoff itself waking a cold worker/coordinator, with no panel refresh.
    await stopDaemon({ registryRoot });
    // Only the simulated ChatGPT app keeps its own fixture plan, as a real planner would.
    await page.evaluate(() => sessionStorage.removeItem("pauseFixture"));
    await evictAndWake(async () => {
      await page.locator("#prompt-textarea").fill("Implement the fixture feature");
      await page.locator('[data-testid="send-button"]').click();
    });
  }
  const deadline = Date.now() + 45000;
  let state: {
    binding?: { phase: string; message: string; count: number; review?: { phase: string } };
  } = {};
  while (Date.now() < deadline) {
    state =
      ((await worker.evaluate(
        async () => (await chrome.storage.session.get("state")).state,
      )) as typeof state) ?? {};
    if (
      state.binding?.phase === "armed" &&
      state.binding.count === 2 &&
      state.binding.review?.phase === "recorded"
    )
      break;
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
    "armed",
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
  assert.equal(state.binding?.review?.phase, "recorded");
  if (native) executed = Number(await readFile(join(root, "executions.txt"), "utf8"));
  assert.equal(executed, 2);
  assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "42");
  const messages = await page.locator('[data-message-author-role="user"]').allTextContents();
  assert.equal(messages.length, 3, "One binding plus exactly one return per run");
  assert.match(messages[1] ?? "", /"status":"failed"/);
  assert.match(messages[2] ?? "", /"status":"completed"/);
  assert.match(messages[1] ?? "", /"exitCode":1/);
  assert.match(messages[2] ?? "", /"exitCode":0/);
  for (const [index, message] of messages.slice(1).entries()) {
    const match = /VEYRA_RESULT_BEGIN\n([\s\S]*?)\nVEYRA_RESULT_END/.exec(message);
    assert.ok(match?.[1]);
    const result = JSON.parse(match[1]);
    const archive = new ProjectHandoffStore({ project });
    const review = await archive.getReview(result.runId);
    assert.equal(review?.resultId, result.id, "Review links to this exact handback");
    assert.equal(review?.verdict, index === 0 ? "pass" : "fail");
    assert.equal((await archive.getResult(result.runId))?.executionStatus, "completed");
    assert.deepEqual(
      result.verification.map((check: { id: string; status: string }) => [check.id, check.status]),
      [
        ["verify", index === 0 ? "failed" : "passed"],
        ["build", "passed"],
        ["diff", "passed"],
      ],
    );
    assert.equal(
      result.verificationEvidence.length,
      3,
      "Each handback must include all independent checks, even after executor/test failure",
    );
    for (const check of result.verification) {
      const evidence = result.verificationEvidence.find(
        (event: { eventId: string }) => event.eventId === check.evidence.eventId,
      );
      assert.equal(evidence.results[0].exitCode, check.status === "failed" ? 1 : 0);
    }
  }
  assert.equal((await new ProjectStateStore({ project }).read())?.review?.verdict, "fail");
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
  await panel.waitForFunction(() =>
    document.querySelector("main .v-run-outcomes")?.textContent?.includes("Needs changes"),
  );
  assert.match(
    await panel.getByRole("main").locator(".v-run-outcomes").innerText(),
    /Completed[\s\S]*3 passed[\s\S]*Needs changes/,
  );

  assert.equal(
    await page.locator('[data-veyra-status="true"]').count(),
    native ? 6 : 7,
    "Current handoffs/results/reviews fold reversibly (native binding preceded refresh)",
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
    const opened = context.waitForEvent("page").catch(async (error: unknown) => {
      const detail = await panel
        .locator('[role="alert"]')
        .allTextContents()
        .catch(() => []);
      throw new Error(`Fixture Control Center did not open: ${detail.join(" ").slice(0, 2000)}`, {
        cause: error,
      });
    });
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
    assert.match(await control.locator(".v-review").innerText(), /Needs changes/);
    assert.match(new URL(control.url()).hash, new RegExp(project.id));
    await control.close();
    await page.bringToFront();
    // A recorded review and exhausted execution budget survive refresh without any replay.
    await page.reload();
    await popup.waitForFunction(() =>
      document.querySelector("#bound-project")?.textContent?.includes("veyra-extension-browser"),
    );
    await panel.waitForFunction(() =>
      document.querySelector(".v-run-outcomes")?.textContent?.includes("Needs changes"),
    );
    assert.equal((await new ProjectStateStore({ project }).read())?.review?.verdict, "fail");
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
      persistedReviews: ["pass", "fail"],
      reviewRestoredAfterRefresh: native,
      streamingControlReused: true,
      assistantLayout: native ? "observed section with nested sibling toolbar" : "legacy article",
      ...(native
        ? {
            extensionReloadRecovered: true,
            pageRefreshRequiredForBind: false,
            armedRefreshRestored: true,
            bootstrapReplayed: false,
            lazyCoordinator: true,
          }
        : {}),
      verifier: ["failed", "passed"],
      apiKeyRequired: false,
      publicNetworkUsed: false,
      ...(native
        ? {
            nativeAuthorizationVerified: true,
            unbindVerified: true,
            scopedControlCenterVerified: true,
            coldWorkerSnapshotRecovered: true,
            coordinatorIdleShutdownVerified: true,
            coldWorkerHandoffDispatched: true,
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
