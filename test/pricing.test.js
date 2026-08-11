import assert from "node:assert/strict";
import test from "node:test";

import { calculateRequestCost } from "../src/pricing.js";

test("GPT-5.6 Sol pricing separates cached and uncached input", () => {
  const cost = calculateRequestCost({ input: 100_000, cached: 80_000, cacheWrite: 0, output: 1_000 }, "gpt-5.6-sol");
  assert.equal(cost.uncachedInputTokens, 20_000);
  assert.equal(cost.components.uncachedInput, 0.1);
  assert.equal(cost.components.cachedInput, 0.04);
  assert.equal(cost.components.output, 0.03);
  assert.equal(cost.total, 0.17);
  assert.equal(cost.longContext, false);
});

test("GPT-5.6 Sol pricing applies long-context multipliers per request", () => {
  const cost = calculateRequestCost({ input: 300_000, cached: 200_000, cacheWrite: 0, output: 10_000 }, "gpt-5.6-sol");
  assert.equal(cost.longContext, true);
  assert.equal(cost.components.uncachedInput, 1);
  assert.equal(cost.components.cachedInput, 0.2);
  assert.equal(cost.components.output, 0.45);
  assert.equal(cost.total, 1.65);
});
