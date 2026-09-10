import { afterEach, expect, it, vi } from "vitest";
import { installContentOnce } from "../src/content-lifecycle.js";

const conversation = "https://chatgpt.com/c/8e7dc509-d7f1-4d0a-958c-8c98ff011e64";
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const scope: { __veyraPageTarget?: string } = {};
  const runtime: { id?: string } = { id: "extension-id" };
  vi.stubGlobal("window", scope);
  vi.stubGlobal("location", { href: conversation });
  vi.stubGlobal("chrome", { runtime });
  const dispose = vi.fn();
  const start = vi.fn(() => dispose);
  return { scope, runtime, dispose, start };
}
it("installs only one live receiver even when declarative and recovery injection overlap", () => {
  const f = fixture();
  installContentOnce(f.start);
  f.scope.__veyraPageTarget = conversation;
  installContentOnce(f.start);
  installContentOnce(f.start);
  expect(f.start).toHaveBeenCalledExactlyOnceWith(true);
  expect(f.dispose).not.toHaveBeenCalled();
  expect(f.scope).not.toHaveProperty("__veyraPageTarget");
});
it("disposes the invalidated instance before explicit recovery, without automatic restore or replay", () => {
  const f = fixture();
  installContentOnce(f.start);
  f.runtime.id = undefined;
  vi.stubGlobal("chrome", { runtime: { id: "extension-id" } });
  f.scope.__veyraPageTarget = conversation;
  installContentOnce(f.start);
  expect(f.dispose).toHaveBeenCalledTimes(1);
  expect(f.start.mock.calls).toEqual([[true], [false]]);
  expect(f.dispose.mock.invocationCallOrder[0]).toBeLessThan(
    f.start.mock.invocationCallOrder[1] ?? 0,
  );
});
it("refuses a same-document conversation change between the probe and file injection", () => {
  const f = fixture();
  f.scope.__veyraPageTarget = conversation;
  vi.stubGlobal("location", { href: "https://chatgpt.com/c/62bf60b0-5646-4195-9f47-a4ea70140859" });
  installContentOnce(f.start);
  expect(f.start).not.toHaveBeenCalled();
  expect(f.scope).not.toHaveProperty("__veyraPageTarget");
});
it("does not install using an invalidated extension runtime", () => {
  const f = fixture();
  f.runtime.id = undefined;
  installContentOnce(f.start);
  expect(f.start).not.toHaveBeenCalled();
});
