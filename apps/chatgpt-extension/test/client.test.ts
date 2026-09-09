import { expect, it, vi } from "vitest";
import { exchangePairing, LocalClient } from "../src/client.js";
import { EXTENSION_ORIGIN, type Pairing } from "../src/contracts.js";
import type { ProjectId } from "@veyraoss/protocol";

const grant: Pairing = {
  version: 1,
  url: "http://127.0.0.1:3181",
  origin: EXTENSION_ORIGIN,
  token: "f".repeat(64),
  expiresAt: Date.now() + 60000,
  projectIds: ["62bf60b0-5646-4195-9f47-a4ea70140859" as ProjectId],
};
it("refuses changed pairing scope or endpoint and blocks expired/cross-Project calls before network access", async () => {
  const { token, ...base } = grant;
  const invitation = { ...base, code: token };
  for (const change of [
    { url: "http://127.0.0.1:3182" },
    { projectIds: ["8e7dc509-d7f1-4d0a-958c-8c98ff011e64"] },
  ]) {
    const request = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ ok: true, data: { ...grant, ...change } })),
    );
    await expect(exchangePairing(invitation, request)).rejects.toThrow("不一致");
  }
  const request = vi.fn<typeof fetch>();
  await expect(
    new LocalClient(grant, request).call("projects.get", {
      projectId: "8e7dc509-d7f1-4d0a-958c-8c98ff011e64" as ProjectId,
    }),
  ).rejects.toThrow("授权范围");
  await expect(
    new LocalClient({ ...grant, expiresAt: 0 }, request).call("projects.list", undefined),
  ).rejects.toThrow("过期");
  expect(request).not.toHaveBeenCalled();
});
it("bounds streamed responses and refuses malformed daemon replies", async () => {
  const cancel = vi.fn();
  const request = vi.fn<typeof fetch>(async (_url, options) => {
    expect(options?.credentials).toBe("omit");
    expect(options?.redirect).toBe("error");
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(256 * 1024 + 1));
        },
        cancel,
      }),
    );
  });
  const client = new LocalClient(grant, request);
  await expect(client.call("projects.list", undefined)).rejects.toThrow("超出上限");
  expect(cancel).toHaveBeenCalled();
  request.mockResolvedValueOnce(
    new Response(JSON.stringify({ ok: true, data: [{ project: "invented" }] })),
  );
  await expect(client.call("projects.list", undefined)).rejects.toThrow("不符合协议");
});
