import assert from "node:assert/strict";
import { build } from "esbuild";
import type { BrowserContext } from "playwright";
import type { sendToConversation } from "../src/page.js";
import type { watchConversation } from "../src/watch.js";
import { sectionTurnMarkup } from "./fixtures/chatgpt-turn.js";

declare global {
  interface Window {
    bridgeTest: {
      sendToConversation: typeof sendToConversation;
      watchConversation: typeof watchConversation;
    };
    sendOutcome?: string;
    clickCount: number;
    fixtureUrl: string;
    fixtureBound: boolean;
    fixtureEcho: () => void;
    fixtureStop?: () => void;
    fixtureChecks: number;
    queryCount: number;
  }
}
const conversation = "https://chatgpt.com/c/dc6aee38-ef73-470c-ae9f-d70d57c1c412";
const marker = "5fb3c5c9-6ccc-40a4-bc6b-c4e741a357dc";
const payload = `Veyra binding ${marker}\n\n中文 / English\nVEYRA_HANDOFF_BEGIN\n${JSON.stringify({ goal: "中文 and English", tasks: Array.from({ length: 300 }, (_, id) => ({ id, description: `实现 task ${id}`, lines: "first\n\nsecond" })) }, null, 2)}\n\nVEYRA_HANDOFF_END`;
const html =
  '<!doctype html><html><head><meta charset="utf-8"></head><body><main></main><div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">Send</button></body></html>';

