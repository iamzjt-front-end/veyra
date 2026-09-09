import { describe, expect, it, vi } from "vitest";
import { PanelStore } from "../src/panel-store.js";
import { isExtensionSurface, supportsPanel } from "../src/surfaces.js";
import { EXTENSION_ORIGIN } from "../src/contracts.js";
import { runSteps } from "@veyraoss/ui";
import { panelFixture } from "../dev/fixtures.js";

describe("Side Panel security and evidence", () => {
  it("enables only exact chatgpt.com and grants UI authority only to owned surfaces", () => {
    expect(supportsPanel("https://chatgpt.com/c/example")).toBe(true);
    for (const url of [
      "https://evil.chatgpt.com/",
      "https://chatgpt.com.evil.test/",
      "http://chatgpt.com/",
      "file:///chatgpt.com",
    ])
      expect(supportsPanel(url)).toBe(false);
    expect(isExtensionSurface(`${EXTENSION_ORIGIN}/sidepanel.html`)).toBe(true);
    for (const url of [
      "https://chatgpt.com/sidepanel.html",
      `${EXTENSION_ORIGIN}/sidepanel.html?forged`,
      `${EXTENSION_ORIGIN}/content.js`,
    ])
      expect(isExtensionSurface(url)).toBe(false);
  });
  it("keeps successful execution separate from an unrecorded ChatGPT review", () => {
    const steps = runSteps(panelFixture("completed").evidence);
    expect(steps.find((step) => step.id === "verify")?.state).toBe("passed");
    expect(steps.find((step) => step.id === "review")?.state).toBe("pending");
    expect(
      runSteps(panelFixture("failed").evidence).find((step) => step.id === "verify")?.state,
    ).toBe("failed");
  });
  it("does no periodic work or repeated renders over 60 seconds of idle", async () => {
    vi.useFakeTimers();
    const call = vi.fn(async (type: string) =>
      type === "projects" ? [] : { connectivity: { status: "connected" } },
    );
    const store = new PanelStore(call);
    const render = vi.fn();
    store.subscribe(render);
    await store.connect();
    call.mockClear();
    render.mockClear();
    await vi.advanceTimersByTimeAsync(60000);
    expect(call).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    await store.refresh();
    await store.refresh();
    expect(render).not.toHaveBeenCalled();
    store.close();
    await store.refresh();
    expect(call).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
  it("includes the rendered conversation identity in every user action", async () => {
    const call = vi.fn(async () => ({
      connectivity: { status: "connected" },
      conversation: "conversation-A",
      tabId: 7,
    }));
    const store = new PanelStore(call);
    await store.refresh();
    await store.act("unbind");
    expect(call).toHaveBeenCalledWith(
      "unbind",
      expect.objectContaining({ expectedConversation: "conversation-A", expectedTabId: 7 }),
    );
  });
});
