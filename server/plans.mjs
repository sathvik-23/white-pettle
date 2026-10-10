// The canonical plan catalogue. Prices are in the smallest currency unit (cents, paise), monthly, before tax.
// The browser and the Bloom landing page read the public view of this; only the server makes decisions from it
// (server/billing.mjs). Razorpay plan ids live in the environment, never here.
const plan = (code, name, prices, featured, entitlements, budget = null) => Object.freeze({
  code, name, prices: Object.freeze(prices), featured, entitlements: Object.freeze(entitlements), budget: budget && Object.freeze(budget),
});

const ALL_ENGINES = Object.freeze(["chatgpt", "perplexity", "gemini", "aio", "aimode", "claude", "groq"]);
const CORE_ENGINES = Object.freeze(["chatgpt", "perplexity", "gemini"]);
const BASIC_INTEGRATIONS = Object.freeze(["bing", "indexnow", "entity"]);

export const SELF_SERVE = Object.freeze(["starter", "growth", "agency"]);
export const CURRENCIES = Object.freeze(["USD", "INR"]);

// `budget` is the monthly direct-cost allowance (USD) from the approved margin model: payment reserve is 5% of
// revenue on top of these. Together they must leave at least 70% gross margin (test/server/plans.test.mjs).
export const PLANS = Object.freeze({
  legacy: plan("legacy", "Legacy", { USD: 0, INR: 0 }, false, {
    brands: Infinity, questions: Infinity, competitorsPerBrand: Infinity,
    engines: ALL_ENGINES, schedule: ["off", "weekly", "rotating", "daily"], samples: 5, seats: Infinity,
    actionDrafts: Infinity, integrations: "all", whiteLabel: true, api: true, trendMonths: Infinity,
  }),
  trial: plan("trial", "Growth trial", { USD: 0, INR: 0 }, false, {
    brands: 1, questions: 10, competitorsPerBrand: 3,
    engines: CORE_ENGINES, schedule: ["off"], samples: 1,
    seats: 1, actionDrafts: 10, integrations: [], whiteLabel: false, api: false, trendMonths: 1,
    baselineRuns: 2,
  }),
  starter: plan("starter", "Starter", { USD: 4900, INR: 499900 }, false, {
    brands: 1, questions: 15, competitorsPerBrand: 3,
    engines: CORE_ENGINES, schedule: ["off", "weekly"], samples: 1,
    seats: 1, actionDrafts: 10, integrations: BASIC_INTEGRATIONS, whiteLabel: false, api: false, trendMonths: 6,
  }, { aiUsd: 5, infraUsd: 1, supportUsd: 4 }),
  growth: plan("growth", "Growth", { USD: 9900, INR: 999900 }, true, {
    brands: 1, questions: 30, competitorsPerBrand: 5,
    engines: ALL_ENGINES, schedule: ["off", "weekly", "rotating"], samples: 1, seats: 5, actionDrafts: 30,
    integrations: [...BASIC_INTEGRATIONS, "google", "cloudflare", "slack"], whiteLabel: false, api: false, trendMonths: 12,
  }, { aiUsd: 14, infraUsd: 2, supportUsd: 7 }),
  agency: plan("agency", "Agency", { USD: 24900, INR: 2499900 }, false, {
    brands: 5, questions: 100, competitorsPerBrand: 5,
    engines: ALL_ENGINES, schedule: ["off", "weekly", "rotating"], samples: 1, seats: 20, actionDrafts: 100,
    integrations: "all", whiteLabel: true, api: "export", trendMonths: 24,
  }, { aiUsd: 38, infraUsd: 5, supportUsd: 17 }),
  enterprise: plan("enterprise", "Enterprise", { USD: 99900, INR: 9999900 }, false, {
    brands: 20, questions: 300, competitorsPerBrand: 20,
    engines: ALL_ENGINES, schedule: ["off", "weekly", "rotating", "daily"], samples: 3, seats: 100,
    actionDrafts: 500, integrations: "all", whiteLabel: true, api: true, trendMonths: 36,
  }),
});

export const ENTITLEMENT_KEYS = Object.freeze(Object.keys(PLANS.legacy.entitlements).concat("baselineRuns"));

// Plan entitlements with contract or operator overrides on top. An unknown code gets the trial's (the tightest).
export function effectiveEntitlements(code, overrides = {}) {
  const base = PLANS[code]?.entitlements || PLANS.trial.entitlements;
  return Object.freeze({ ...base, ...(overrides || {}) });
}

// What the browser and the landing page may see: no provider ids, no internal budgets.
export function publicPlans() {
  return ["starter", "growth", "agency", "enterprise"].map((code) => {
    const p = PLANS[code];
    return { code: p.code, name: p.name, prices: p.prices, featured: p.featured, selfServe: SELF_SERVE.includes(code), entitlements: p.entitlements };
  });
}
