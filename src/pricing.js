export const PRICING_VERSION = "2026-08-11";

export const MODEL_PRICING = Object.freeze({
  "gpt-5.6-sol": Object.freeze({
    currency: "USD",
    perMillion: Object.freeze({
      input: 5,
      cachedInput: 0.5,
      cacheWrite: 6.25,
      output: 30,
    }),
    longContext: Object.freeze({
      threshold: 272_000,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
    }),
  }),
});

export function pricingForModel(model) {
  return MODEL_PRICING[model] || null;
}

export function calculateRequestCost(usage, model) {
  const pricing = pricingForModel(model);
  if (!pricing) {
    return {
      available: false,
      currency: "USD",
      kind: "api-equivalent",
      pricingVersion: PRICING_VERSION,
      total: 0,
    };
  }

  const input = Math.max(0, Number(usage.input || 0));
  const cached = Math.min(input, Math.max(0, Number(usage.cached || 0)));
  const cacheWrite = Math.min(input - cached, Math.max(0, Number(usage.cacheWrite || 0)));
  const uncached = Math.max(0, input - cached - cacheWrite);
  const output = Math.max(0, Number(usage.output || 0));
  const longContext = input > pricing.longContext.threshold;
  const inputMultiplier = longContext ? pricing.longContext.inputMultiplier : 1;
  const outputMultiplier = longContext ? pricing.longContext.outputMultiplier : 1;
  const perMillion = 1_000_000;
  const components = {
    uncachedInput: (uncached * pricing.perMillion.input * inputMultiplier) / perMillion,
    cachedInput: (cached * pricing.perMillion.cachedInput * inputMultiplier) / perMillion,
    cacheWrite: (cacheWrite * pricing.perMillion.cacheWrite * inputMultiplier) / perMillion,
    output: (output * pricing.perMillion.output * outputMultiplier) / perMillion,
  };

  return {
    available: true,
    currency: pricing.currency,
    kind: "api-equivalent",
    pricingVersion: PRICING_VERSION,
    longContext,
    uncachedInputTokens: uncached,
    cacheHitRate: input > 0 ? cached / input : 0,
    components,
    total: Object.values(components).reduce((sum, value) => sum + value, 0),
  };
}

export function sumCosts(costs) {
  const available = costs.some((cost) => cost.available);
  const components = { uncachedInput: 0, cachedInput: 0, cacheWrite: 0, output: 0 };
  for (const cost of costs) {
    for (const key of Object.keys(components)) {
      components[key] += cost.components?.[key] || 0;
    }
  }
  return {
    available,
    currency: "USD",
    kind: "api-equivalent",
    pricingVersion: PRICING_VERSION,
    longContextRequestCount: costs.filter((cost) => cost.longContext).length,
    components,
    total: Object.values(components).reduce((sum, value) => sum + value, 0),
  };
}