/** Real Chromium DOM/events; intentionally no real ChatGPT account or native executor. */
export async function browserRegressions(context: BrowserContext) {
  const bundle = await build({
    stdin: {
      contents:
        'export { sendToConversation } from "./src/page.ts"; export { watchConversation } from "./src/watch.ts";',
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "iife",
    globalName: "bridgeTest",
    platform: "browser",
  });
  const built = bundle.outputFiles[0]?.text;
  assert.ok(built);
  // tsx keeps function names when serializing evaluate callbacks; supply its harmless
  // helper in this disposable test realm (never in the production extension).
  const source = `globalThis.__name = (fn) => fn;\n${built}`;
  const page = await context.newPage();
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  let cases = 0;
  for (const mode of [
    "native",
    "p",
    "div",
    "echo-before-check",
    "user-space",
    "user-type",
    "navigation",
    "binding",
    "attachment",
    "streaming",
    "missing-marker",
    "duplicate",
    "no-echo",
    "old-echo",
  ]) {
    await page.goto(conversation);
    await page.addScriptTag({ content: source });
    await page.evaluate(
      ({ payload, marker, conversation, mode }) => {
        const editor = document.querySelector<HTMLElement>("#prompt-textarea");
        const send = document.querySelector<HTMLButtonElement>('[data-testid="send-button"]');
        if (!editor || !send) throw new Error("Missing fixture composer");
        window.fixtureUrl = conversation;
        window.fixtureBound = true;
        window.clickCount = 0;
        window.sendOutcome = undefined;
        window.fixtureEcho = () => {
          const user = document.createElement("div");
          user.dataset.messageAuthorRole = "user";
          user.dataset.messageId = crypto.randomUUID();
          user.textContent = payload;
          document.querySelector("main")?.append(user);
        };
        if (mode === "old-echo") window.fixtureEcho();
        const original = document.execCommand.bind(document);
        document.execCommand = (command, ui, text) => {
          const result = original(command, ui, text);
          const tag = mode === "div" ? "div" : "p";
          if (mode !== "native")
            editor.replaceChildren(
              ...String(text)
                .split("\n")
                .map((line) => {
                  const block = document.createElement(tag);
                  if (line) block.textContent = line.replace(/ /g, "\u00a0");
                  else block.append(document.createElement("br"));
                  return block;
                }),
            );
          if (mode === "missing-marker")
            editor.textContent = String(text).replace(marker, "removed");
          if (mode === "duplicate") editor.textContent = `${text}\n${text}`;
          if (mode === "echo-before-check") {
            window.fixtureEcho();
            editor.replaceWith(editor.cloneNode(false));
            const reply = document.createElement("div");
            reply.dataset.messageAuthorRole = "assistant";
            reply.textContent = "已收到并回复";
            document.querySelector("main")?.append(reply);
            const stop = document.createElement("button");
            stop.dataset.testid = "stop-button";
            document.body.append(stop);
          }
          return result;
        };
        if (
          ["user-space", "user-type", "navigation", "binding", "attachment", "streaming"].includes(
            mode,
          )
        )
          send.disabled = true;
        send.onclick = () => {
          window.clickCount++;
          editor.textContent = "";
          if (!["no-echo", "old-echo"].includes(mode)) window.fixtureEcho();
        };
        void window.bridgeTest
          .sendToConversation(
            document,
            () => window.fixtureUrl,
            conversation,
            payload,
            marker,
            () => window.fixtureBound,
          )
          .then(
            (value) => {
              window.sendOutcome = value;
            },
            (error: Error) => {
              window.sendOutcome = error.message;
            },
          );
      },
      { payload, marker, conversation, mode },
    );
    if (mode.startsWith("user-")) {
      await page.locator("#prompt-textarea").press("End");
      await page.keyboard.type(mode === "user-space" ? " " : "用户修改");
    }
    if (
      ["user-space", "user-type", "navigation", "binding", "attachment", "streaming"].includes(mode)
    ) {
      await page.evaluate((mode) => {
        if (mode === "navigation") {
          history.pushState({}, "", "/c/bca5d92b-7e1b-48e1-89cd-b1a90c424bf4");
          window.fixtureUrl = location.href;
        }
        if (mode === "binding") window.fixtureBound = false;
        if (mode === "attachment" || mode === "streaming") {
          const node = document.createElement("div");
          node.dataset.testid = mode === "attachment" ? "composer-attachment" : "stop-button";
          document.body.append(node);
        }
        const button = document.querySelector<HTMLButtonElement>('[data-testid="send-button"]');
        if (!button) throw new Error("Missing fixture button");
        button.disabled = false;
      }, mode);
    }
    await page.waitForFunction(() => window.sendOutcome !== undefined, undefined, {
      timeout: 14000,
    });
    const outcome = await page.evaluate(() => ({
      outcome: window.sendOutcome,
      clicks: window.clickCount,
    }));
    if (["native", "p", "div", "echo-before-check"].includes(mode)) {
      assert.equal(outcome.outcome, "sent", mode);
      assert.equal(outcome.clicks, mode === "echo-before-check" ? 0 : 1, mode);
    } else {
      assert.match(outcome.outcome ?? "", /不会自动重发/, mode);
      assert.equal(outcome.clicks, ["no-echo", "old-echo"].includes(mode) ? 1 : 0, mode);
    }
    cases++;
  }
  // Wall-clock 60-second idle test in real Chromium, with a large conversation and
  // the production observer active. Count DOM queries, not a machine-dependent CPU threshold.
  await page.goto(conversation);
  await page.addScriptTag({ content: source });
  await page.evaluate((sectionMarkup) => {
    const main = document.querySelector("main");
    if (!main) throw new Error("Missing fixture main");
    for (let n = 0; n < 3000; n++) {
      const turn = document.createElement(n % 2 === 0 ? "section" : "article");
      turn.setAttribute("data-testid", `conversation-turn-${n}`);
      turn.innerHTML = sectionMarkup;
      const message = turn.querySelector('[data-message-author-role="assistant"]');
      const actions = turn.querySelector('[role="group"]');
      if (!message || !actions) throw new Error("Missing fixture turn");
      message.setAttribute("data-message-id", `old-${n}`);
      message.textContent = "old history ".repeat(40);
      const copy = document.createElement("button");
      copy.dataset.testid = "copy-turn-action-button";
      actions.append(copy);
      main.append(turn);
    }
    window.fixtureChecks = 0;
    window.fixtureStop = window.bridgeTest.watchConversation(
      document,
      () => {
        window.fixtureChecks++;
      },
      () => {},
      (error) => {
        throw error;
      },
    );
    window.queryCount = 0;
    for (const prototype of [Document.prototype, Element.prototype])
      for (const method of ["querySelector", "querySelectorAll"] as const) {
        const original = prototype[method];
        Object.defineProperty(prototype, method, {
          value: function (this: Document & Element, selector: string) {
            window.queryCount++;
            return Reflect.apply(original, this, [selector]);
          },
        });
      }
  }, sectionTurnMarkup);
  const client = await context.newCDPSession(page);
  await client.send("Performance.enable");
  const before = await client.send("Performance.getMetrics");
  console.log("Browser regression: 3000-turn observer armed; measuring 60 seconds idle.");
  await new Promise((done) => setTimeout(done, 60000));
  const idle = await page.evaluate(() => ({
    queries: window.queryCount,
    checks: window.fixtureChecks,
  }));
  assert.deepEqual(idle, { queries: 0, checks: 0 });
  const after = await client.send("Performance.getMetrics");
  const metric = (values: typeof before) =>
    values.metrics.find((m) => m.name === "TaskDuration")?.value ?? 0;
  await page.evaluate((sectionMarkup) => {
    const turn = document.createElement("section");
    turn.dataset.testid = "conversation-turn-fresh";
    turn.dataset.turn = "assistant";
    turn.innerHTML = sectionMarkup;
    const assistant = turn.querySelector('[data-message-author-role="assistant"]');
    const actions = turn.querySelector('[role="group"]');
    if (!assistant || !actions) throw new Error("Missing fixture turn");
    assistant.setAttribute("data-message-id", "fresh");
    document.querySelector("main")?.append(turn);
    for (let n = 0; n < 1000; n++) assistant.textContent = `token-${n}`;
    assistant.textContent = 'VEYRA_HANDOFF_BEGIN\n{"goal":"fixture"}\nVEYRA_HANDOFF_END';
    const copy = document.createElement("button");
    copy.dataset.testid = "copy-turn-action-button";
    actions.append(copy);
  }, sectionTurnMarkup);
  await page.waitForFunction(() => window.fixtureChecks === 1);
  await page.evaluate(() => window.fixtureStop?.());
  await client.detach();
  await page.close();
  return {
    normalizationSafetyCases: cases,
    idleSeconds: 60,
    oldTurns: 3000,
    idleDomQueries: idle.queries,
    idleTaskSeconds: Number((metric(after) - metric(before)).toFixed(4)),
    mutationBurstChecks: 1,
  };
}
