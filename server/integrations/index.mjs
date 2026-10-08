// Registry of White Petal integrations. Each module exports { meta, test, collect } plus provider-specific helpers
// (bing/indexnow.submitUrls, google.oauthUrl/exchangeCode/ensureToken/listProperties, serp.aiOverview/aiMode/organic, slack.notify).
import * as bing from "./bing.mjs";
import * as indexnow from "./indexnow.mjs";
import * as google from "./google.mjs";
import * as cloudflare from "./cloudflare.mjs";
import * as entity from "./entity.mjs";
import * as serp from "./serp.mjs";
import * as slack from "./slack.mjs";

export const PROVIDERS = { bing, indexnow, google, cloudflare, entity, serp, slack };

export const listMeta = () => Object.values(PROVIDERS).map((p) => p.meta);
export const getProvider = (id) => PROVIDERS[id] || null;
// Field keys that must be stored encrypted / never sent back to the browser.
export const secretFields = (id) => (PROVIDERS[id]?.meta.fields || []).filter((f) => f.secret).map((f) => f.key);
