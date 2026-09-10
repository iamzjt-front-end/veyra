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
  it("refreshes review from canonical evidence on receipt changes and restores it in a new panel", async () => {
    const sample = panelFixture("review-approved");
    const binding = sample.binding;
    const result = sample.evidence.result;
    if (!binding || !result) throw new Error("Missing fixture");
    binding.review = {
      id: "review-fixture",
      runId: result.runId,
      resultId: result.id,
      handoffId: result.handoffId,
      at: result.provenance.at,
      phase: "pending",
    };
    let recorded = false;
    const call = vi.fn(async (type: string) =>
      type === "evidence"
        ? { ...sample.evidence, review: recorded ? sample.evidence.review : null }
        : { ...sample, binding: structuredClone(binding), connectivity: { status: "connected" } },
    );
    const store = new PanelStore(call);
    await store.refresh();
    expect(runSteps(store.snapshot().evidence).find((step) => step.id === "review")?.state).toBe(
      "pending",
    );
    recorded = true;
    binding.review.phase = "recorded";
    await store.refresh();
    expect(store.snapshot().evidence.review?.verdict).toBe("pass");
    expect(runSteps(store.snapshot().evidence).find((step) => step.id === "review")?.trailing).toBe(
      "Approved",
    );
    expect(runSteps(store.snapshot().evidence).find((step) => step.id === "verify")?.state).toBe(
      "failed",
    );
    expect(call.mock.calls.filter(([type]) => type === "evidence")).toHaveLength(2);
    await store.refresh();
    expect(call.mock.calls.filter(([type]) => type === "evidence")).toHaveLength(2);
    store.close();
    const reopened = new PanelStore(call);
    await reopened.refresh();
    expect(reopened.snapshot().evidence.review).toEqual(sample.evidence.review);
    reopened.close();
  });
  it("rejects a review for another result instead of showing a false approval", async () => {
    const sample = panelFixture("review-approved");
    if (!sample.evidence.review) throw new Error("Missing review fixture");
    sample.evidence.review.resultId = "wrong-result";
    const store = new PanelStore(
      vi.fn(async (type: string) =>
        type === "evidence"
          ? sample.evidence
          : { ...sample, connectivity: { status: "connected" } },
      ),
    );
    await store.refresh();
    expect(store.snapshot().error).toContain("Review evidence did not match");
    expect(store.snapshot().evidence.review).toBeUndefined();
    store.close();
  });
  it("clears a previous run's approval before loading another run, including failed reads", async () => {
    const sample = panelFixture("review-approved");
    const binding = sample.binding;
    if (!binding) throw new Error("Missing fixture");
    const store = new PanelStore(
      vi.fn(async (type: string) =>
        type === "evidence"
          ? sample.evidence
          : { ...sample, binding: structuredClone(binding), connectivity: { status: "connected" } },
      ),
    );
    await store.refresh();
    expect(store.snapshot().evidence.review?.verdict).toBe("pass");
    binding.runId = "7f208d63-7bb7-435e-9ebd-1556a253dba6";
    await store.refresh();
    expect(store.snapshot().error).toContain("Run evidence did not match");
    expect(store.snapshot().evidence.review).toBeUndefined();
    store.close();
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
