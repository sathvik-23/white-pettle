// Shared helpers for White Pettle API routes (Vercel Edge + local dev server).
export const env = (k, d = "") => (globalThis.process?.env?.[k] ?? d);

export const ENGINE_MODEL = () => env("PETTLE_OPENAI_MODEL", "gpt-5.5");
export const LLM_MODEL = () => env("PETTLE_LLM_MODEL", "gpt-4.1");
export const FAST_MODEL = () => env("PETTLE_FAST_MODEL", "gpt-4.1-mini");
export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 WhitePettle/1.0";

export const GEMINI_MODELS = () => [...new Set([env("PETTLE_GEMINI_MODEL", "gemini-flash-latest"), "gemini-2.5-flash", "gemini-2.0-flash"])];
// Which model writes (questions, insights, pitches...). Free options first.
export function llmProviders() {
  const want = env("PETTLE_LLM_PROVIDER").toLowerCase();
  const have = { gemini: !!env("GEMINI_API_KEY"), groq: !!env("GROQ_API_KEY"), openai: !!env("OPENAI_API_KEY"), anthropic: !!env("ANTHROPIC_API_KEY") };
  const order = ["gemini", "groq", "openai", "anthropic"].filter((k) => have[k]);
  if (want && have[want]) return [want, ...order.filter((k) => k !== want)];
  return order;
}
export const llmProvider = () => llmProviders()[0] || null;
// Quota, billing and rate-limit errors move on to the next configured provider.
const isQuota = (e) => /quota|credit|billing|prepay|rate limit|429|exhausted|insufficient/i.test(String(e?.message || e));
async function withFallback(fn) {
  const list = llmProviders(); let last;
  if (!list.length) throw new Error("No AI key configured. Add GEMINI_API_KEY (free) or GROQ_API_KEY (free) in your environment variables.");
  for (const pv of list) { try { return await fn(pv); } catch (e) { last = e; if (!isQuota(e)) throw e; } }
  throw last;
}

async function geminiCall(prompt, { stream = false, max = 4000, onDelta } = {}) {
  let last;
  for (const model of GEMINI_MODELS()) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    const r = await fetch(url, { method: "POST", headers: { "x-goog-api-key": env("GEMINI_API_KEY"), "content-type": "application/json" }, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: max } }) });
    if (!r.ok) { const d = await r.json().catch(() => ({})); last = new Error(d?.error?.message || `Gemini error ${r.status}`); if (r.status === 404 || /not found|not supported/i.test(last.message)) continue; throw last; }
    if (!stream) { const d = await r.json(); return (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join(""); }
    let all = "";
    for await (const { data } of readSSE(r)) { const t = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join(""); if (t) { all += t; onDelta?.(t); } }
    return all;
  }
  throw last || new Error("No Gemini model available");
}
async function groqCall(prompt, { stream = false, max = 4000, onDelta } = {}) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${env("GROQ_API_KEY")}`, "content-type": "application/json" },
    body: JSON.stringify({ model: env("PETTLE_GROQ_MODEL", "llama-3.3-70b-versatile"), messages: [{ role: "user", content: prompt }], max_tokens: Math.min(max, 8000), stream }) });
  if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error?.message || `Groq error ${r.status}`); }
  if (!stream) { const d = await r.json(); return d.choices?.[0]?.message?.content || ""; }
  let all = "";
  for await (const { data } of readSSE(r)) { const t = data.choices?.[0]?.delta?.content; if (t) { all += t; onDelta?.(t); } }
  return all;
}

export function engines() {
  const e = [];
  if (env("OPENAI_API_KEY")) e.push("chatgpt");
  if (env("PERPLEXITY_API_KEY")) e.push("perplexity");
  if (env("GEMINI_API_KEY")) e.push("gemini");
  if (env("GROQ_API_KEY")) e.push("groq");
  return e;
}

export function guard(req) {
  const code = env("ACCESS_CODE");
  if (!code) return null;
  if (req.headers.get("x-access-code") === code) return null;
  return json({ error: "Access code required", code: "access" }, 401);
}

export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// Server-sent events over a POST response
export function sse(run) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(c) {
      let open = true;
      const send = (event, data) => { if (open) c.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`)); };
      const ping = setInterval(() => send("ping", {}), 10000);
      try { await run(send); } catch (e) { send("error", { message: String(e?.message || e).slice(0, 400) }); }
      clearInterval(ping); open = false; c.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" } });
}

