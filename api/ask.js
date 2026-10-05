// Ask one live AI engine one buyer question, streaming its search, sources and answer as they happen.
import { sse, guard, body, env, readSSE, ENGINE_MODEL, extractBrands, openaiText } from "./_lib.js";
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
      res = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { authorization: `Bearer ${env("OPENAI_API_KEY")}`, "content-type": "application/json" },
        body: JSON.stringify({ model, input: q, tools: [tool], include: ["web_search_call.action.sources"], stream: true }) });
      if (res.ok) { used = model; break; }
      const err = await res.json().catch(() => ({})); const msg = err?.error?.message || "";
      if (res.status === 401) throw new Error("OpenAI rejected the API key.");
      if (res.status === 429) throw new Error("OpenAI rate limit or quota reached: " + msg);
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
  const res = await fetch("https://api.perplexity.ai/chat/completions", { method: "POST", headers: { authorization: `Bearer ${env("PERPLEXITY_API_KEY")}`, "content-type": "application/json" },
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
  const model = env("PETTLE_GEMINI_MODEL", "gemini-2.5-flash");
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, { method: "POST", headers: { "x-goog-api-key": env("GEMINI_API_KEY"), "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: q }] }], tools: [{ google_search: {} }] }) });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e?.error?.message || `Gemini error ${res.status}`); }
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

const RUN = { chatgpt, perplexity, gemini };
const KEY = { chatgpt: "OPENAI_API_KEY", perplexity: "PERPLEXITY_API_KEY", gemini: "GEMINI_API_KEY" };

export default async function handler(req) {
  const denied = guard(req); if (denied) return denied;
  const { engine, question, brand = {} } = await body(req);
  return sse(async (send) => {
    if (!RUN[engine] || !env(KEY[engine])) throw new Error(`${engine} isn't set up. Add ${KEY[engine]} to the environment.`);
    const r = await RUN[engine](String(question || "").slice(0, 400), brand, send);
    send("status", { text: "Reading the answer for brand names" });
    const brands = await extractBrands(r.text, [brand.name, ...(brand.competitors || [])].filter(Boolean));
    send("final", { answer: r.text.slice(0, 6000), sources: r.sources.slice(0, 25), brands, model: r.model });
  });
}
