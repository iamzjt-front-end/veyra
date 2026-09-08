import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeadline } from "../src/index.js";

afterEach(() => vi.useRealTimers());
describe("cooperative execution deadline", () => {
  it("distinguishes timeouts from external cancellation and releases timers/listeners", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const timed = createDeadline(20, controller.signal);
    vi.advanceTimersByTime(20);
    expect(timed.signal.aborted).toBe(true);
    expect(timed.timedOut()).toBe(true);
    timed.dispose();
    const cancelled = createDeadline(30, controller.signal);
    controller.abort();
    expect(cancelled.signal.aborted).toBe(true);
    expect(cancelled.timedOut()).toBe(false);
    cancelled.dispose();
    const done = createDeadline(30);
    done.dispose();
    vi.advanceTimersByTime(30);
    expect(done.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("propagates an already-aborted signal and rejects invalid timeouts", () => {
    const deadline = createDeadline(undefined, AbortSignal.abort());
    expect(deadline.signal.aborted).toBe(true);
    deadline.dispose();
    for (const timeout of [0, -1, Number.NaN, 1.5, 86_400_001])
      expect(() => createDeadline(timeout)).toThrow();
  });
  it("keeps the first cause while cleanup continues past a later deadline or parent abort", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const cancelled = createDeadline(20, parent.signal);
    const reason = new Error("Ephemeral caller reason");
    parent.abort(reason);
    vi.advanceTimersByTime(30);
    expect(cancelled.signal.reason).toBe(reason);
    expect(cancelled.timedOut()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    cancelled.dispose();
    const lateParent = new AbortController();
    const timed = createDeadline(20, lateParent.signal);
    vi.advanceTimersByTime(20);
    const firstReason = timed.signal.reason;
    lateParent.abort(reason);
    expect(timed.timedOut()).toBe(true);
    expect(timed.signal.reason).toBe(firstReason);
    timed.dispose();
    const already = createDeadline(1000, AbortSignal.abort());
    expect(vi.getTimerCount()).toBe(0);
    already.dispose();
  });
});
