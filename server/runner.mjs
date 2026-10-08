// A full brand check with no browser: what public/app.js `runPipeline` does live, for scheduled runs.
// It calls the SAME /api handlers in-process (ask, write, inspect), so a scheduled run and a live run cannot drift.
import askHandler from "../api/ask.js";
import writeHandler from "../api/write.js";
import inspectHandler from "../api/inspect.js";
import { readSSE, engines as availableEngines } from "../api/_lib.js";
import { norm, hostOf, isYou, textHasYou, finished, summarize } from "./metrics.mjs";

const headers = () => ({ "content-type": "application/json", "x-access-code": process.env.ACCESS_CODE || "" });
const call = (handler, payload) => handler(new Request("http://internal/api", { method: "POST", headers: headers(), body: JSON.stringify(payload) }));
async function stream(handler, payload, on = {}) {
  const res = await call(handler, payload);
  if (!(res.headers.get("content-type") || "").includes("event-stream")) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `HTTP ${res.status}`); }
  for await (const { event, data } of readSSE(res)) { if (event === "error") throw new Error(data.message || "failed"); on[event]?.(data); }
}
// Swappable for tests (setHandlers), so the runner can be exercised without real AI keys.
let ask = askHandler, write = writeHandler, inspect = inspectHandler;
export function setHandlers(h = {}) { ask = h.ask || askHandler; write = h.write || writeHandler; inspect = h.inspect || inspectHandler; }
async function writeText(kind, data) { let t = ""; await stream(write, { kind, data }, { delta: (d) => { t += d.text; } }); return t; }
export function parseLoose(t) {
  try { return JSON.parse(t); } catch {}
  const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) { try { return JSON.parse(f[1]); } catch {} }
  const i = t.search(/[[{]/), j = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  return JSON.parse(t.slice(i, j + 1));
}
const retryable = (e) => /429|rate|limit|quota exceeded|overload|timed out|timeout|temporar|unavailable|502|503|504|network|fetch|stream/i.test(String(e?.message || e));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pool(items, n, fn) { const q = items.slice(); await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()); })); }
export const answerKey = (qid, e, s) => (s ? `${qid}|${e}|${s}` : `${qid}|${e}`);

// The "why" digest the insights writer reads. Mirrors app.js digest().
export function digest(M) {
  const ENG = { chatgpt: "ChatGPT", perplexity: "Perplexity", gemini: "Gemini", groq: "Groq", aio: "AI Overviews", aimode: "AI Mode" };
  const ans = Object.values(M.answers).filter(finished), L = [];
  for (const e of M.engines) { const x = ans.filter((a) => a.engine === e); if (x.length) L.push(`${ENG[e] || e}: named in ${x.filter((a) => a.named).length}/${x.length}`); }
  for (const q of M.questions) { const x = ans.filter((a) => a.qid === q.id); L.push(`- "${q.text}" [${q.intent}]: ${x.map((a) => `${ENG[a.engine] || a.engine} ${a.named ? "NAMED" + (a.rank ? " #" + a.rank : "") : "missing"} (named: ${(a.brands || []).slice(0, 5).join(", ")})`).join("; ")}`); }
  const rc = {}; ans.forEach((a) => (a.brands || []).forEach((b) => { if (!isYou(b, M.profile)) rc[b] = (rc[b] || 0) + 1; }));
  L.push("Rival mentions: " + Object.entries(rc).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, c]) => `${n} ${c}`).join(", "));
  const ins = Object.values(M.inspections).filter((p) => p.ok);
  L.push(`Cited pages opened: ${ins.length}. You are on ${ins.filter((p) => p.you).length}.`);
  ins.slice(0, 18).forEach((p) => L.push(`  page ${p.domain} "${p.title}" cited ${p.n}x: you ${p.you ? "present" : "absent"}; rivals: ${(p.rivals || []).join(", ") || "none"}`));
  const a = M.audit || {}; L.push(`Site: avg AI-readiness ${a.avg}/100; blocked bots: ${Object.entries(a.bots || {}).filter(([, v]) => !v).map(([k]) => k).join(", ") || "none"}; llms.txt ${a.llms ? "yes" : "no"}`);
  if (M.perception) L.push("How AI describes them: " + M.perception.summary);
  return L.join("\n").slice(0, 12000);
}

/**
 * Run one check for a workspace's saved setup. Returns the run object (same shape the browser saves).
 * opts: { prev (last finished run, for drafts to carry forward), samples, deadline (ms epoch), log }
 */
