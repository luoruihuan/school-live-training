import test from "node:test";
import assert from "node:assert/strict";
import { quotaState } from "./usage-quota.js";

test("达到年度 10000 GB 后阻止新的直播地址", () => {
  const state = quotaState("2026-01-01", 10_000, [{ date: "2026-06-01", billedMb: 10_000_000 }], "2026-06-02");
  assert.equal(state.blocked, true);
  assert.match(state.reason, /10,000/);
});

test("低于额度时允许新的直播地址", () => {
  const state = quotaState("2026-01-01", 10_000, [{ date: "2026-06-01", billedMb: 9_500_000 }], "2026-06-02");
  assert.equal(state.blocked, false);
  assert.equal(state.usedMb, 9_500_000);
});

test("服务期外不允许新的直播地址", () => {
  const state = quotaState("2026-01-01", 10_000, [], "2028-01-01");
  assert.equal(state.blocked, true);
  assert.match(state.reason, /服务期/);
});
