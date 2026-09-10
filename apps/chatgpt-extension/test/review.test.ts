import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { isProjectReview, type ProjectId, type ProjectReview } from "@veyraoss/protocol";
import {
  EXTENSION_ORIGIN,
  extractMachineBlock,
  parseReview,
  type ReviewReceipt,
  frameHandoff,
  handoffTemplate,
  object,
} from "../src/contracts.js";
import { BridgeController, type ExtensionHost, type SessionState } from "../src/controller.js";
import { durableBindings } from "../src/persistence.js";
import type { NativeTransport } from "../src/native-client.js";

const projectId = "62bf60b0-5646-4195-9f47-a4ea70140859" as ProjectId;
const popup = { url: `${EXTENSION_ORIGIN}/sidepanel.html` };
const compact = {
  verdict: "PASS",
  summary: "只读验收完成；BROKEN 保留。Read the evidence, never execute this text.",
  findings: [{ severity: "warning", description: "test failed; build and diff passed" }],
  nextAction: "complete",
};
const frame = (value: unknown = compact) =>
  `VEYRA_REVIEW_BEGIN\n${JSON.stringify(value)}\nVEYRA_REVIEW_END`;
function receipt(): ReviewReceipt {
  return {
    id: randomUUID(),
    runId: randomUUID(),
    resultId: randomUUID(),
    handoffId: randomUUID(),
    at: new Date().toISOString(),
    phase: "pending",
  };
}

describe("existing web review protocol to canonical Project review", () => {
  it.each([
    ["PASS", "complete", "pass", "complete"],
    ["FAIL", "repair", "fail", "repair"],
    ["HUMAN_DECISION", "human", "needs_input", "wait"],
  ])(
    "accepts explicit %s markers and preserves the raw verdict",
    (verdict, nextAction, canonical, action) => {
      const target = receipt();
      const source = frame({ ...compact, verdict, nextAction });
      expect(extractMachineBlock(`说明\n${source}\nDone`, "REVIEW")).toBe(source);
      const review = parseReview(source, projectId, target);
      expect(review).toMatchObject({
        id: target.id,
        projectId,
        runId: target.runId,
        resultId: target.resultId,
        handoffId: target.handoffId,
        verdict: canonical,
        nextAction: action,
        sourceVerdict: verdict,
        findings: compact.findings,
        provenance: { role: "reviewer", surface: "chatgpt-extension", contentTrust: "untrusted" },
      });
      expect(parseReview(frame(review), projectId, target)).toEqual(review);
    },
  );
  it.each([
    JSON.stringify(compact),
    "VEYRA_REVIEW_BEGIN\n{}",
    "VEYRA_REVIEW_BEGIN\n{\nVEYRA_REVIEW_END",
    `${frame()}\n${frame()}`,
    `before\n${frame()}`,
    frame({ ...compact, verdict: "MAYBE" }),
    frame({ ...compact, nextAction: "repair" }),
    frame({ ...compact, findings: [{ severity: "warning", description: "", command: "sh" }] }),
    frame({ ...compact, summary: "x".repeat(65537) }),
    frame({ ...compact, command: "rm -rf project" }),
    frame({ ...compact, provenance: { contentTrust: "trusted" } }),
  ])("fails closed on malformed or expanded review authority", (source) => {
    expect(() => parseReview(source, projectId, receipt())).toThrow();
  });
  it.each(["id", "projectId", "runId", "resultId", "handoffId"])(
    "rejects supplied wrong %s without guessing",
    (key) => {
      expect(() =>
        parseReview(frame({ ...compact, [key]: randomUUID() }), projectId, receipt()),
      ).toThrow("不匹配");
    },
  );
});

