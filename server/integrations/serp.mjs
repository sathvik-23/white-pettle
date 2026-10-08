// Google AI Overviews, AI Mode and organic top-10 (PAID, optional). Two interchangeable backends:
// - DataForSEO (Basic auth): https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/ and /v3/serp/google/ai_mode/live/advanced/
// - SerpApi (api_key):      https://serpapi.com/ai-overview  https://serpapi.com/google-ai-mode-api
// Every call here costs money, so collect() runs one SERP request per query (AI Overview + organic come back together) and skips AI Mode.
import { http, safeTest, hostOf, clip } from "./_http.mjs";

const DFS = "https://api.dataforseo.com/v3";
const SERPAPI = "https://serpapi.com";

export const meta = {
  id: "serp",
  name: "Google AI Overviews & AI Mode",
  category: "ai-search",
  auth: "key",
  free: false,
  fields: [
    { key: "backend", label: "Provider", secret: false, placeholder: "dataforseo or serpapi", help: "Which paid SERP API to use: dataforseo or serpapi." },
    { key: "login", label: "DataForSEO login", secret: false, placeholder: "you@company.com", help: "DataForSEO dashboard → API Access (API login, not your account password page)." },
    { key: "password", label: "DataForSEO API password", secret: true, placeholder: "API password", help: "DataForSEO dashboard → API Access → API password." },
    { key: "apiKey", label: "SerpApi key", secret: true, placeholder: "SerpApi private key", help: "serpapi.com → Dashboard → Your Private API Key." },
    { key: "locationName", label: "Location", secret: false, placeholder: "United States", help: "Country or city Google should search from." },
    { key: "languageCode", label: "Language", secret: false, placeholder: "en", help: "Two-letter language code." },
  ],
  blurb: "Checks whether Google's AI Overviews and AI Mode cite your site (or competitors) for your buyer questions, next to the classic top-10.",
  docs: "https://app.dataforseo.com/api-access",
};

const backendOf = (cfg) => (String(cfg.backend || (cfg.apiKey && !cfg.login ? "serpapi" : "dataforseo")).toLowerCase() === "serpapi" ? "serpapi" : "dataforseo");
const loc = (cfg) => cfg.locationName || "United States";
const lang = (cfg) => cfg.languageCode || "en";
const GL = { "united states": "us", "united kingdom": "uk", canada: "ca", australia: "au", india: "in", germany: "de", france: "fr", spain: "es", italy: "it", netherlands: "nl", ireland: "ie", "new zealand": "nz", singapore: "sg", brazil: "br", mexico: "mx", japan: "jp", sweden: "se", switzerland: "ch", "south africa": "za", "united arab emirates": "ae" };
const glOf = (cfg) => GL[String(loc(cfg)).split(",").pop().trim().toLowerCase()] || "us";
const ref = (url, title) => ({ url: url || null, title: title || null, domain: hostOf(url) || null });
const dedupe = (refs) => { const seen = new Set(); return refs.filter((r) => r.url && !seen.has(r.url) && seen.add(r.url)); };
const EMPTY = { present: false, text: "", references: [], brands: [] };

// ---------- DataForSEO ----------
async function dfs(cfg, ctx, path, task) {
  if (!cfg.login || !cfg.password) throw new Error("Add your DataForSEO API login and password.");
  const auth = `Basic ${Buffer.from(`${cfg.login}:${cfg.password}`).toString("base64")}`;
  const r = await http(ctx, `${DFS}${path}`, task ? { method: "POST", json: [task], headers: { authorization: auth } } : { headers: { authorization: auth } });
  if (r.status === 0) throw new Error(`Couldn't reach DataForSEO (${r.error}).`);
  const top = r.data?.status_code, t = r.data?.tasks?.[0], msg = clip(t?.status_message || r.data?.status_message);
  if (r.status === 401 || top === 40100 || top === 40101) throw new Error("DataForSEO rejected the login/password. Use the API credentials from the API Access page.");
  if (r.status === 402 || top === 40200 || top === 40210 || t?.status_code === 40200 || t?.status_code === 40210) throw new Error("DataForSEO account is out of credit. Top up the balance.");
  if (r.status === 429 || top === 40202) throw new Error("DataForSEO rate limit hit. Try again shortly.");
  if (!r.ok || (top && top !== 20000)) throw new Error(`DataForSEO error ${top || r.status}${msg ? `: ${msg}` : ""}`);
  if (t && t.status_code !== 20000) throw new Error(`DataForSEO task error ${t.status_code}${msg ? `: ${msg}` : ""}`);
  return t?.result?.[0] || {};
}