// Read an upstream SSE body, yielding {event, data}
export async function* readSSE(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
      let event = "message", data = "";
      for (const line of chunk.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data || data === "[DONE]") continue;
      try { yield { event, data: JSON.parse(data) }; } catch { /* skip */ }
    }
  }
}

// ---------- text utils ----------
export const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export function aliases(b) {
  const a = [b?.name];
  if (b?.site) { const h = hostOf(b.site); a.push(h, h.split(".")[0]); }
  return [...new Set(a.map(norm).filter((x) => x.length >= 3))];
}
export const hasAny = (text, al) => { const t = " " + norm(text) + " "; return al.some((a) => t.includes(" " + a + " ")); };
export function hostOf(u) { try { return new URL(u.includes("://") ? u : "https://" + u).hostname.replace(/^www\./, ""); } catch { return String(u || ""); } }
export function orderKnown(text, names) {
  const t = " " + norm(text) + " ";
  return names.filter((n) => n && norm(n) && t.includes(" " + norm(n) + " ")).sort((a, b) => t.indexOf(" " + norm(a) + " ") - t.indexOf(" " + norm(b) + " "));
}
export const decode = (s) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&rsquo;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
export function stripHtml(h) {
  return decode(h.replace(/<(script|style|noscript|svg|nav|footer|iframe)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export async function fetchPage(url, { timeout = 12000, cap = 1500000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8", "accept-language": "en" }, redirect: "follow", signal: ctl.signal });
    if (!r.ok) return { ok: false, status: r.status, url: r.url || url, body: "" };
    const reader = r.body.getReader(); const dec = new TextDecoder(); let body = "", n = 0;
    for (;;) { const { value, done } = await reader.read(); if (done) break; n += value.length; body += dec.decode(value, { stream: true }); if (n > cap) { try { reader.cancel(); } catch {} break; } }
    return { ok: true, status: r.status, url: r.url || url, body, type: r.headers.get("content-type") || "" };
  } catch (e) {
    return { ok: false, status: 0, url, body: "", error: e?.name === "AbortError" ? "timed out" : String(e?.message || e) };
  } finally { clearTimeout(t); }
}

export function ldTypes(body) {
  const types = new Set();
  const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === "object") { const t = o["@type"]; if (typeof t === "string") types.add(t); else if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && types.add(x)); Object.values(o).forEach(walk); } };
  for (const m of body.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) { try { walk(JSON.parse(m[1].trim())); } catch { types.add("(invalid JSON-LD)"); } }
  return [...types];
}