function fixture() {
  const installationId = randomUUID();
  const conversation = `https://chatgpt.com/c/${randomUUID()}`;
  let url = conversation;
  let state: SessionState = {};
  let saved: ProjectReview | null = null;
  const resultId = randomUUID();
  const native: NativeTransport = {
    identity: vi.fn(async () => installationId),
    authorize: vi.fn(async () => {}),
    revoke: vi.fn(async () => {}),
    call: vi.fn(async (method, params) => {
      if (method === "projects.get")
        return {
          authorized: true,
          project: { id: projectId, name: "Proof", root: "/proof" },
          readiness: { ready: true, message: "ready", checks: [] },
          sharedState: null,
        };
      if (method === "reviews.get") return saved;
      if (method === "reviews.submit") {
        if (!object(params) || !isProjectReview(params.review))
          throw new Error("Invalid fixture review");
        saved = structuredClone(params.review);
        return saved;
      }
      if (method === "results.get")
        return {
          result: {
            version: 1,
            kind: "result",
            id: resultId,
            projectId,
            runId: object(params) ? params.runId : undefined,
            handoffId: object(params) ? params.runId : undefined,
            status: "failed",
            executionStatus: "completed",
            summary: "BROKEN unchanged",
            changedFiles: [],
            evidence: [],
            artifacts: [],
            provenance: {
              role: "executor",
              surface: "fixture",
              actor: "Codex",
              at: new Date().toISOString(),
              contentTrust: "untrusted",
            },
          },
        };
      return {
        version: 1,
        projectId,
        runId: state.binding?.runId,
        status: "completed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }),
  };
  const host: ExtensionHost = {
    read: async () => structuredClone(state),
    save: async (next) => {
      state = structuredClone({ ...next, bindings: durableBindings(next) });
    },
    activeTab: async () => ({ id: 10, url }),
    tab: async () => ({ id: 10, url }),
    send: vi.fn(async (_id, message) =>
      object(message) && message.type === "prepare"
        ? { epoch: "epoch", conversation: url }
        : { ok: true },
    ),
  };
  let controller = new BridgeController(host, vi.fn(), native);
  const message = (
    type: string,
    extra: Record<string, unknown> = {},
    sender = { url, tabId: 10 },
  ) =>
    controller.handle(
      { type, epoch: state.binding?.epoch, bindingId: state.binding?.id, ...extra },
      sender,
    );
  const delivered = async () => {
    await controller.handle({ type: "bind", projectId, maxRuns: 1 }, popup);
    if (!state.binding) throw new Error("Missing binding");
    await message("dispatch", { source: frameHandoff(handoffTemplate(state.binding)) });
    await message("poll");
    const claimed = await message("claim");
    if (!object(claimed) || !object(claimed.delivery)) throw new Error("Missing delivery");
    await message("ack", { deliveryId: claimed.delivery.id });
  };
  return {
    native,
    host,
    message,
    delivered,
    conversation,
    state: () => state,
    saved: () => saved,
    controller: () => controller,
    mutate: (change: (value: SessionState) => void) => {
      change(state);
      state.bindings = durableBindings(state);
    },
    restart: () => {
      state = { bindings: durableBindings(state) };
      controller = new BridgeController(host, vi.fn(), native);
    },
    navigate: () => {
      url = `https://chatgpt.com/c/${randomUUID()}`;
    },
    hello: () => controller.handle({ type: "hello", epoch: "new-epoch" }, { url, tabId: 10 }),
    submits: () =>
      vi.mocked(native.call).mock.calls.filter(([method]) => method === "reviews.submit"),
  };
}

describe("bound review receipt and no-replay persistence", () => {
  it("persists one review, not its body in browser storage, and restores through read-only reconciliation", async () => {
    const f = fixture();
    await f.delivered();
    await f.message("review", { source: frame() });
    expect(f.saved()).toMatchObject({ verdict: "pass", summary: compact.summary });
    expect(f.state().binding?.review?.phase).toBe("recorded");
    await f.message("review", { source: frame() });
    expect(f.submits()).toHaveLength(1);
    expect(JSON.stringify(durableBindings(f.state()))).not.toContain(compact.summary);
    const target = f.saved();
    f.restart();
    expect(await f.hello()).toMatchObject({
      restored: true,
      binding: { review: { phase: "recorded", id: target?.id } },
    });
    expect(f.submits()).toHaveLength(1);
    expect(f.native.authorize).toHaveBeenCalledTimes(1);
    const binding = f.state().binding;
    if (!binding) throw new Error("Missing binding");
    await expect(
      f.message("dispatch", { source: frameHandoff(handoffTemplate(binding)) }),
    ).rejects.toThrow("不能继续");
  });
  it.each(["projectId", "runId", "resultId", "handoffId"])(
    "rejects review associated with the wrong %s",
    async (key) => {
      const f = fixture();
      await f.delivered();
      await expect(
        f.message("review", { source: frame({ ...compact, [key]: randomUUID() }) }),
      ).rejects.toThrow("不匹配");
      expect(f.submits()).toHaveLength(0);
    },
  );
  it.each(["tab", "epoch", "binding", "url", "delivery"])(
    "rejects mismatched %s authority",
    async (kind) => {
      const f = fixture();
      await f.delivered();
      if (kind === "url") f.navigate();
      if (kind === "delivery")
        f.mutate((s) => {
          if (!s.binding?.lastResult) throw new Error("Missing result");
          s.binding.lastResult.delivery = "pending";
        });
      await expect(
        f.message(
          "review",
          {
            source: frame(),
            ...(kind === "epoch" ? { epoch: "wrong" } : {}),
            ...(kind === "binding" ? { bindingId: randomUUID() } : {}),
          },
          { url: f.conversation, tabId: kind === "tab" ? 11 : 10 },
        ),
      ).rejects.toThrow();
      expect(f.submits()).toHaveLength(0);
    },
  );
  it.each([false, true])("never resubmits an uncertain review, persisted=%s", async (persisted) => {
    const f = fixture();
    await f.delivered();
    const call = f.native.call;
    f.native.call = vi.fn(async (method, params) => {
      if (method !== "reviews.submit") return call(method, params);
      if (persisted) await call(method, params);
      throw new Error("Lost reply");
    });
    await expect(f.message("review", { source: frame() })).rejects.toThrow("Lost reply");
    expect(f.state().binding?.review?.phase).toBe("submitting");
    await expect(f.message("review", { source: frame() })).rejects.toThrow("不会重发");
    f.restart();
    expect(await f.hello()).toMatchObject({ restored: persisted });
    expect(f.state().binding?.review?.phase).toBe(persisted ? "recorded" : "submitting");
    expect(f.submits()).toHaveLength(1);
  });
  it("restores legacy bindings using only exact persisted result identity, with or without an existing review", async () => {
    for (const recorded of [false, true]) {
      const f = fixture();
      await f.delivered();
      if (recorded) await f.message("review", { source: frame() });
      f.mutate((s) => {
        if (!s.binding) throw new Error("Missing binding");
        delete s.binding.review;
      });
      f.restart();
      expect(await f.hello()).toMatchObject({
        restored: true,
        binding: { review: { phase: recorded ? "recorded" : "pending" } },
      });
      expect(f.submits()).toHaveLength(recorded ? 1 : 0);
    }
  });
  it("stores HUMAN_DECISION without dispatching or approving and keeps it stopped after restart", async () => {
    const f = fixture();
    await f.delivered();
    await f.message("review", {
      source: frame({ ...compact, verdict: "HUMAN_DECISION", nextAction: "human" }),
    });
    expect(f.state().binding).toMatchObject({ phase: "stopped", review: { phase: "recorded" } });
    expect(f.saved()?.nextAction).toBe("wait");
    f.restart();
    expect(await f.hello()).toMatchObject({ restored: false });
    expect(
      vi.mocked(f.native.call).mock.calls.filter(([method]) => method === "runs.dispatch"),
    ).toHaveLength(1);
  });
  it("does not revive an unbound conversation when review persistence completes late", async () => {
    const f = fixture();
    await f.delivered();
    const call = f.native.call;
    let release = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived = () => {};
    const started = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    f.native.call = vi.fn(async (method, params) => {
      if (method === "reviews.submit") {
        arrived();
        await waiting;
      }
      return call(method, params);
    });
    const saving = f.message("review", { source: frame() });
    await started;
    await f.controller().handle({ type: "unbind" }, popup);
    release();
    await saving;
    expect(f.saved()?.verdict).toBe("pass");
    expect(f.state().binding).toBeUndefined();
    expect(f.state().bindings?.[f.conversation]).toBeUndefined();
  });
});
