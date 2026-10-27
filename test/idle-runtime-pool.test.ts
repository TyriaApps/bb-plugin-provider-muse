import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IdleRuntimePool } from "../src/idle-runtime-pool.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("keeps recent sessions warm, evicts the oldest idle session, and expires the rest", () => {
  const reclaim = vi.fn();
  const pool = new IdleRuntimePool<string>(30 * 60_000, 2, reclaim);
  pool.release("first");
  vi.advanceTimersByTime(3 * 60_000);
  expect(reclaim).not.toHaveBeenCalled();
  pool.release("second");
  pool.release("third");
  expect(reclaim.mock.calls).toEqual([["first"]]);
  vi.advanceTimersByTime(30 * 60_000);
  expect(reclaim.mock.calls).toEqual([["first"], ["second"], ["third"]]);
  expect(vi.getTimerCount()).toBe(0);
});

it("never reclaims a session reactivated before expiry", () => {
  const reclaim = vi.fn();
  const pool = new IdleRuntimePool<string>(1000, 1, reclaim);
  pool.release("active");
  vi.advanceTimersByTime(999);
  pool.activate("active");
  pool.release("idle");
  vi.advanceTimersByTime(1000);
  expect(reclaim.mock.calls).toEqual([["idle"]]);
});

it("refreshes expiry and eviction order on repeated release without leaving stale timers", () => {
  const reclaim = vi.fn();
  const pool = new IdleRuntimePool<string>(1000, 2, reclaim);
  pool.release("first");
  pool.release("second");
  vi.advanceTimersByTime(500);
  pool.release("first");
  pool.release("third");
  expect(reclaim.mock.calls).toEqual([["second"]]);
  vi.advanceTimersByTime(500);
  expect(reclaim).toHaveBeenCalledTimes(1);
  pool.activate("third");
  vi.advanceTimersByTime(500);
  expect(reclaim.mock.calls).toEqual([["second"], ["first"]]);
  expect(vi.getTimerCount()).toBe(0);
});