export async function runCheck(ws, opts = {}) {
  const setup = ws.setup || {}, log = opts.log || (() => {});
  const profile = setup.profile; if (!profile?.name) throw new Error("This brand has no saved profile yet.");
  const have = opts.engines || availableEngines();
  const engines = (setup.engines?.length ? setup.engines : have).filter((e) => have.includes(e));
  if (!engines.length) throw new Error("No AI engine is configured on the server.");
  const qs = (setup.questions || []).filter((q) => q.on !== false);
  if (!qs.length) throw new Error("This brand has no prompts to track.");
  const samples = Math.max(1, Math.min(5, Number(opts.samples || ws.samples || 1)));
  const deadline = opts.deadline || Date.now() + 25 * 60 * 1000;
  const prev = opts.prev || null;
  const M = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), slug: ws.slug, source: "scheduled", startedAt: Date.now(), finishedAt: null,
    profile, audit: setup.audit || {}, siteText: setup.siteText || "", engines, samples,
    questions: qs.map((q, i) => ({ id: "q" + (i + 1), intent: q.intent, topic: q.topic, persona: q.persona, text: q.text })),
    answers: {}, inspections: {}, perception: null, insights: "", assets: prev?.assets || null, pitches: prev?.pitches || {}, fixpack: prev?.fixpack || "", articles: prev?.articles || {}, deck: {}, chat: [], done: { questions: true } };

  // 1. ask every prompt on every engine, `samples` times (answers are noisy; averaging is how the trackers stay stable)
  const jobs = []; for (const q of M.questions) for (const e of engines) for (let s = 0; s < samples; s++) jobs.push([q, e, s]);
  log(`asking ${jobs.length} conversations`);
  await pool(jobs, 3, async ([q, e, s]) => {
    if (Date.now() > deadline) return;
    const a = { qid: q.id, engine: e, sample: s, status: "run", answer: "", sources: [], brands: [], searches: [] };
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        Object.assign(a, { answer: "", sources: [], brands: [], searches: [] });
        await stream(ask, { engine: e, question: q.text, brand: profile }, {
          search: (d) => a.searches.push(d.query),
          source: (d) => { if (!a.sources.some((x) => x.url === d.url)) a.sources.push(d); },
          delta: (d) => { a.answer += d.text; },
          final: (d) => { a.answer = d.answer || a.answer; a.sources = d.sources?.length ? d.sources : a.sources; a.brands = d.brands || []; a.model = d.model; if (d.organic) a.organic = d.organic; if (d.present === false) a.absent = true; },
        });
        const idx = a.brands.findIndex((b) => isYou(b, profile));
        a.named = idx >= 0 || textHasYou(a.answer, profile); a.rank = idx >= 0 ? idx + 1 : null; a.status = a.named ? "yes" : "no";
        break;
      } catch (err) { a.status = "err"; a.error = String(err.message || err); if (attempt < 3 && retryable(err)) { await sleep(2500 * attempt); continue; } break; }
    }
    a.nSrc = a.sources.length; a.nS = a.searches.length;
    M.answers[answerKey(q.id, e, s)] = a;
  });
  M.done.ask = true;
  const answered = Object.values(M.answers).filter(finished);
  if (!answered.length) throw new Error(Object.values(M.answers).find((a) => a.error)?.error || "None of the AI engines answered.");

  // 2. sentiment, one batch call
  try {
    const items = answered.filter((a) => (a.brands || []).length || a.named).slice(0, 48).map((a, i) => ({ id: "a" + i, a, brands: [...new Set([...(a.brands || []).slice(0, 8), ...(a.named ? [profile.name] : [])])], text: String(a.answer || "").slice(0, 900) }));
    if (items.length) { const j = parseLoose(await writeText("sentiment", { profile: { name: profile.name }, items: items.map(({ id, brands, text }) => ({ id, brands, text })) })); items.forEach((it) => { if (j?.[it.id] && typeof j[it.id] === "object") it.a.sent = j[it.id]; }); }
  } catch (e) { log("sentiment skipped: " + e.message); }
  M.done.sentiment = true;

  // 3. open the most-cited pages
  const cites = {};
  for (const a of answered) for (const s of a.sources || []) { const k = s.url; (cites[k] = cites[k] || { url: k, n: 0, qs: new Set(), cited: false }); cites[k].n++; cites[k].qs.add(a.qid); cites[k].cited ||= s.cited; }
  const targets = Object.values(cites).sort((a, b) => b.n - a.n || (b.cited ? 1 : 0) - (a.cited ? 1 : 0)).slice(0, Number(process.env.RUNNER_PAGES || 18));
  await pool(targets, 4, async (t) => {
    if (Date.now() > deadline) return;
    let r; try { r = await (await call(inspect, { url: t.url, brand: profile })).json(); } catch (e) { r = { ok: false, url: t.url, reason: e.message }; }
    r.n = t.n; r.qs = [...t.qs]; M.inspections[t.url] = r;
  });
  M.done.sources = true;

  // 4. what AI says about the brand, fact-checked, then the "why"
  const e0 = engines.find((e) => !["aio", "aimode"].includes(e)) || engines[0];
  if (Date.now() < deadline) {
    try {
      const pq = [`What is ${profile.name}?`, `Is ${profile.name} a good choice for ${profile.category || "this"}? What are the alternatives?`];
      const pAns = [];
      for (const qq of pq) { let t = ""; await stream(ask, { engine: e0, question: qq, brand: profile }, { delta: (d) => { t += d.text; }, final: (d) => { t = d.answer || t; } }); pAns.push({ q: qq, a: t }); }
      M.perception = parseLoose(await writeText("perception", { profile, answers: pAns }));
    } catch (e) { log("perception skipped: " + e.message); }
  }
  M.done.perception = true;
  if (Date.now() < deadline) { try { M.insights = await writeText("insights", { profile, digest: digest(M) }); } catch (e) { log("insights skipped: " + e.message); } }
  M.done.insights = true; M.done.draft = true; // drafts carry forward from the last run; new ones are written on demand in the app
  M.finishedAt = Date.now();
  M.partial = Date.now() > deadline;
  return M;
}

export const summaryOf = (M) => summarize(M);
