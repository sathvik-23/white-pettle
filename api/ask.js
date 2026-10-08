// Ask one live AI engine one buyer question, streaming its search, sources and answer as they happen.
import { sse, guard, body, env, readSSE, ENGINE_MODEL, extractBrands, openaiText, GEMINI_MODELS, pickGroq, fetchRetry, serpConfig } from "./_lib.js";
import * as serp from "../server/integrations/serp.mjs";
export const config = { runtime: "edge" };

const COUNTRY = { india: "IN", "united states": "US", usa: "US", us: "US", america: "US", uk: "GB", "united kingdom": "GB", britain: "GB", canada: "CA", australia: "AU", singapore: "SG", uae: "AE", dubai: "AE", germany: "DE", france: "FR" };
const countryFor = (m) => { m = String(m || "").toLowerCase(); for (const [k, v] of Object.entries(COUNTRY)) if (new RegExp(`\\b${k}\\b`).test(m)) return v; return null; };

async function chatgpt(q, brand, send) {
  const models = [...new Set([ENGINE_MODEL(), "gpt-4.1", "gpt-4o"])];
  const country = countryFor(brand.market);
  let res, used;
  for (const model of models) {
    for (const type of ["web_search", "web_search_preview"]) {
      const tool = { type }; if (country) tool.user_location = { type: "approximate", country };
      res = await fetchRetry("https://api.openai.com/v1/responses", { method: "POST", headers: { authorization: `Bearer ${env("OPENAI_API_KEY")}`, "content-type": "application/json" },
        body: JSON.stringify({ model, input: q, tools: [tool], include: ["web_search_call.action.sources"], stream: true }) });
      if (res.ok) { used = model; break; }
      const err = await res.json().catch(() => ({})); const msg = err?.error?.message || "";
      if (res.status === 401) throw new Error("OpenAI rejected the API key.");
      if (res.status === 429) throw new Error(/quota|billing/i.test(msg) ? "OpenAI credits are used up. Remove OPENAI_API_KEY or add credits." : "OpenAI rate limit reached: " + msg);
      if (!/model|tool|web_search/i.test(msg)) throw new Error(msg || `OpenAI error ${res.status}`);
      if (/model/i.test(msg)) break;
    }
    if (used) break;
  }
  if (!used) throw new Error("No OpenAI model with web search was available for this key.");
  send("status", { text: `Asking ${used} with web search on` });
  let text = ""; const sources = new Map();
  const addSrc = (url, title, cited) => { if (!url) return; const k = url.replace(/[#?].*$/, "").replace(/\/$/, ""); const prev = sources.get(k); if (!prev) { sources.set(k, { url, title: title || "", cited: !!cited }); send("source", { url, title: title || "", cited: !!cited }); } else if (cited && !prev.cited) { prev.cited = true; send("source", { ...prev }); } };
  for await (const { data } of readSSE(res)) {
    const t = data.type;
    if (t === "response.output_text.delta") { text += data.delta; send("delta", { text: data.delta }); }
    else if (t === "response.web_search_call.searching" || t === "response.web_search_call.in_progress") send("status", { text: "Searching the web" });
    else if (t === "response.output_item.done" && data.item?.type === "web_search_call") {
      const a = data.item.action || {};
      if (a.query) send("search", { query: a.query });
      (a.queries || []).forEach((q2) => send("search", { query: q2 }));
      (a.sources || []).forEach((s) => addSrc(s.url, s.title, false));
    }
    else if (t === "response.output_text.annotation.added" && data.annotation?.type === "url_citation") addSrc(data.annotation.url, data.annotation.title, true);
    else if (t === "response.completed") {
      for (const it of data.response?.output || []) {
        if (it.type === "message") for (const c of it.content || []) for (const an of c.annotations || []) if (an.type === "url_citation") addSrc(an.url, an.title, true);
      }
      if (!text) text = openaiText(data.response || {});
    }
    else if (t === "response.failed" || t === "error") throw new Error(data?.response?.error?.message || data?.error?.message || "ChatGPT failed");
  }
  return { text, sources: [...sources.values()], model: used };
}

async function perplexity(q, brand, send) {
  const res = await fetchRetry("https://api.perplexity.ai/chat/completions", { method: "POST", headers: { authorization: `Bearer ${env("PERPLEXITY_API_KEY")}`, "content-type": "application/json" },
    body: JSON.stringify({ model: env("PETTLE_PPLX_MODEL", "sonar"), messages: [{ role: "user", content: q }], stream: true }) });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e?.error?.message || `Perplexity error ${res.status}`); }
  send("status", { text: "Perplexity is searching and reading" });
  let text = ""; const seen = new Set(); const sources = [];
  for await (const { data } of readSSE(res)) {
    const d = data.choices?.[0]?.delta?.content; if (d) { const clean = d.replace(/\[\d+\]/g, ""); text += clean; send("delta", { text: clean }); }
    for (const s of data.search_results || []) if (s.url && !seen.has(s.url)) { seen.add(s.url); sources.push({ url: s.url, title: s.title || "", cited: true }); send("source", sources[sources.length - 1]); }
    for (const u of data.citations || []) if (typeof u === "string" && !seen.has(u)) { seen.add(u); sources.push({ url: u, title: "", cited: true }); send("source", sources[sources.length - 1]); }
  }
  return { text, sources, model: env("PETTLE_PPLX_MODEL", "sonar") };
}

async function gemini(q, brand, send) {
  let res, model, lastErr;
  for (const m of GEMINI_MODELS()) {
    res = await fetchRetry(`https://generativelanguage.googleapis.com/v1beta/models/${m}:streamGenerateContent?alt=sse`, { method: "POST", headers: { "x-goog-api-key": env("GEMINI_API_KEY"), "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: q }] }], tools: [{ google_search: {} }] }) });
    if (res.ok) { model = m; break; }
    const e = await res.json().catch(() => ({})); lastErr = e?.error?.message || `Gemini error ${res.status}`;
    if (res.status === 429) throw new Error("Gemini free-tier limit reached for now: " + lastErr);
    if (!(res.status === 404 || /not found|not supported/i.test(lastErr))) throw new Error(lastErr);
  }
  if (!model) throw new Error(lastErr || "No Gemini model available");
  send("status", { text: "Gemini is searching Google" });
  let text = ""; const seen = new Set(); const sources = [];
  for await (const { data } of readSSE(res)) {
    const cand = data.candidates?.[0] || {};
    const d = (cand.content?.parts || []).map((p) => p.text || "").join(""); if (d) { text += d; send("delta", { text: d }); }
    const gm = cand.groundingMetadata || {};
    (gm.webSearchQueries || []).forEach((query) => { if (!seen.has("q:" + query)) { seen.add("q:" + query); send("search", { query }); } });
    for (const c of gm.groundingChunks || []) { const w = c.web || {}; if (w.uri && !seen.has(w.uri)) { seen.add(w.uri); sources.push({ url: w.uri, title: w.title || "", cited: true }); send("source", sources[sources.length - 1]); } }
  }
  return { text, sources, model };
}

// Groq Compound: an open model with built-in live web search (free tier, no card).
async function groq(q, brand, send) {
  const tried = []; let res, model;
  for (let i = 0; i < 3; i++) {
    model = await pickGroq([env("PETTLE_GROQ_ENGINE"), "groq/compound-mini", "groq/compound", "compound-beta-mini", "compound-beta"], (id) => /compound/i.test(id), tried);
    res = await fetchRetry("https://api.groq.com/openai/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${env("GROQ_API_KEY")}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: q }], stream: true }) });
    if (res.ok) break;
    const e = await res.json().catch(() => ({})); const msg = e?.error?.message || `Groq error ${res.status}`;
    if (/does not exist|decommissioned|not have access|not found/i.test(msg)) { tried.push(model); res = null; continue; }
    throw new Error(msg);
  }
  if (!res) throw new Error("Groq's web-search model (Compound) isn't available for this key.");
  send("status", { text: "Groq Compound is searching the web" });
  let text = ""; const tools = []; const seen = new Set(); const sources = [];
  const harvest = (obj) => {
    const raw = JSON.stringify(obj || "");
    for (const m of raw.matchAll(/"query\\?"\s*:\s*\\?"([^"\\]{3,200})/g)) if (!seen.has("q:" + m[1])) { seen.add("q:" + m[1]); send("search", { query: m[1] }); }
    for (const m of raw.matchAll(/https?:\/\/[^\s"'\\)<>\]]+/g)) { const u = m[0].replace(/[.,;]+$/, ""); if (!seen.has(u) && !/groq\.com|googleapis|schema\.org/.test(u)) { seen.add(u); sources.push({ url: u, title: "", cited: true }); send("source", sources[sources.length - 1]); } }
  };
  for await (const { data } of readSSE(res)) {
    const ch = data.choices?.[0] || {};
    const d = ch.delta?.content; if (d) { text += d; send("delta", { text: d }); }
    if (ch.delta?.executed_tools) { tools.push(...ch.delta.executed_tools); harvest(ch.delta.executed_tools); }
    if (ch.message?.executed_tools) harvest(ch.message.executed_tools);
  }
  if (!sources.length) harvest(text);
  return { text, sources: sources.slice(0, 20), model };
}

// Google AI Overviews and AI Mode, through a paid SERP API (DataForSEO or SerpApi). Not a chat model: Google either
// shows an AI answer for the query or it doesn't, so "absent" is a real result, recorded as an answer that names nobody.
// One AI Overview call also returns the organic top 10, which is how White Petal ties AI visibility to classic rankings.
async function aio(q, brand, send) {
  const cfg = { ...serpConfig(), locationName: brand.market && !/global/i.test(brand.market) ? brand.market : undefined };
  send("status", { text: "Searching Google for an AI Overview" });
  return serpAnswer(await serp.aiOverview(cfg, q), send, "google-ai-overview");
}
async function aimode(q, brand, send) {
  const cfg = { ...serpConfig(), locationName: brand.market && !/global/i.test(brand.market) ? brand.market : undefined };
  send("status", { text: "Asking Google AI Mode" });
  return serpAnswer(await serp.aiMode(cfg, q), send, "google-ai-mode");
}
function serpAnswer(r, send, model) {
  const sources = (r.references || []).filter((x) => x.url).slice(0, 25).map((x) => ({ url: x.url, title: x.title || "", cited: true }));
  sources.forEach((s) => send("source", s));
  const text = r.present ? r.text || "(Google showed an AI answer with no readable text.)" : "";
  if (text) send("delta", { text });
  return { text, sources, model, present: !!r.present };
}

const RUN = { chatgpt, perplexity, gemini, groq, aio, aimode };
const KEY = { chatgpt: "OPENAI_API_KEY", perplexity: "PERPLEXITY_API_KEY", gemini: "GEMINI_API_KEY", groq: "GROQ_API_KEY", aio: "SERP", aimode: "SERP" };
const ready = (e) => (KEY[e] === "SERP" ? !!serpConfig() : !!env(KEY[e]));

export default async function handler(req) {
  const denied = guard(req); if (denied) return denied;
  const { engine, question, brand = {} } = await body(req);
  return sse(async (send) => {
    if (!RUN[engine] || !ready(engine)) throw new Error(`${engine} isn't set up. Add ${KEY[engine] === "SERP" ? "DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD (or SERPAPI_KEY)" : KEY[engine]} to the environment.`);
    const r = await RUN[engine](String(question || "").slice(0, 400), brand, send);
    send("status", { text: "Reading the answer for brand names" });
    const brands = r.text ? await extractBrands(r.text, [brand.name, ...(brand.competitors || [])].filter(Boolean), brand.category) : [];
    send("final", { answer: r.text.slice(0, 6000), sources: [...r.sources.filter((s) => s.cited), ...r.sources.filter((s) => !s.cited)].slice(0, 25), brands, model: r.model, ...(r.present === false ? { present: false } : {}) });
  });
}