// ai_overview item → { present, text, references }. References live on the item and/or on each ai_overview_element.
function parseDfsAio(item) {
  if (!item) return { ...EMPTY };
  const els = item.items || [];
  const text = item.markdown || els.map((e) => [e.title, e.text || e.markdown].filter(Boolean).join("\n")).filter(Boolean).join("\n\n");
  const refs = [...(item.references || []), ...els.flatMap((e) => e.references || [])].map((x) => ref(x.url, x.title || x.source));
  return { present: true, text: String(text || "").trim(), references: dedupe(refs), brands: [] };
}
const dfsOrganic = (items) => (items || []).filter((i) => i.type === "organic").slice(0, 10).map((i) => ({ position: i.rank_group, url: i.url, domain: i.domain || hostOf(i.url), title: i.title || "" }));

async function dfsGoogle(cfg, query, ctx) {
  const res = await dfs(cfg, ctx, "/serp/google/organic/live/advanced", { keyword: query, location_name: loc(cfg), language_code: lang(cfg), device: "desktop", depth: 10, load_async_ai_overview: true });
  const items = res.items || [];
  return { aiOverview: parseDfsAio(items.find((i) => i.type === "ai_overview")), organic: { results: dfsOrganic(items) } };
}
async function dfsAiMode(cfg, query, ctx) {
  const res = await dfs(cfg, ctx, "/serp/google/ai_mode/live/advanced", { keyword: query, location_name: loc(cfg), language_code: lang(cfg), device: "desktop" });
  return parseDfsAio((res.items || []).find((i) => i.type === "ai_overview"));
}

// ---------- SerpApi ----------
async function sapi(cfg, ctx, params) {
  if (!cfg.apiKey) throw new Error("Add your SerpApi key.");
  const r = await http(ctx, `${SERPAPI}/search.json?${new URLSearchParams({ ...params, api_key: cfg.apiKey })}`, { headers: { accept: "application/json" } });
  if (r.status === 0) throw new Error(`Couldn't reach SerpApi (${r.error}).`);
  const msg = clip(r.data?.error);
  if (r.status === 401 || /invalid api key/i.test(msg)) throw new Error("SerpApi rejected the API key.");
  if (r.status === 429 || /run out of searches|plan.*limit/i.test(msg)) throw new Error("SerpApi account is out of searches (or rate-limited).");
  if (!r.ok) throw new Error(`SerpApi error ${r.status}${msg ? `: ${msg}` : ""}`);
  return r.data || {};
}

// text_blocks → plain text (paragraphs, headings, lists incl. nested lists, simple tables).
function blocksText(blocks = []) {
  const out = [];
  const walk = (b, depth = 0) => { // depth > 0 = list item
    const t = [b.title, b.snippet].filter(Boolean).join(" ");
    if (t) out.push(depth ? `${"  ".repeat(depth - 1)}- ${t}` : t);
    for (const li of b.list || []) walk(li, depth + 1);
    for (const row of b.table || []) out.push([].concat(row).join(" | "));
    for (const sub of b.text_blocks || []) walk(sub, depth);
  };
  for (const b of blocks) walk(b);
  return out.join("\n").trim();
}
function parseSerpApiBlock(o) {
  if (!o || !(o.text_blocks?.length || o.reconstructed_markdown)) return { ...EMPTY };
  return { present: true, text: o.reconstructed_markdown || blocksText(o.text_blocks), references: dedupe((o.references || []).map((x) => ref(x.link, x.title || x.source))), brands: [] };
}
const sapiOrganic = (d) => (d.organic_results || []).slice(0, 10).map((o, i) => ({ position: o.position || i + 1, url: o.link, domain: hostOf(o.link), title: o.title || "" }));