export function parsePage(url, body) {
  const tx = (s) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  const title = tx((body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  const desc = decode((body.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) || [])[1] || "");
  const heads = [...body.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => tx(m[1])).filter(Boolean).slice(0, 40);
  const paras = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => tx(m[1])).filter((p) => p.split(" ").length > 8);
  const text = stripHtml(body);
  const host = hostOf(url);
  const links = [...body.matchAll(/href=["'](https?:\/\/[^"']+)/gi)].map((m) => m[1]);
  return { url, title: title.slice(0, 200), description: desc.slice(0, 300), headings: heads, firstP: (paras[0] || "").slice(0, 800), text: text.slice(0, 20000), words: text.split(" ").length,
    schema: ldTypes(body), outbound: links.filter((l) => !hostOf(l).endsWith(host)).length, lists: (body.match(/<li[\s>]/gi) || []).length, tables: (body.match(/<table[\s>]/gi) || []).length };
}

export function scorePage(p, brand) {
  const t = p.text, name = brand?.name || "";
  const fpw = p.firstP.split(" ").filter(Boolean).length;
  const qheads = p.headings.filter((h) => /\?$/.test(h) || /^(what|how|why|which|is|are|can|should|does|do|who|when)\b/i.test(h));
  const stats = (t.match(/\b\d+(\.\d+)?\s?(%|percent|x\b|million|billion|k\b|users|customers|clients|hours|days|weeks)/gi) || []).length + (t.match(/[$₹€£]\s?\d/g) || []).length;
  const quotes = (t.match(/[“"][^”"]{25,240}[”"]\s*(—|–|-|,)?\s*(said|says|according|[A-Z][a-z]+)/g) || []).length;
  const cites = p.outbound + (t.match(/\b(according to|source:|study|survey|report by|data from|research)\b/gi) || []).length;
  const fresh = /\b(updated|last reviewed)\b/i.test(t) || /\b202[5-9]\b/.test(t);
  const faq = /\b(faq|frequently asked)\b/i.test(t) || p.schema.some((s) => /FAQPage|QAPage/.test(s));
  const brandN = name ? (t.match(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")) || []).length : 0;
  const checks = [
    ["Answers in the first paragraph", fpw >= 20 && fpw <= 90, 16, "AI lifts the opening 40–60 words as the answer."],
    ["Question-style headings", qheads.length >= 3, 10, "Headings that match buyer questions get quoted as answers."],
    ["Specific numbers", stats >= 4, 14, "Pages with real statistics are cited about a third more often."],
    ["Attributed quotes", quotes >= 1, 10, "Named quotes are the biggest single citation lift in GEO studies."],
    ["Cites outside sources", cites >= 3, 10, "AI trusts pages that cite authorities."],
    ["Lists or tables", p.lists >= 5 || p.tables >= 1, 8, "Structured chunks are easy for AI to extract."],
    ["FAQ block", faq, 8, "FAQs mirror the exact questions people ask AI."],
    ["Schema markup", p.schema.length > 0, 8, "JSON-LD tells AI exactly what the page is about."],
    ["Shows it's current", fresh, 6, "Assistants prefer pages with a visible update date."],
    ["Names the brand clearly", brandN >= 3, 6, "AI needs to see who is speaking."],
    ["Enough depth", p.words >= 600, 4, "Thin pages rarely get cited."],
  ];
  const tot = checks.reduce((s, c) => s + c[2], 0);
  const score = Math.round((100 * checks.filter((c) => c[1]).reduce((s, c) => s + c[2], 0)) / tot);
  return { score, checks: checks.map(([label, pass, weight, why]) => ({ label, pass, weight, why })) };
}

export const AI_BOTS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "PerplexityBot", "ClaudeBot", "Claude-SearchBot", "Google-Extended", "Bingbot", "Applebot-Extended"];
export function robotsAccess(txt) {
  const groups = []; let ua = [], rules = [];
  for (let line of String(txt || "").split(/\r?\n/)) {
    line = line.split("#")[0].trim(); if (!line.includes(":")) continue;
    const [k, ...rest] = line.split(":"); const v = rest.join(":").trim(); const key = k.trim().toLowerCase();
    if (key === "user-agent") { if (rules.length) { groups.push([ua, rules]); ua = []; rules = []; } ua.push(v.toLowerCase()); }
    else if (key === "disallow" || key === "allow") rules.push([key, v]);
  }
  if (ua.length) groups.push([ua, rules]);
  const out = {};
  for (const bot of AI_BOTS) {
    const b = bot.toLowerCase();
    const g = (groups.find(([u]) => u.includes(b)) || groups.find(([u]) => u.includes("*")) || [[], []])[1];
    out[bot] = !g.some(([k, v]) => k === "disallow" && v === "/");
  }
  return out;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export function contactsFrom(url, body) {
  const emails = [...new Set(body.match(EMAIL_RE) || [])].filter((e) => !/\.(png|jpg|gif|svg|webp)$|example\.|sentry|wixpress|@2x|domain\.com|email\.com|yourname/i.test(e)).slice(0, 4);
  let author = decode((body.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)/i) || [])[1] || "");
  if (!author) { const m = body.match(/rel=["']author["'][^>]*>([\s\S]*?)<\/a>/i); if (m) author = decode(m[1].replace(/<[^>]+>/g, "")).trim(); }
  const links = [];
  for (const m of body.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const lab = m[2].replace(/<[^>]+>/g, "").trim().toLowerCase();
    if (/contact|write for us|contribute|submit|suggest|advertis|get listed|editorial|pitch/.test(lab + " " + m[1].toLowerCase())) {
      try { const full = new URL(m[1], url).href; if (/^https?:/.test(full) && !links.includes(full)) links.push(full); } catch {}
    }
  }
  return { emails, author: author.slice(0, 80), links: links.slice(0, 4) };
}

export function snippetAround(text, name, width = 110) {
  const i = norm(text).indexOf(norm(name)); if (i < 0) return "";
  // approximate: find in original text case-insensitively
  const j = text.toLowerCase().indexOf(name.toLowerCase());
  const at = j >= 0 ? j : 0;
  return (at > width ? "…" : "") + text.slice(Math.max(0, at - width), at + name.length + width).trim() + "…";
}

// ---------- LLM ----------
export async function llmText(prompt, opts = {}) { return withFallback((pv) => llmTextWith(pv, prompt, opts)); }
async function llmTextWith(pv, prompt, { model, max = 4000 } = {}) {
  if (pv === "gemini") return geminiCall(prompt, { max });
  if (pv === "groq") return groqCall(prompt, { max });
  if (pv === "openai") {
    const r = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { authorization: `Bearer ${env("OPENAI_API_KEY")}`, "content-type": "application/json" }, body: JSON.stringify({ model: model || LLM_MODEL(), input: prompt, max_output_tokens: max }) });
    const d = await r.json(); if (!r.ok) throw new Error(d?.error?.message || `OpenAI error ${r.status}`);
    return openaiText(d);
  }
  if (pv === "anthropic") {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: env("PETTLE_ANTHROPIC_MODEL", "claude-sonnet-5-5"), max_tokens: max, messages: [{ role: "user", content: prompt }] }) });
    const d = await r.json(); if (!r.ok) throw new Error(d?.error?.message || `Anthropic error ${r.status}`);
    return (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  throw new Error("No AI key configured. Add GEMINI_API_KEY (free) or GROQ_API_KEY (free) in your environment variables.");
}
export async function llmJSON(prompt, opts) { return parseLoose(await llmText(prompt + "\n\nReply with only the JSON.", opts)); }
export function parseLoose(t) {
  try { return JSON.parse(t); } catch {}
  const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) { try { return JSON.parse(f[1]); } catch {} }
  const i = t.search(/[[{]/), j = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (i >= 0 && j > i) return JSON.parse(t.slice(i, j + 1));
  throw new Error("AI reply was not valid JSON");
}
export function openaiText(d) {
  let out = "";
  for (const it of d.output || []) if (it.type === "message") for (const c of it.content || []) if (c.type === "output_text") out += c.text;
  return out || d.output_text || "";
}

// Stream plain text from the writing model, calling onDelta for each chunk.
export async function llmStream(prompt, onDelta, opts = {}) {
  let sent = false; const wrap = (d) => { sent = true; onDelta(d); };
  return withFallback((pv) => { if (sent) throw new Error("stream interrupted"); return llmStreamWith(pv, prompt, wrap, opts); });
}
async function llmStreamWith(pv, prompt, onDelta, { model, max = 6000 } = {}) {
  if (pv === "gemini") return geminiCall(prompt, { stream: true, max, onDelta });
  if (pv === "groq") return groqCall(prompt, { stream: true, max, onDelta });
  if (pv === "openai") {
    const r = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { authorization: `Bearer ${env("OPENAI_API_KEY")}`, "content-type": "application/json" }, body: JSON.stringify({ model: model || LLM_MODEL(), input: prompt, stream: true, max_output_tokens: max }) });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error?.message || `OpenAI error ${r.status}`); }
    let all = "";
    for await (const { event, data } of readSSE(r)) {
      const type = data.type || event;
      if (type === "response.output_text.delta") { all += data.delta; onDelta(data.delta); }
      if (type === "error" || type === "response.failed") throw new Error(data?.error?.message || data?.response?.error?.message || "Stream failed");
    }
    return all;
  }
  if (pv === "anthropic") {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: env("PETTLE_ANTHROPIC_MODEL", "claude-sonnet-5-5"), max_tokens: max, stream: true, messages: [{ role: "user", content: prompt }] }) });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error?.message || `Anthropic error ${r.status}`); }
    let all = "";
    for await (const { data } of readSSE(r)) if (data.type === "content_block_delta" && data.delta?.text) { all += data.delta.text; onDelta(data.delta.text); }
    return all;
  }
  throw new Error("No AI key configured. Add GEMINI_API_KEY (free) or GROQ_API_KEY (free) in your environment variables.");
}

export async function extractBrands(answer, known) {
  const found = orderKnown(answer, known);
  if (!llmProvider()) return found;
  try {
    const arr = await llmJSON(`List every brand, product, company or service this AI answer recommends or names, in the order they first appear. Exclude publishers and websites that are only cited as sources. JSON array of strings.\n\nAnswer:\n${answer.slice(0, 9000)}`, { max: 600 });
    const out = (Array.isArray(arr) ? arr : []).map((x) => String(x).trim()).filter(Boolean);
    for (const k of found) if (!out.some((a) => norm(a) === norm(k))) out.push(k);
    return out.slice(0, 20);
  } catch { return found; }
}

export async function body(req) { try { return await req.json(); } catch { return {}; } }