async function sapiGoogle(cfg, query, ctx) {
  const d = await sapi(cfg, ctx, { engine: "google", q: query, location: loc(cfg), hl: lang(cfg), gl: glOf(cfg) });
  let aio = d.ai_overview;
  // Google sometimes loads the AI Overview separately; the page_token expires within ~1 minute, so fetch it right away.
  if (aio?.page_token && !aio.text_blocks) aio = (await sapi(cfg, ctx, { engine: "google_ai_overview", page_token: aio.page_token }).catch(() => ({}))).ai_overview;
  return { aiOverview: parseSerpApiBlock(aio), organic: { results: sapiOrganic(d) } };
}
async function sapiAiMode(cfg, query, ctx) {
  return parseSerpApiBlock(await sapi(cfg, ctx, { engine: "google_ai_mode", q: query, location: loc(cfg), hl: lang(cfg), gl: glOf(cfg) }));
}

// ---------- public API ----------
const google = (cfg, q, ctx) => (backendOf(cfg) === "serpapi" ? sapiGoogle : dfsGoogle)(cfg, q, ctx);
export async function aiOverview(cfg, query, ctx = {}) { return (await google(cfg, query, ctx)).aiOverview; }
export async function organic(cfg, query, ctx = {}) { return (await google(cfg, query, ctx)).organic; }
export async function aiMode(cfg, query, ctx = {}) { return (backendOf(cfg) === "serpapi" ? sapiAiMode : dfsAiMode)(cfg, query, ctx); }

export async function test(cfg, ctx = {}) {
  return safeTest(async () => {
    if (backendOf(cfg) === "serpapi") {
      if (!cfg.apiKey) return { ok: false, detail: "Add your SerpApi key." };
      const r = await http(ctx, `${SERPAPI}/account.json?${new URLSearchParams({ api_key: cfg.apiKey })}`, { headers: { accept: "application/json" } });
      if (r.status === 0) return { ok: false, detail: `Couldn't reach SerpApi (${r.error}).` };
      if (r.status === 401 || r.data?.error) return { ok: false, detail: r.status === 401 || /api key/i.test(r.data?.error) ? "SerpApi rejected the API key." : `SerpApi error: ${clip(r.data.error)}` };
      if (!r.ok) return { ok: false, detail: `SerpApi error ${r.status}` };
      const d = r.data || {};
      return { ok: true, detail: `Connected to SerpApi (${d.plan_name || "plan"}; ${d.total_searches_left ?? d.plan_searches_left ?? "?"} searches left)` };
    }
    const u = await dfs(cfg, ctx, "/appendix/user_data");
    const bal = u.money?.balance;
    return { ok: true, detail: `Connected to DataForSEO as ${u.login || cfg.login}${bal != null ? ` (balance $${Number(bal).toFixed(2)})` : ""}` };
  });
}

// Up to 10 tracked queries: AI Overview + organic top-10 from one SERP request each (sequential to stay under rate limits).
export async function collect(cfg, ctx = {}) {
  const queries = (ctx.queries || []).filter(Boolean).slice(0, 10), results = [];
  for (const query of queries) {
    try { const g = await google(cfg, query, ctx); results.push({ query, aiOverview: g.aiOverview, organic: g.organic.results }); }
    catch (e) {
      results.push({ query, error: e.message });
      if (/rejected|out of credit|out of searches|Add your/i.test(e.message)) break; // no point burning through the rest
    }
  }
  const ok = results.filter((r) => !r.error);
  return { backend: backendOf(cfg), location: loc(cfg), language: lang(cfg), checked: results.length, withAiOverview: ok.filter((r) => r.aiOverview.present).length, results };
}
