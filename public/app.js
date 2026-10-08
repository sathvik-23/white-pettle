/* White Petal by Perfstaq: a visible AI agent.
   Flow: Peec-style setup (scan site → brand profile → market → competitors → topics → prompt focus → prompt set)
   → live AI answers → follow the sources → what AI says about you → insights → drafts → "workspace ready" reveal
   → results dashboard (overview, prompts, chats, sources, gap analysis, actions) with an agent you can ask. */
(() => {
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const host = (u) => { try { return new URL(String(u).includes("://") ? u : "https://" + u).hostname.replace(/^www\./, ""); } catch { return String(u || ""); } };
const slugify = (s) => norm(s).replace(/ /g, "-").slice(0, 48) || "brand";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
const ENG = { chatgpt: "ChatGPT", perplexity: "Perplexity", gemini: "Gemini", groq: "Groq web" };
const ENGC = { chatgpt: "var(--e-chatgpt)", perplexity: "var(--e-perplexity)", gemini: "var(--e-gemini)", groq: "var(--e-groq)" };
const store = {
  get(k, d) { try { const v = localStorage.getItem("wpetal:" + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("wpetal:" + k, JSON.stringify(v)); } catch { try { for (let i = localStorage.length - 1; i >= 0; i--) { const kk = localStorage.key(i); if (kk && kk.startsWith("wpetal:prev:")) localStorage.removeItem(kk); } localStorage.setItem("wpetal:" + k, JSON.stringify(v)); } catch {} } },
};

/* =================================================================== API */
const APP = { cfg: { engines: [], llm: false, access: false }, code: store.get("code", ""), M: null, ctl: null, running: false };
async function post(path, payload, signal) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-access-code": APP.code || "" }, body: JSON.stringify(payload), signal, cache: "no-store" });
  if (r.status === 401) throw new Error("The access code is missing or wrong.");
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Server error ${r.status}`);
  return d;
}
async function stream(path, payload, on, signal, idleMs = 75000) {
  const ctl = new AbortController(); let idle = false, timer;
  const kick = () => { clearTimeout(timer); timer = setTimeout(() => { idle = true; ctl.abort(); }, idleMs); };
  const onOuter = () => ctl.abort(); signal?.addEventListener("abort", onOuter);
  if (signal?.aborted) ctl.abort();
  kick();
  try { return await streamInner(path, payload, on, ctl.signal, kick); }
  catch (e) { if (idle && !signal?.aborted) throw new Error("The AI went quiet for too long (timed out)."); throw e; }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", onOuter); }
}
async function streamInner(path, payload, on, signal, kick) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-access-code": APP.code || "" }, body: JSON.stringify(payload), signal, cache: "no-store" });
  if (r.status === 401) throw new Error("The access code is missing or wrong.");
  if (!r.ok || !r.body) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `Server error ${r.status}`); }
  const reader = r.body.getReader(), dec = new TextDecoder(); let buf = "", err = null;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    kick();
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      let ev = "message", data = "";
      for (const line of chunk.split("\n")) { if (line.startsWith("event:")) ev = line.slice(6).trim(); else if (line.startsWith("data:")) data += line.slice(5).trim(); }
      if (!data) continue; let obj; try { obj = JSON.parse(data); } catch { continue; }
      if (ev === "error") err = new Error(obj.message || "Something failed");
      else if (on[ev]) on[ev](obj);
    }
  }
  if (err) throw err;
}

/* =================================================================== LANDING */
function stars() {
  const c = $("#stars"), x = c.getContext("2d"); let w, h, pts;
  const init = () => { w = c.width = innerWidth * devicePixelRatio; h = c.height = $("#landing").offsetHeight * devicePixelRatio; c.style.height = $("#landing").offsetHeight + "px";
    pts = Array.from({ length: Math.min(90, Math.round(innerWidth / 14)) }, () => ({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - .5) * .25, vy: (Math.random() - .5) * .25, o: Math.random() < .12 })); };
  init(); addEventListener("resize", init);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tick = () => {
    if ($("#landing").hidden) return requestAnimationFrame(tick);
    x.clearRect(0, 0, w, h);
    const d = 150 * devicePixelRatio;
    for (const p of pts) { if (!reduce) { p.x += p.vx; p.y += p.vy; } if (p.x < 0 || p.x > w) p.vx *= -1; if (p.y < 0 || p.y > h) p.vy *= -1; }
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i], b = pts[j], dd = Math.hypot(a.x - b.x, a.y - b.y);
      if (dd < d) { x.strokeStyle = `rgba(${a.o || b.o ? "255,122,26" : "140,140,146"},${(1 - dd / d) * .22})`; x.lineWidth = devicePixelRatio; x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x, b.y); x.stroke(); }
    }
    for (const p of pts) { x.fillStyle = p.o ? "#FF7A1A" : "rgba(242,242,240,.5)"; x.beginPath(); x.arc(p.x, p.y, (p.o ? 2.2 : 1.3) * devicePixelRatio, 0, 7); x.fill(); }
    requestAnimationFrame(tick);
  };
  tick();
}
function unfinished() {
  const out = [];
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (!k.startsWith("wpetal:mission:")) continue; const m = JSON.parse(localStorage.getItem(k)); if (m && !m.finishedAt && m.profile && m.done) out.push(m); } } catch {}
  return out.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}
function renderRecent() {
  const cos = store.get("companies", {});
  const list = Object.values(cos).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)).slice(0, 6);
  const open = unfinished()[0];
  const res = open ? `<div class="resume" style="width:100%;display:flex;gap:8px;justify-content:center;align-items:center;flex-wrap:wrap;margin-bottom:6px"><span style="color:var(--ink)">Your check of <b>${esc(open.profile.name)}</b> was interrupted.</span><button type="button" data-resume="${esc(open.slug)}" style="border-color:var(--petal);color:var(--ink)">Resume where it stopped</button><button type="button" data-discard="${esc(open.slug)}">Discard</button></div>` : "";
  $("#recent").innerHTML = res + (list.length ? `<span>Saved companies:</span>` + list.map((c) => `<button type="button" data-slug="${esc(c.slug)}">${esc(c.profile.name)}</button>`).join("") : "");
  // Still running in another tab? Say so instead of calling it interrupted.
  if (open) lockedElsewhere(open.slug).then((busy) => {
    const box = $("#recent .resume"); if (!busy || !box) return;
    box.querySelector("span").innerHTML = `<b>${esc(open.profile.name)}</b> is running in another tab right now.`;
    const r = box.querySelector("[data-resume]"); r.textContent = "Continue here instead"; r.dataset.takeover = "1";
    box.querySelector("[data-discard]")?.remove();
  });
}
$("#startErr").addEventListener("click", (e) => { if (e.target.dataset.takeover) { localStorage.removeItem("wpetal:lock:" + (e.target.dataset.resume || e.target.dataset.slug)); $("#recent").dispatchEvent(new CustomEvent("takeover", { detail: e.target.dataset })); } });
$("#recent").addEventListener("takeover", (e) => { const d = e.detail; const fake = { target: { dataset: { ...d } } }; recentClick(fake); });
$("#recent").addEventListener("click", (e) => recentClick(e));
async function recentClick(e) {
  const s = e.target.dataset.slug, r = e.target.dataset.resume, x = e.target.dataset.discard;
  if (x) { const m = store.get("mission:" + x, null); if (m) { m.finishedAt = m.finishedAt || Date.now(); m.abandoned = true; store.set("mission:" + x, m); } return renderRecent(); }
  const slug = s || r; if (!slug) return;
  if (!e.target.dataset.takeover && (await lockedElsewhere(slug))) {
    $("#startErr").innerHTML = `This brand looks busy in another tab. <button type="button" class="linkbtn" style="color:var(--petal);text-decoration:underline" data-takeover="1" data-${r ? "resume" : "slug"}="${esc(slug)}">Continue here instead</button>`;
    return;
  }
  $("#startErr").textContent = "";
  if (e.target.dataset.takeover && BC) { BC.postMessage({ type: "takeover", slug }); await sleep(500); }
  const m = store.get("mission:" + slug, null);
  if (r && m) return resumeMission(m);
  if (m && m.finishedAt && !m.abandoned) { APP.M = m; showReport(); } else { const c = store.get("companies", {})[slug]; if (c) startOnboarding(c.profile.site, c); }
}
$("#startForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = $("#startUrl").value.trim();
  if (!url) return $("#startUrl").focus();
  if (APP.cfg.access) { APP.code = $("#accessCode").value.trim() || APP.code; store.set("code", APP.code); if (!APP.code) { $("#startErr").textContent = "Enter the access code first."; return; } }
  if (!APP.cfg.engines.length) { $("#startErr").textContent = "No AI engine is configured on the server. Add GEMINI_API_KEY (free) to the environment variables."; return; }
  startOnboarding(url);
});

/* =================================================================== MISSION UI */
const PHASES = [["site", "Read site"], ["questions", "Questions"], ["ask", "Ask AI live"], ["sources", "Follow sources"], ["think", "Analyse"], ["draft", "Draft fixes"]];
const CTRS = [["q", "Questions"], ["a", "Answers"], ["s", "Searches"], ["src", "Sources"], ["p", "Pages opened"], ["r", "Rivals seen"], ["c", "Contacts"], ["d", "Drafts"]];
const C = {};
function setupHud() {
  $("#track").innerHTML = PHASES.map(([k, l]) => `<div data-ph="${k}"><span>${l}</span><i style="--p:0%"></i></div>`).join("");
  $("#counters").innerHTML = CTRS.map(([k, l]) => `<div class="ctr" data-c="${k}"><b class="tnum">0</b><span>${l}</span></div>`).join("");
  CTRS.forEach(([k]) => (C[k] = 0));
}
const bumpAt = {};
function bump(k, n = 1) {
  C[k] = (C[k] || 0) + n; const el = $(`[data-c="${k}"]`); if (!el) return;
  el.querySelector("b").textContent = C[k];
  const now = Date.now(); if (now - (bumpAt[k] || 0) < 600) return; bumpAt[k] = now;
  el.classList.remove("bump"); requestAnimationFrame(() => el.classList.add("bump"));
}
function phase(k, pct, label) {
  $$("#track > div").forEach((d) => d.classList.toggle("on", d.dataset.ph === k));
  const el = $(`[data-ph="${k}"] i`); if (el) el.style.setProperty("--p", Math.round(pct) + "%");
  if (label) $("#hudPhase").textContent = label;
}
function finishPhase(k) { const el = $(`[data-ph="${k}"] i`); if (el) el.style.setProperty("--p", "100%"); }
function setRing(v) {
  const arc = $("#ringArc"); arc.style.strokeDashoffset = String(144.5 * (1 - (v || 0) / 100));
  $("#ringV").textContent = v == null ? "–" : v;
}

// ---- feed
let stick = true;
$("#feed").addEventListener("scroll", () => { const f = $("#feed"); stick = f.scrollHeight - f.scrollTop - f.clientHeight < 140; $("#jump").hidden = stick; });
$("#jump").addEventListener("click", () => { stick = true; scrollFeed(); $("#jump").hidden = true; });
function scrollFeed() { if (!stick) return; const f = $("#feed"); f.scrollTop = f.scrollHeight; if (innerWidth <= 980) { /* page scroll on mobile */ } }
function add(html, cls = "") { const d = document.createElement("div"); d.className = "ev " + cls; d.innerHTML = html; $("#feed").append(d); scrollFeed(); return d; }
function thought(text, why) { return add(`${text}${why ? `<span class="why">Why: ${why}</span>` : ""}`, "thought"); }
function stepEl(text, why) {
  const el = add(`<span class="ic"></span><div><span class="tx">${esc(text)}</span>${why ? `<span class="why">${esc(why)}</span>` : ""}</div>`, "step run");
  return { done(t, ok = true) { el.className = "ev step " + (ok ? "ok" : "bad"); el.querySelector(".ic").textContent = ok ? "✓" : "!"; if (t) el.querySelector(".tx").textContent = t; } };
}
let toastT;
function toast(html) { let t = $(".toast"); if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.append(t); } t.innerHTML = html; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.remove(), 4200); }

/* =================================================================== HIGHLIGHT */
function namesFor(M, extra = []) {
  const b = M.profile;
  const you = [b.name, host(b.site || "").split(".")[0]].filter((x) => x && x.length >= 3);
  const rivals = [...new Set([...(b.competitors || []), ...extra])].filter((x) => x && x.length >= 2 && !you.some((y) => norm(y) === norm(x)));
  return { you, rivals };
}
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function highlight(text, M, extra) {
  const { you, rivals } = namesFor(M, extra);
  let h = esc(text);
  const all = [...you.map((n) => [n, "you"]), ...rivals.map((n) => [n, ""])].sort((a, b) => b[0].length - a[0].length);
  for (const [n, cls] of all) {
    const re = new RegExp(`(?<![\\w>])(${reEsc(esc(n))})(?![\\w<])`, "gi");
    h = h.replace(re, (m, g, off, str) => { const before = str.slice(0, off); return before.lastIndexOf("<mark") > before.lastIndexOf("</mark>") ? m : `<mark class="${cls}">${g}</mark>`; });
  }
  return h;
}
const isYou = (name, M) => { const n = norm(name); return namesFor(M).you.some((y) => { const a = norm(y); return n === a || (" " + n + " ").includes(" " + a + " "); }); };
const textHasYou = (t, M) => { const x = " " + norm(t) + " "; return namesFor(M).you.some((y) => x.includes(" " + norm(y) + " ")); };
function md(t) {
  const lines = esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>').split("\n");
  let out = "", list = null;
  for (const l of lines) {
    const li = l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/);
    if (li) { if (!list) { list = /^\s*\d/.test(l) ? "ol" : "ul"; out += `<${list}>`; } out += `<li>${li[1]}</li>`; continue; }
    if (list) { out += `</${list}>`; list = null; }
    if (/^#{1,4}\s/.test(l)) out += `<h4>${l.replace(/^#{1,4}\s/, "")}</h4>`;
    else if (l.trim()) out += `<p>${l}</p>`;
  }
  if (list) out += `</${list}>`;
  return out;
}

/* =================================================================== LIVE MAP (d3) */
const G = { nodes: new Map(), links: new Map(), sim: null, pending: false };
function gInit() {
  const svg = d3.select("#map"); svg.selectAll("*").remove();
  G.nodes.clear(); G.links.clear();
  const root = svg.append("g");
  G.gl = root.append("g"); G.gn = root.append("g");
  svg.call(d3.zoom().scaleExtent([0.3, 4]).on("zoom", (e) => root.attr("transform", e.transform)));
  const box = () => $("#map").getBoundingClientRect();
  G.sim = d3.forceSimulation().alphaDecay(0.045).velocityDecay(0.5)
    .force("charge", d3.forceManyBody().strength((d) => (d.type === "you" ? -1200 : d.type === "rival" ? -420 : d.type === "source" ? -160 : -90)).distanceMax(600))
    .force("link", d3.forceLink().id((d) => d.id).distance((l) => l.dist || 70).strength((l) => l.str ?? 0.35))
    .force("x", d3.forceX(() => box().width / 2).strength(0.025))
    .force("y", d3.forceY(() => box().height / 2).strength(0.03))
    .force("collide", d3.forceCollide((d) => d.r + (d.type === "question" ? 4 : 14)))
    .on("tick", () => {
      G.gl.selectAll("line").attr("x1", (d) => d.source.x).attr("y1", (d) => d.source.y).attr("x2", (d) => d.target.x).attr("y2", (d) => d.target.y);
      G.gn.selectAll("g.node").attr("transform", (d) => `translate(${d.x},${d.y})`);
    });
  new ResizeObserver(() => G.sim.alpha(0.3).restart()).observe($("#map"));
}
const MAP_CAP = { source: 36, rival: 22, question: 40 };
function gNode(id, type, label, data = {}) {
  let n = G.nodes.get(id);
  if (!n && MAP_CAP[type] && [...G.nodes.values()].filter((x) => x.type === type).length >= MAP_CAP[type]) return { weight: 0 }; // too many to draw; the counters and tables still have everything
  const b = $("#map").getBoundingClientRect();
  if (!n) { n = { id, type, label, x: b.width / 2 + (Math.random() - .5) * 120, y: b.height / 2 + (Math.random() - .5) * 120, weight: 0, ...data }; if (type === "you") { n.fx = null; } G.nodes.set(id, n); }
  else Object.assign(n, data, { label: label || n.label });
  n.r = type === "you" ? 24 : type === "rival" ? Math.min(24, 8 + n.weight * 1.6) : type === "question" ? 6 : Math.min(15, 5 + n.weight * 1.5);
  gSchedule(); gFlash(id); return n;
}
function gLink(a, b, kind, color) {
  const id = a + "→" + b + "|" + kind;
  if (!G.links.has(id)) G.links.set(id, { id, source: a, target: b, kind, color, dist: kind === "cited" ? 90 : kind === "on" ? 110 : 150, str: kind === "named" ? 0.12 : 0.25 });
  gSchedule();
}
function gSchedule() { if (G.pending) return; G.pending = true; setTimeout(() => { G.pending = false; if (!document.hidden) gRender(); else gSchedule(); }, 700); }
function nodeColor(d) {
  if (d.type === "you") return "#FF7A1A";
  if (d.type === "rival") return "#E2483D";
  if (d.type === "question") return d.named ? "#FFC46B" : "#A79BFF";
  return "#3CC9B5";
}
function nodeStroke(d) { if (d.type === "source" && d.inspected) return d.you ? "#45D19A" : d.rivals ? "#E2483D" : "#5A5A5E"; return "#0B0B0C"; }
function gRender() {
  const nodes = [...G.nodes.values()], links = [...G.links.values()].filter((l) => G.nodes.has(l.source.id || l.source) && G.nodes.has(l.target.id || l.target));
  G.gl.selectAll("line").data(links, (d) => d.id).join((en) => en.append("line").attr("class", "link"))
    .attr("stroke", (d) => d.color || "#5A5A5E").attr("stroke-width", (d) => (d.kind === "named" ? 1.4 : 1)).attr("stroke-dasharray", (d) => (d.kind === "cited" ? "3 3" : null));
  const g = G.gn.selectAll("g.node").data(nodes, (d) => d.id).join((en) => {
    const e = en.append("g").attr("class", (d) => "node " + d.type);
    e.append("circle"); e.append("text").attr("dy", (d) => (d.type === "you" ? 40 : d.type === "rival" ? -12 : 18)).attr("text-anchor", "middle");
    e.on("mouseenter", (ev, d) => tip(ev, d)).on("mousemove", (ev) => moveTip(ev)).on("mouseleave", hideTip).on("click", (ev, d) => openDrawer(d));
    e.call(d3.drag().on("start", (ev, d) => { if (!ev.active) G.sim.alphaTarget(0.2).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; }).on("end", (ev, d) => { if (!ev.active) G.sim.alphaTarget(0); d.fx = null; d.fy = null; }));
    return e;
  });
  g.select("circle").attr("r", (d) => d.r).attr("fill", nodeColor).attr("stroke", nodeStroke).attr("stroke-width", (d) => (d.type === "source" && d.inspected ? 2.5 : 1.5))
    .attr("fill-opacity", (d) => (d.type === "source" && d.inspected && !d.you && !d.rivals ? 0.45 : 1));
  g.select("text").text((d) => (d.type === "question" ? "" : (d.label || "").slice(0, d.type === "source" ? 22 : 26)));
  G.sim.nodes(nodes); G.sim.force("link").links(links); G.sim.alpha(Math.min(0.45, G.sim.alpha() + 0.25)).restart();
}
function gFlash(id) { setTimeout(() => { const el = G.gn && G.gn.selectAll("g.node").filter((d) => d.id === id).node(); if (el) { el.classList.remove("flash"); void el.getBBox(); el.classList.add("flash"); } }, 200); }
const tipEl = $("#tip");
function tip(ev, d) {
  const M = APP.M; let h = `<b>${esc(d.label)}</b>`;
  if (d.type === "question") h = `<span class="muted">Buyer question</span><br><b>${esc(d.label)}</b>`;
  if (d.type === "rival") h += `<br><span class="muted">Named in ${d.weight} answer${d.weight === 1 ? "" : "s"}${d.pages ? ` · on ${d.pages} cited page${d.pages === 1 ? "" : "s"}` : ""}</span>`;
  if (d.type === "source") h += `<br><span class="muted">Cited ${d.weight}× · ${d.inspected ? (d.you ? "you're on it" : "you're not on it") : "not opened yet"}</span>`;
  if (d.type === "you") h += `<br><span class="muted">Named in ${M ? countNamed(M) : 0} answers</span>`;
  tipEl.innerHTML = h + `<br><span class="muted" style="font-size:.7rem">click for details</span>`; tipEl.hidden = false; moveTip(ev);
}
function moveTip(ev) { tipEl.style.left = Math.min(innerWidth - 290, ev.clientX + 14) + "px"; tipEl.style.top = ev.clientY + 14 + "px"; }
function hideTip() { tipEl.hidden = true; }
function openDrawer(d) {
  const M = APP.M; if (!M) return;
  $$(".drawer").forEach((x) => x.remove());
  const dr = document.createElement("div"); dr.className = "drawer";
  let h = `<button class="linkbtn x" type="button" aria-label="Close">✕</button>`;
  const ans = Object.values(M.answers);
  if (d.type === "question") {
    const q = M.questions.find((x) => "q:" + x.id === d.id);
    h += `<span class="status">Buyer question · ${esc(q?.intent || "")}</span><h3>${esc(d.label)}</h3>`;
    ans.filter((a) => "q:" + a.qid === d.id).forEach((a) => { h += `<div class="card"><div class="hd"><span class="eng"><i style="background:${ENGC[a.engine]}"></i>${ENG[a.engine]}</span><span class="sp"></span>${verdictHtml(a)}</div><div class="answer full">${highlight(a.answer || "", M, a.brands)}</div>${srcChips(a.sources)}</div>`; });
  } else if (d.type === "rival" || d.type === "you") {
    const name = d.label; const qs = ans.filter((a) => (d.type === "you" ? a.named : (a.brands || []).some((b) => norm(b) === norm(name))));
    const pages = Object.values(M.inspections || {}).filter((p) => p.ok && (d.type === "you" ? p.you : (p.rivals || []).some((r) => norm(r) === norm(name))));
    h += `<span class="status">${d.type === "you" ? "You" : "Rival"}</span><h3>${esc(name)}</h3><p class="muted">Named in ${qs.length} of ${ans.filter((a) => a.status !== "run").length} answers. On ${pages.length} of the ${Object.keys(M.inspections || {}).length} cited pages I opened.</p>`;
    if (qs.length) h += `<b style="font-size:.85rem">Named for</b><div class="chips">${[...new Set(qs.map((a) => qText(M, a.qid)))].map((q) => `<span class="chip">${esc(q)}</span>`).join("")}</div>`;
    if (pages.length) h += `<b style="font-size:.85rem">Pages that carry ${d.type === "you" ? "you" : "it"}</b>` + pages.map((p) => `<div class="irow"><span class="chip ${d.type === "you" ? "you" : "rv"}">${esc(p.domain)}</span><div><a href="${esc(safeUrl(p.final) || "#")}" target="_blank" rel="noopener">${esc(p.title || p.final)}</a>${(p.evidence || []).filter((e) => norm(e.name) === norm(name)).map((e) => `<div class="ev2">“${highlight(e.snippet, M)}”</div>`).join("")}</div></div>`).join("");
  } else if (d.type === "source") {
    const dom = d.id.slice(2); const url = d.url;
    const pages = Object.values(M.inspections || {}).filter((x) => host(x.url) === dom);
    const p = pages.find((x) => x.ok) || pages[0];
    const by = ans.filter((a) => (a.sources || []).some((s) => host(s.url) === dom));
    h += `<span class="status">${esc(dom)} · cited ${d.weight}× across answers${pages.length > 1 ? ` · ${pages.length} pages opened` : ""}</span><h3>${esc(p?.title || d.label)}</h3><a href="${esc(safeUrl(url) || "#")}" target="_blank" rel="noopener" style="font-size:.8rem;overflow-wrap:anywhere">${esc(url)}</a>`;
    if (p && p.ok) h += `<div class="chips">${p.you ? '<span class="chip ok">You are on this page</span>' : '<span class="chip no">You are not on this page</span>'}${(p.rivals || []).map((r) => `<span class="chip rv">${esc(r)}</span>`).join("")}</div>${(p.evidence || []).map((e) => `<div class="ev2" style="font-size:.8rem;color:var(--muted)">“${highlight(e.snippet, M)}”</div>`).join("")}${contactHtml(p.contacts)}`;
    else if (p) h += `<p class="muted">Couldn't open it: ${esc(p.reason || "")}</p>`;
    h += `<b style="font-size:.85rem">Cited for</b><div class="chips">${[...new Set(by.map((a) => qText(M, a.qid)))].map((q) => `<span class="chip">${esc(q)}</span>`).join("")}</div>`;
  }
  dr.innerHTML = h; $(".mapwrap").append(dr);
  dr.querySelector(".x").onclick = () => dr.remove();
}
const sidOf = (u) => "s:" + host(u);
const qText = (M, qid) => (M.questions.find((q) => q.id === qid) || {}).text || "";
function srcChips(src) { return `<div class="srcs">${(src || []).slice(0, 12).map((s) => `<a class="src${s.cited ? "" : " weak"}" href="${esc(safeUrl(s.url) || "#")}" target="_blank" rel="noopener" title="${esc(s.title || s.url)}">${esc(host(s.url))}</a>`).join("")}</div>`; }
function contactHtml(c) { if (!c) return ""; const bits = []; if (c.author) bits.push(`Author: <b>${esc(c.author)}</b>`); (c.emails || []).forEach((m) => bits.push(`<span class="mono">${esc(m)}</span>`)); (c.links || []).slice(0, 2).forEach((l) => bits.push(`<a href="${esc(l)}" target="_blank" rel="noopener">${esc(host(l))}${esc((() => { try { return new URL(l).pathname.slice(0, 24); } catch { return ""; } })())}</a>`)); return bits.length ? `<div class="chips" style="font-size:.78rem">${bits.map((b) => `<span class="chip">${b}</span>`).join("")}</div>` : ""; }
function verdictHtml(a) { return a.status === "run" ? '<span class="verdict wait">reading…</span>' : a.status === "err" ? '<span class="verdict wait">failed</span>' : a.named ? `<span class="verdict yes">NAMED${a.rank ? " #" + a.rank : ""}</span>` : '<span class="verdict no">NOT NAMED</span>'; }
function countNamed(M) { return Object.values(M.answers).filter((a) => a.named).length; }

/* =================================================================== MATRIX */
const MX = new Map();
function renderMatrix(el, M, big) { if (MX.has(el)) return; MX.set(el, 1); later(() => { MX.delete(el); renderMatrixNow(el, M, big); }); }
function renderMatrixNow(el, M, big) {
  const engs = M.engines;
  el.style.gridTemplateColumns = `minmax(0,1fr) repeat(${engs.length}, ${big ? "92px" : "56px"})`;
  let h = `<div></div>` + engs.map((e) => `<div class="eh">${ENG[e]}</div>`).join("");
  for (const q of M.questions) {
    h += `<div class="qh" title="${esc(q.text)}" data-q="${esc(q.id)}">${esc(q.text)}</div>`;
    for (const e of engs) { const a = M.answers[q.id + "|" + e]; const cls = !a ? "" : a.status === "run" ? "run" : a.status === "err" ? "err" : a.named ? "yes" : "no"; h += `<div class="cell ${cls}" data-cell="${esc(q.id + "|" + e)}">${a && a.status !== "run" && a.status !== "err" ? (a.named ? (a.rank ? "#" + a.rank : "✓") : "–") : ""}</div>`; }
  }
  el.innerHTML = h;
}
document.addEventListener("click", (e) => {
  const c = e.target.closest("[data-cell]"); if (!c || !APP.M) return;
  const a = APP.M.answers[c.dataset.cell]; if (!a || a.status === "run") return;
  if (!$("#reportWrap").hidden && finished(a)) return openChat(c.dataset.cell);
  modal(`<span class="status">${ENG[a.engine]} · ${esc(a.model || "")}</span><h3>${esc(qText(APP.M, a.qid))}</h3><div>${verdictHtml(a)}</div>${(a.searches || []).length ? `<div class="chips">${a.searches.map((s) => `<span class="search">searched: ${esc(s)}</span>`).join("")}</div>` : ""}<div class="answer full">${highlight(a.answer || a.error || "", APP.M, a.brands)}</div><b style="font-size:.85rem">Sources it used</b>${srcChips(a.sources)}`);
});
function modal(html) { const m = document.createElement("div"); m.className = "modal" + (document.body.classList.contains("is-light") ? " light" : ""); m.innerHTML = `<div class="box">${html}<div><button class="btn ghost sm" type="button">Close</button></div></div>`; m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("button.btn")) m.remove(); }); document.body.append(m); }
addEventListener("keydown", (e) => { if (e.key === "Escape") { $$(".modal,.drawer").forEach((x) => x.remove()); } });

/* =================================================================== MISSION */
function newMission(profile, audit, siteText) {
  return { id: Date.now().toString(36), slug: slugify(profile.name), startedAt: Date.now(), finishedAt: null, profile, audit, siteText, engines: APP.cfg.engines.slice(), questions: [], answers: {}, inspections: {}, perception: null, insights: "", assets: null, pitches: {}, fixpack: "", articles: {}, deck: {}, chat: [], done: {} };
}
let saveT = 0;
function save(now) {
  if (!APP.M || APP.frozen === APP.M.slug) return;
  const run = () => { saveT = 0; APP.M.savedAt = Date.now(); store.set("mission:" + APP.M.slug, slim(APP.M)); if (APP.running) lockTouch(APP.M.slug); };
  if (now) { clearTimeout(saveT); return run(); }
  if (!saveT) saveT = setTimeout(run, 1500);
}
// Keep what the results need, drop bulk that only bloats storage.
function slim(M) {
  const answers = {};
  for (const [k, a] of Object.entries(M.answers || {})) {
    const src = a.sources || [], cited = src.filter((s) => s.cited), rest = src.filter((s) => !s.cited);
    answers[k] = { ...a, answer: String(a.answer || "").slice(0, 4000), sources: [...cited, ...rest].slice(0, 20), searches: (a.searches || []).slice(0, 6),
      nSrc: Math.max(a.nSrc || 0, src.length), nS: Math.max(a.nS || 0, (a.searches || []).length) };
  }
  const inspections = {};
  for (const [k, p] of Object.entries(M.inspections || {})) inspections[k] = { ...p, excerpt: String(p.excerpt || "").slice(0, 600) };
  return { ...M, answers, inspections, siteText: String(M.siteText || "").slice(0, 6000) };
}
const later = (f) => (document.hidden ? setTimeout(f, 250) : requestAnimationFrame(f));
const throttled = (f) => { let p = 0; return () => { if (!p) p = later(() => { p = 0; f(); }); }; };
const retryable = (e) => /429|rate|limit|quota exceeded|overload|timed out|timeout|temporar|unavailable|502|503|504|network|fetch|stream/i.test(String(e?.message || e));
function rivalCounts(M) { const rc = {}; Object.values(M.answers || {}).forEach((a) => (a.brands || []).forEach((b) => { if (!isYou(b, M)) rc[b] = (rc[b] || 0) + 1; })); return rc; }
// One tab runs a brand at a time; other tabs see it's busy instead of overwriting each other.
const TAB = Math.random().toString(36).slice(2);
function lockTouch(slug) { store.set("lock:" + slug, { tab: TAB, ts: Date.now() }); }
function lockRelease(slug) { const l = store.get("lock:" + slug, null); if (l && l.tab === TAB) { try { localStorage.removeItem("wpetal:lock:" + slug); } catch {} } }
// Ask other open tabs directly whether they are running this brand (no stale locks after a tab closes or navigates).
const BC = "BroadcastChannel" in window ? new BroadcastChannel("wpetal") : null;
if (BC) BC.onmessage = (ev) => {
  const d = ev.data || {}; const mine = APP.running && APP.M && APP.M.slug === d.slug;
  if (d.type === "ping" && mine) BC.postMessage({ type: "pong", slug: d.slug });
  // Another tab took this run over: save, stop here, and say where it went.
  if (d.type === "takeover" && mine) { save(true); clearTimeout(saveT); saveT = 0; APP.frozen = d.slug; APP.handedOff = true; APP.ctl?.abort(); }
};
function lockedElsewhere(slug) {
  if (!BC) { const l = store.get("lock:" + slug, null); return Promise.resolve(!!(l && l.tab !== TAB && Date.now() - l.ts < 25000)); }
  return new Promise((done) => { let got = false; const h = (ev) => { if (ev.data?.type === "pong" && ev.data.slug === slug) got = true; }; BC.addEventListener("message", h); BC.postMessage({ type: "ping", slug }); setTimeout(() => { BC.removeEventListener("message", h); done(got); }, 350); });
}
setInterval(() => { if (APP.running && APP.M) lockTouch(APP.M.slug); }, 8000);

function missionUI(title) {
  screen("mission");
  $("#feed").innerHTML = ""; setupHud(); gInit(); setRing(null); $("#toReport").hidden = true; $("#stopBtn").hidden = false;
  $("#liveTag").className = "live"; $("#liveTag").innerHTML = "<i></i>Live"; $("#matrix").innerHTML = "";
  APP.ctl?.abort(); APP.ctl = new AbortController(); APP.running = true; APP.resuming = false; APP.frozen = null; stick = true;
  $("#hudBrand").textContent = title;
  return APP.ctl.signal;
}

async function resumeMission(M) {
  const sig = missionUI(M.profile.name);
  APP.M = M; M.done = M.done || {};
  rebuildMap(M); renderMatrix($("#matrix"), M); setRing(liveScore(M));
  const ans = Object.values(M.answers || {});
  const fin = ans.filter((a) => a.status === "yes" || a.status === "no");
  bump("q", M.questions.length); bump("a", fin.length); bump("s", fin.reduce((s, a) => s + Math.max(a.nS || 0, (a.searches || []).length), 0)); bump("src", fin.reduce((s, a) => s + Math.max(a.nSrc || 0, (a.sources || []).length), 0)); bump("p", Object.keys(M.inspections || {}).length); bump("r", Object.keys(rivalCounts(M)).length); bump("d", Object.keys(M.pitches || {}).length + (M.assets ? 1 : 0));
  PHASES.forEach(([k]) => { if (M.done[{ site: "questions", questions: "questions", ask: "ask", sources: "sources", think: "insights", draft: "draft" }[k]] || k === "site") finishPhase(k); });
  thought(`<b>Picking up where I left off.</b> ${M.questions.length} questions and ${ans.filter((a) => a.status === "yes" || a.status === "no").length} answers are already saved. Nothing gets asked twice.`, "Runs are saved after every step, so leaving the page doesn't lose work.");
  try { await runPipeline(M, sig); } catch (err) { missionError(err, sig); }
}

function missionError(err, sig) {
  APP.running = false; if (APP.M) lockRelease(APP.M.slug);
  if (APP.resuming) return; // the page came back from the background; resume handles the UI
  const M = APP.M;
  if (sig.aborted) {
    if (APP.handedOff) { APP.handedOff = false; thought("<b>This run moved to another tab.</b> It's continuing there, so this tab has stopped to avoid doing the work twice."); $("#liveTag").className = "live off"; $("#liveTag").innerHTML = "<i></i>Moved"; $("#stopBtn").hidden = true; const row = add(`<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn ghost sm" type="button" data-home>← Back to start</button></div>`); row.querySelector("[data-home]").onclick = goHome; return; }
    thought("<b>Paused.</b> Everything so far is saved. You can resume any time or see results now.");
    if (M) { save(); $("#toReport").hidden = false; }
    const row = add(`<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm" type="button" data-resume>Resume the agent</button><button class="btn ghost sm" type="button" data-home>← Back to start</button></div>`);
    row.querySelector("[data-resume]").onclick = () => resumeMission(APP.M);
    row.querySelector("[data-home]").onclick = goHome;
    if (!M) row.querySelector("[data-resume]").remove();
  } else {
    add(`<span class="ic">!</span><div><span class="tx">${esc(err.message)}</span><span class="why">${M ? "Your progress is saved. Fix it and resume, or start again." : "Fix it and start again. Saved companies keep their profile."}</span></div>`, "step bad");
    const row = add(`<div style="display:flex;gap:8px;flex-wrap:wrap">${M ? '<button class="btn sm" type="button" data-resume>Resume</button>' : ""}<button class="btn ghost sm" type="button" data-home>← Back to start</button></div>`);
    row.querySelector("[data-resume]")?.addEventListener("click", () => resumeMission(APP.M));
    row.querySelector("[data-home]").onclick = goHome;
  }
  $("#liveTag").className = "live off"; $("#liveTag").innerHTML = sig.aborted ? "<i></i>Paused" : "<i></i>Stopped"; $("#stopBtn").hidden = true;
}

async function runPipeline(M, sig) {
  M.done = M.done || {};
  const profile = M.profile;
    // ---------- 2. questions
    if (!M.done.questions) {
    M.questions = []; M.answers = {};
    phase("questions", 10, "Writing buyer questions");
    thought(`<b>Writing the questions a buyer types into ChatGPT</b> before choosing a ${esc(profile.category || "solution")}. I leave your name out on purpose.`, "We want to see whether AI brings you up on its own, the way a real buyer would experience it.");
    const qc = add(`<div class="hd"><span>Buyer questions</span><span class="sp"></span><span class="mono qn" style="font-size:.7rem">0</span></div><div class="ql"></div>`, "card hot");
    let buf = "";
    const takeLine = (line) => {
      const m = line.split("|"); if (m.length < 2) return; const intent = m[0].trim().toLowerCase().slice(0, 14), text = m.slice(1).join("|").trim().replace(/^["“]|["”]$/g, "");
      if (!text || M.questions.some((q) => norm(q.text) === norm(text))) return;
      const q = { id: "q" + (M.questions.length + 1), intent, text }; M.questions.push(q);
      qc.querySelector(".ql").insertAdjacentHTML("beforeend", `<div><span>${esc(intent)}</span>${esc(text)}</div>`); qc.querySelector(".qn").textContent = M.questions.length;
      gNode("q:" + q.id, "question", text); bump("q"); phase("questions", Math.min(95, M.questions.length * 8)); scrollFeed();
    };
    await stream("/api/write", { kind: "questions", data: { profile, count: 12 } }, {
      delta: (d) => { buf += d.text; const lines = buf.split("\n"); buf = lines.pop(); lines.forEach(takeLine); },
      final: () => { if (buf.trim()) takeLine(buf); },
    }, sig);
    qc.classList.remove("hot");
    if (!M.questions.length) throw new Error("The AI didn't return any buyer questions. Try again in a minute.");
    M.done.questions = true; save(true);
    }
    finishPhase("questions"); renderMatrix($("#matrix"), M);

    // ---------- 3. ask AI live
    const engs = M.engines;
    const isDone = (a) => a && (a.status === "yes" || a.status === "no");
    const jobs = []; for (const q of M.questions) for (const e of engs) if (!isDone(M.answers[q.id + "|" + e])) jobs.push([q, e]);
    if (!M.done.ask && jobs.length) {
    phase("ask", 2, `Asking ${engs.map((e) => ENG[e]).join(", ")} live`);
    thought(`<b>Asking ${engs.map((e) => ENG[e]).join(", ")} all ${M.questions.length} questions, live, with web search on.</b> ${jobs.length} conversations, 2 at a time. Watch who gets named and which pages they lean on.`, "This is exactly what your buyers see. Every page an engine cites is a lever we can pull.");
    let done = 0; let firstYou = countNamed(M) === 0;
    const runOne = async ([q, e]) => {
      if (sig.aborted) return;
      const key = q.id + "|" + e; const a = (M.answers[key] = { qid: q.id, engine: e, status: "run", answer: "", sources: [], brands: [], searches: [] });
      renderMatrix($("#matrix"), M);
      const card = add(`<div class="hd"><span class="eng"><i style="background:${ENGC[e]}"></i>${ENG[e]}</span><span class="sp"></span><span class="vd">${verdictHtml(a)}</span></div><div class="q">${esc(q.text)}</div><div class="status st">Connecting</div><div class="chips sq"></div><div class="answer typing"></div><div class="sr"></div>`, "card hot");
      const ansEl = card.querySelector(".answer"); let raf = 0;
      const paint = () => { raf = 0; ansEl.innerHTML = highlight(a.answer, M); ansEl.classList.toggle("short", a.answer.length < 400); scrollFeed(); };
      for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (attempt > 1) { Object.assign(a, { status: "run", answer: "", sources: [], brands: [], searches: [], error: "", nSrc: 0, nS: 0 }); card.querySelector(".st").textContent = `Retrying (attempt ${attempt} of 3)`; card.querySelector(".sq").innerHTML = ""; }
        await stream("/api/ask", { engine: e, question: q.text, brand: profile }, {
          status: (d) => { card.querySelector(".st").textContent = d.text; },
          search: (d) => { a.searches.push(d.query); a.nS = (a.nS || 0) + 1; bump("s"); card.querySelector(".sq").insertAdjacentHTML("beforeend", `<span class="search">searched: ${esc(d.query)}</span>`); },
          source: (d) => {
            if (!a.sources.some((s) => s.url === d.url)) { a.sources.push(d); a.nSrc = (a.nSrc || 0) + 1; bump("src"); }
            if (!card._srcT) card._srcT = later(() => { card._srcT = 0; card.querySelector(".sr").innerHTML = srcChips(a.sources); });
            const sid = sidOf(d.url);
            const sn = gNode(sid, "source", host(d.url), { url: d.url }); sn.weight = (sn.weight || 0) + 1; gLink("q:" + q.id, sid, "cited", "#3CC9B5");
          },
          delta: (d) => { a.answer += d.text; if (!raf) raf = later(paint); },
          final: (d) => {
            a.answer = d.answer || a.answer; a.sources = d.sources?.length ? d.sources : a.sources; a.brands = d.brands || []; a.model = d.model;
            const idx = a.brands.findIndex((b) => isYou(b, M));
            a.named = idx >= 0 || textHasYou(a.answer, M); a.rank = idx >= 0 ? idx + 1 : null; a.status = a.named ? "yes" : "no";
          },
        }, sig);
        if (a.status === "run") throw new Error("No answer came back");
        break;
      } catch (err) {
        if (sig.aborted) return;
        a.status = "err"; a.error = err.message; card.querySelector(".st").textContent = err.message;
        if (attempt < 3 && retryable(err)) { await sleep(2500 * attempt + Math.random() * 1500); continue; }
        break;
      }
      }
      raf = 0; paint(); ansEl.classList.remove("typing"); card.classList.remove("hot");
      card.querySelector(".vd").innerHTML = verdictHtml(a);
      card.querySelector(".st").textContent = a.status === "err" ? a.error : `${a.model || ""} · ${a.sources.length} sources · ${a.brands.length} brands named`;
      card.querySelector(".sr").innerHTML = srcChips(a.sources);
      bump("a"); done++; phase("ask", (100 * done) / jobs.length);
      if (a.status !== "err") {
        const qn = G.nodes.get("q:" + q.id); if (qn && a.named) { qn.named = true; }
        for (const b of a.brands) {
          if (isYou(b, M)) { gLink("q:" + q.id, "you", "named", "#FF7A1A"); continue; }
          const rid = "r:" + norm(b); const rn = gNode(rid, "rival", b); rn.weight = (rn.weight || 0) + 1; gLink("q:" + q.id, rid, "named", ({ chatgpt: "#45D19A", perplexity: "#5FA8FF", gemini: "#C9A2FF", groq: "#F5F5F3" })[e] || "#8A8A8E");
          const rc = rivalCounts(M)[b] || 0; if (rc === 1) bump("r");
          if (rc === 4) toast(`<b>${esc(b)}</b> has now been named 4 times. I'll check which pages carry it.`);
        }
        if (a.named && firstYou) { firstYou = false; toast(`${ENG[e]} named <b>${esc(profile.name)}</b>${a.rank ? " at #" + a.rank : ""} for “${esc(q.text)}”.`); }
        const v = liveScore(M); setRing(v);
      }
      renderMatrix($("#matrix"), M); save();
    };
    const queue = jobs.slice();
    await Promise.all([0, 1].map(async () => { while (queue.length && !sig.aborted) await runOne(queue.shift()); }));
    }
    if (sig.aborted) throw new DOMException("stopped", "AbortError");
    M.done.ask = true; save(true); finishPhase("ask");
    const answered = Object.values(M.answers).filter((a) => a.status !== "err" && a.status !== "run");
    if (!answered.length) throw new Error("None of the AI engines answered. Check your API key and quota, then resume.");
    const top = Object.entries(rivalCounts(M)).sort((a, b) => b[1] - a[1]);
    thought(`<b>${countNamed(M)} of ${answered.length} answers named you.</b> ${top[0] ? `${esc(top[0][0])} was named ${top[0][1]} times${top[1] ? `, ${esc(top[1][0])} ${top[1][1]}` : ""}.` : ""}`);

    // ---------- 4. follow the sources
    const cites = {};
    for (const a of answered) for (const s of a.sources || []) { const k = s.url; (cites[k] = cites[k] || { url: k, n: 0, qs: new Set(), cited: false }); cites[k].n++; cites[k].qs.add(a.qid); cites[k].cited ||= s.cited; }
    const targets = Object.values(cites).sort((a, b) => b.n - a.n || (b.cited ? 1 : 0) - (a.cited ? 1 : 0)).slice(0, 24).filter((t) => !M.inspections[t.url]);
    if (!M.done.sources && targets.length && !sig.aborted) {
      phase("sources", 3, "Following the sources");
      thought(`<b>AI repeats what the web says.</b> The engines leaned on ${Object.keys(cites).length} pages. I'm opening the ${targets.length} that came up most to see who's on them.`, "If a rival is on the pages AI trusts and you're not, that's why it gets named. Those pages are your outreach list.");
      const ic = add(`<div class="hd"><span>Cited pages, opened</span><span class="sp"></span><span class="mono ipn" style="font-size:.7rem">0 / ${targets.length}</span></div><div class="irows"></div>`, "card hot");
      let k = 0; const q2 = targets.slice();
      await Promise.all([0, 1, 2, 3].map(async () => {
        while (q2.length && !sig.aborted) {
          const t = q2.shift();
          let r; try { r = await post("/api/inspect", { url: t.url, brand: profile }, sig); } catch (e) { r = { ok: false, url: t.url, reason: e.message }; }
          r.n = t.n; r.qs = [...t.qs]; M.inspections[t.url] = r; k++; bump("p");
          ic.querySelector(".ipn").textContent = `${k} / ${targets.length}`; phase("sources", (100 * k) / targets.length);
          const sid = sidOf(t.url);
          const sn = gNode(sid, "source", host(r.final || t.url), { url: t.url, inspected: true, you: !!r.you, rivals: (r.rivals || []).length });
          if (r.ok) {
            if (r.you) gLink(sid, "you", "on", "#FF7A1A");
            (r.rivals || []).forEach((rv) => { const rid = "r:" + norm(rv); const rn = gNode(rid, "rival", rv); rn.pages = (rn.pages || 0) + 1; gLink(sid, rid, "on", "#E2483D"); });
            if ((r.contacts?.emails || []).length || r.contacts?.author || (r.contacts?.links || []).length) bump("c");
          }
          ic.querySelector(".irows").insertAdjacentHTML("beforeend", `<div class="irow"><span class="chip ${!r.ok ? "" : r.you ? "ok" : (r.rivals || []).length ? "no" : ""}">${!r.ok ? "blocked" : r.you ? "you ✓" : "you ✕"}</span><div style="min-width:0"><div class="d">${esc(r.title || host(t.url))} <span class="muted" style="font-weight:400">· cited ${t.n}×</span></div>${r.ok ? `<div class="ev2">${(r.rivals || []).length ? `Rivals here: ${r.rivals.map((x) => `<b>${esc(x)}</b>`).join(", ")}` : "No tracked rivals here"}${r.contacts?.emails?.length ? ` · contact: <span class="mono">${esc(r.contacts.emails[0])}</span>` : r.contacts?.author ? ` · author: ${esc(r.contacts.author)}` : ""}</div>${r.evidence?.[0] ? `<div class="ev2">“${highlight(r.evidence[0].snippet, M)}”</div>` : ""}` : `<div class="ev2">${esc(r.reason || "Couldn't open")}</div>`}</div></div>`);
          scrollFeed(); save();
        }
      }));
      ic.classList.remove("hot"); finishPhase("sources");
      const opened = Object.values(M.inspections).filter((p) => p.ok);
      const onYou = opened.filter((p) => p.you).length; const rc = {};
      opened.forEach((p) => (p.rivals || []).forEach((r) => (rc[r] = (rc[r] || 0) + 1)));
      const tr = Object.entries(rc).sort((a, b) => b[1] - a[1])[0];
      thought(`<b>Found the pattern.</b> You're on ${onYou} of the ${opened.length} pages AI trusts.${tr ? ` ${esc(tr[0])} is on ${tr[1]}.` : ""} ${opened.length - onYou} pages are open targets.`, "Getting listed on these pages is the fastest way to start appearing in answers.");
    } else finishPhase("sources");
    if (sig.aborted) throw new DOMException("stopped", "AbortError");
    M.done.sources = true; save(true);

    // ---------- 5. what AI says about you + insights
    phase("think", 10, "Checking what AI says about you");
    if (!M.done.perception && !sig.aborted) {
      thought(`<b>Now asking ${ENG[engs[0]]} what it knows about ${esc(profile.name)}</b>, then fact-checking every claim against your own site.`, "Wrong or outdated claims cost deals. You can't fix what you haven't seen.");
      const pq = [`What is ${profile.name}?`, `Is ${profile.name} a good choice for ${profile.category || "this"}? What are the alternatives?`];
      const pAns = [];
      // Both questions at once: half the wait.
      await Promise.all(pq.map(async (qq, i) => {
        if (sig.aborted) return;
        const card = add(`<div class="hd"><span class="eng"><i style="background:${ENGC[engs[0]]}"></i>${ENG[engs[0]]}</span><span class="chip you">about you</span></div><div class="q">${esc(qq)}</div><div class="answer typing"></div>`, "card hot");
        const el = card.querySelector(".answer"); let t = ""; const paintP = throttled(() => { el.innerHTML = highlight(t, M); scrollFeed(); });
        try { await stream("/api/ask", { engine: engs[0], question: qq, brand: profile }, { delta: (d) => { t += d.text; paintP(); }, final: (d) => { t = d.answer || t; } }, sig); } catch (e) { t = t || e.message; }
        el.classList.remove("typing"); el.innerHTML = highlight(t, M); card.classList.remove("hot"); pAns[i] = { q: qq, a: t };
      }));
      phase("think", 45);
      const pc = add(`<div class="hd"><span>Fact-check</span><span class="sp"></span><svg class="pq think" viewBox="0 0 56 30" style="height:12px;width:22px;color:var(--muted)"><rect x="0" width="16" height="30" rx="4.5" fill="currentColor" opacity=".55"/><rect x="20" width="16" height="30" rx="4.5" fill="#FF7A1A"/><rect x="40" width="16" height="30" rx="4.5" fill="currentColor" opacity=".55"/></svg></div><div class="body status">Comparing claims with your site</div>`, "card hot");
      let raw = "";
      try { await stream("/api/write", { kind: "perception", data: { profile, answers: pAns.filter(Boolean) } }, { delta: (d) => { raw += d.text; } }, sig); M.perception = parseLoose(raw); } catch { M.perception = null; }
      pc.classList.remove("hot");
      if (!sig.aborted) M.done.perception = true;
      pc.querySelector(".body").outerHTML = M.perception ? `<p style="font-size:.88rem">${esc(M.perception.summary || "")}</p><div class="chips" style="flex-direction:column;align-items:flex-start">${(M.perception.claims || []).map((c) => `<div style="font-size:.84rem"><span class="chip ${c.verdict === "accurate" ? "ok" : c.verdict === "wrong" ? "no" : "rv"}">${esc(c.verdict)}</span> ${esc(c.claim)}</div>`).join("")}</div>` : `<p class="muted">Couldn't complete the fact-check.</p>`;
      save();
    }
    if (!M.done.insights && !sig.aborted) {
      phase("think", 70, "Working out why");
      thought(`<b>Putting it together.</b> Here's my read of everything above.`);
      const ins = add(`<div class="hd"><span>Insights</span></div><div class="md typing"></div>`, "card hot");
      let t = ""; const paintI = throttled(() => { ins.querySelector(".md").innerHTML = md(t); scrollFeed(); });
      await stream("/api/write", { kind: "insights", data: { profile, digest: digest(M) } }, { delta: (d) => { t += d.text; paintI(); } }, sig).catch(() => {});
      ins.querySelector(".md").innerHTML = md(t); M.insights = t; if (t && !sig.aborted) M.done.insights = true; ins.querySelector(".md").classList.remove("typing"); ins.classList.remove("hot"); save();
    }
    finishPhase("think");

    // ---------- 6. drafts
    if (!M.done.draft && !sig.aborted) {
      phase("draft", 5, "Drafting your fixes");
      thought(`<b>Drafting the fixes.</b> Site code first, then personalised pitches for the pages where rivals are listed and you're not. You approve each one on the next screen.`, "Each draft is written for one specific page or gap. Nothing is generic.");
      if (!M.assets) { const s1 = stepEl("Writing llms.txt and company schema for your site");
      let raw = ""; try { await stream("/api/write", { kind: "assets", data: { profile, pages: (M.audit.pages || []).slice(0, 10) } }, { delta: (d) => { raw += d.text; } }, sig); M.assets = parseLoose(raw); bump("d"); s1.done("llms.txt and company schema written"); } catch { s1.done("Couldn't write the site files", false); } }
      phase("draft", 30);
      const gaps = pitchTargets(M).slice(0, 3).filter((t) => !M.pitches[t.url]);
      for (const [i, t] of gaps.entries()) {
        if (sig.aborted) break;
        const card = add(`<div class="hd"><span class="chip rv">pitch</span><span>${esc(t.domain)}</span><span class="sp"></span><span class="mono" style="font-size:.7rem">cited ${t.n}×</span></div><div class="pre typing"></div>`, "card hot");
        let txt = ""; const paintD = throttled(() => { card.querySelector(".pre").textContent = txt; scrollFeed(); }); await stream("/api/write", { kind: "pitch", data: { profile, t: { url: t.final || t.url, title: t.title, author: t.contacts?.author, rivals: t.rivals, questions: t.qs.map((q) => qText(M, q)), excerpt: t.excerpt } } }, { delta: (d) => { txt += d.text; paintD(); } }, sig).catch(() => {});
        card.querySelector(".pre").textContent = txt; if (txt) M.pitches[t.url] = txt; card.querySelector(".pre").classList.remove("typing"); card.classList.remove("hot"); bump("d"); phase("draft", 30 + (i + 1) * 20); save();
      }
      if (!sig.aborted) M.done.draft = true; save();
      finishPhase("draft");
    }
    if (sig.aborted) throw new DOMException("stopped", "AbortError");

    // ---------- done
    lockRelease(M.slug);
    M.finishedAt = Date.now(); save(true);
    const mins = estimateMinutes(M);
    APP.running = false;
    $("#liveTag").className = "live off"; $("#liveTag").innerHTML = "<i></i>Done"; $("#hudPhase").textContent = `Finished · about ${(mins / 60).toFixed(1)} hours of work`;
    $("#stopBtn").hidden = true; $("#toReport").hidden = false;
    const fin = add(`<div class="hd"><span class="chip ok">Mission complete</span></div><div class="q">${C.a} answers read, ${C.p} pages opened, ${C.d} drafts written. That's about ${(mins / 60).toFixed(1)} hours of manual work.</div><div><button class="btn" type="button" id="goResults">See your results →</button></div>`, "card hot");
    fin.querySelector("#goResults").onclick = showReady;
    // Like Peec's reveal: if you're watching the end of the feed, move on to the first results by itself.
    setTimeout(() => { if (!$("#mission").hidden && APP.M === M && stick && !document.hidden) showReady(); }, 2600);
}

$("#stopBtn").addEventListener("click", () => APP.ctl?.abort());
$("#toReport").addEventListener("click", showReport);
$$(".mobile-tabs button").forEach((b) => b.addEventListener("click", () => { $("#stage").dataset.view = b.dataset.view; $$(".mobile-tabs button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); if (b.dataset.view === "map") G.sim?.alpha(0.5).restart(); }));

function parseLoose(t) {
  try { return JSON.parse(t); } catch {}
  const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) { try { return JSON.parse(f[1]); } catch {} }
  const i = t.search(/[[{]/), j = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  return JSON.parse(t.slice(i, j + 1));
}
function liveScore(M) { const done = Object.values(M.answers).filter((a) => a.status === "yes" || a.status === "no"); return done.length ? Math.round((100 * done.filter((a) => a.named).length) / done.length) : null; }
function estimateMinutes(M) { return Object.keys(M.answers).length * 4 + Object.keys(M.inspections).length * 3 + Object.keys(M.pitches).length * 20 + (M.assets ? 30 : 0) + (M.insights ? 60 : 0) + (M.perception ? 20 : 0) + (M.audit?.pages?.length || 0) * 8; }
function pitchTargets(M) {
  return Object.values(M.inspections).filter((p) => p.ok && !p.you && !namesFor(M).rivals.some((r) => norm(p.domain).includes(norm(r).split(" ")[0])))
    .map((p) => ({ ...p, prio: p.n * 2 + (p.rivals || []).length * 3 + (p.listy ? 2 : 0) })).sort((a, b) => b.prio - a.prio);
}
function digest(M) {
  const ans = Object.values(M.answers).filter((a) => a.status === "yes" || a.status === "no");
  const L = [];
  for (const e of M.engines) { const x = ans.filter((a) => a.engine === e); if (x.length) L.push(`${ENG[e]}: named in ${x.filter((a) => a.named).length}/${x.length}`); }
  for (const q of M.questions) { const x = ans.filter((a) => a.qid === q.id); L.push(`- "${q.text}" [${q.intent}]: ${x.map((a) => `${ENG[a.engine]} ${a.named ? "NAMED" + (a.rank ? " #" + a.rank : "") : "missing"} (named: ${(a.brands || []).slice(0, 5).join(", ")})`).join("; ")}`); }
  const rc = {}; ans.forEach((a) => (a.brands || []).forEach((b) => { if (!isYou(b, M)) rc[b] = (rc[b] || 0) + 1; }));
  L.push("Rival mentions: " + Object.entries(rc).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, c]) => `${n} ${c}`).join(", "));
  const ins = Object.values(M.inspections).filter((p) => p.ok);
  L.push(`Cited pages opened: ${ins.length}. You are on ${ins.filter((p) => p.you).length}.`);
  ins.slice(0, 18).forEach((p) => L.push(`  page ${p.domain} "${p.title}" cited ${p.n}x: you ${p.you ? "present" : "absent"}; rivals: ${(p.rivals || []).join(", ") || "none"}`));
  const a = M.audit || {}; L.push(`Site: avg AI-readiness ${a.avg}/100; blocked bots: ${Object.entries(a.bots || {}).filter(([, v]) => !v).map(([k]) => k).join(", ") || "none"}; llms.txt ${a.llms ? "yes" : "no"}; org schema ${a.orgSchema ? "yes" : "no"}; FAQ schema ${a.faqSchema ? "yes" : "no"}`);
  if (M.perception) L.push("How AI describes them: " + M.perception.summary);
  return L.join("\n").slice(0, 12000);
}

/* =================================================================== REPORT */
$("#viewLog").addEventListener("click", () => {
  screen("mission");
  if (!$("#feed").children.length && APP.M) { setupHud(); gInit(); rebuildMap(APP.M); renderMatrix($("#matrix"), APP.M); thought("This run was loaded from your saved companies. The live log isn't stored, but the map and answers are. Click any node or cell."); $("#toReport").hidden = false; $("#stopBtn").hidden = true; $("#liveTag").className = "live off"; $("#liveTag").innerHTML = "<i></i>Saved"; $("#hudBrand").textContent = APP.M.profile.name; setRing(liveScore(APP.M)); }
});
function rebuildMap(M) {
  gNode("you", "you", M.profile.name);
  M.questions.forEach((q) => gNode("q:" + q.id, "question", q.text));
  Object.values(M.answers).forEach((a) => {
    (a.sources || []).forEach((s) => { const sid = sidOf(s.url); const n = gNode(sid, "source", host(s.url), { url: s.url }); n.weight = (n.weight || 0) + 1; gLink("q:" + a.qid, sid, "cited", "#3CC9B5"); });
    (a.brands || []).forEach((b) => { if (isYou(b, M)) return gLink("q:" + a.qid, "you", "named", "#FF7A1A"); const rn = gNode("r:" + norm(b), "rival", b); rn.weight = (rn.weight || 0) + 1; gLink("q:" + a.qid, "r:" + norm(b), "named", "#5A5A5E"); });
    if (a.named) { const qn = G.nodes.get("q:" + a.qid); if (qn) qn.named = true; }
  });
  Object.entries(M.inspections).forEach(([u, r]) => { const sid = sidOf(u); gNode(sid, "source", host(r.final || u), { url: u, inspected: true, you: !!r.you, rivals: (r.rivals || []).length }); if (r.you) gLink(sid, "you", "on", "#FF7A1A"); (r.rivals || []).forEach((rv) => gLink(sid, "r:" + norm(rv), "on", "#E2483D")); });
}
$("#rerun").addEventListener("click", async () => { const M = APP.M; if (!M) return; if (await lockedElsewhere(M.slug)) return toast("This brand is running in another tab right now."); startOnboarding(M.profile.site, store.get("companies", {})[M.slug] || { profile: M.profile, questions: M.questions.map((q) => ({ ...q, on: true })), engines: M.engines }); });
$("#newBrand").addEventListener("click", goHome);
function goHome() { APP.ctl?.abort(); APP.running = false; OB = null; document.body.classList.remove("sheet-open"); if (APP.M) lockRelease(APP.M.slug); toggleAgent(false); screen("landing"); $("#startUrl").value = ""; renderRecent(); }

/* ---------- action deck ---------- */
let DECK = [], DI = 0;
function buildDeck() {
  const M = APP.M, a = M.audit || {}, as = M.assets || {}, out = [];
  const blocked = Object.entries(a.bots || {}).filter(([, v]) => !v).map(([k]) => k);
  if (blocked.length) out.push({ id: "robots", kind: "2-minute fix", title: "Let AI crawlers read your site", why: `${blocked.join(", ")} ${blocked.length > 1 ? "are" : "is"} blocked in robots.txt, so ${blocked.length > 1 ? "those assistants" : "that assistant"} can't cite you.`, code: blocked.map((b) => `User-agent: ${b}\nAllow: /`).join("\n\n"), label: "Add to robots.txt" });
  if (!a.llms && as.llms_txt) out.push({ id: "llms", kind: "5-minute fix", title: "Publish llms.txt", why: "A plain-language briefing AI tools read to understand your company. You don't have one yet.", code: as.llms_txt, label: "Save as /llms.txt at your site root" });
  if (!a.orgSchema && as.org_schema) out.push({ id: "org", kind: "5-minute fix", title: "Tell AI exactly who you are", why: "Your homepage has no Organization schema, so AI has to guess your name, URL and description.", code: '<script type="application/ld+json">\n' + JSON.stringify(as.org_schema, null, 2) + "\n</" + "script>", label: "Paste into your homepage <head>" });
  (M.perception?.claims || []).filter((c) => ["wrong", "outdated"].includes(c.verdict)).forEach((c, i) => out.push({ id: "claim" + i, kind: "Correct AI", title: `AI says: “${c.claim}”`, why: c.fix || "Publish a clear correction on your site." }));
  pitchTargets(M).slice(0, 8).forEach((t) => out.push({ id: "pitch:" + t.url, kind: "Get listed", title: `Get named on ${t.domain}`, why: `AI cited this page ${t.n}×${(t.rivals || []).length ? `. ${t.rivals.slice(0, 3).join(", ")} ${t.rivals.length > 1 ? "are" : "is"} already on it` : ""}.`, t }));
  const missing = M.questions.filter((q) => M.engines.every((e) => !M.answers[q.id + "|" + e]?.named));
  missing.slice(0, 2).forEach((q) => out.push({ id: "article:" + q.id, kind: "Publish a page", title: `Win “${q.text}”`, why: "No engine named you for this. A page built to answer it gives AI something to cite.", q }));
  const weak = (a.pages || [])[0]; if (weak && weak.score < 60) out.push({ id: "fix:" + weak.url, kind: "Improve a page", title: `Make “${weak.title || host(weak.url)}” quotable`, why: `Scores ${weak.score}/100. Missing: ${(weak.fails || []).slice(0, 3).join(", ")}.`, page: weak });
  DECK = out.filter((x) => !M.deck[x.id]); DI = 0; drawDeck();
}
function drawDeck() {
  const M = APP.M, total = DECK.length, el = $("#deck");
  const doneN = Object.keys(M.deck).length;
  if ($("#navActions")) $("#navActions").textContent = total || "";
  if (!el) return;
  $("#deckCount").innerHTML = `<span>${doneN} done</span><span class="bar" style="width:90px"><i style="width:${(100 * doneN) / Math.max(1, doneN + total)}%"></i></span><span>${total} left</span>`;
  if (!total) { el.innerHTML = `<div class="dcard"><span class="kind">All clear</span><h4>Nothing left in the deck.</h4><p class="why">Run again next week to see what moved. Mentions on third-party pages usually take 2–6 weeks to show up in AI answers.</p></div>`; return; }
  const c = DECK[0]; let body = "", acts = "";
  if (c.code) { body = `<span class="muted" style="font-size:.78rem">${esc(c.label)}</span><div class="pre code">${esc(c.code)}</div>`; acts = `<button class="btn" type="button" data-act="copy">Copy code</button>`; }
  else if (c.t) {
    const txt = M.pitches[c.t.url]; const to = c.t.contacts?.emails?.[0];
    body = `${contactHtml(c.t.contacts)}<div class="pre ${txt ? "" : "muted"}" id="dkText">${txt ? esc(txt) : "No pitch yet. I'll write one for this exact page."}</div>`;
    acts = txt ? (to ? `<a class="btn" target="_blank" rel="noopener" href="${esc(gmail(to, txt))}" data-act="sent">Send in Gmail</a>` : `<button class="btn" type="button" data-act="copy">Copy pitch</button>`) : `<button class="btn" type="button" data-act="write">Write the pitch</button>`;
    acts += `<a class="btn ghost sm" href="${esc(safeUrl(c.t.final || c.t.url) || "#")}" target="_blank" rel="noopener">Open page</a>`;
  } else if (c.q) { const txt = M.articles[c.q.id]; body = `<div class="pre" id="dkText">${txt ? esc(txt) : "I'll write a 1,000–1,400 word page built to be cited for this question. Proof points I can't verify are marked [TODO]."}</div>`; acts = txt ? `<button class="btn" type="button" data-act="copy">Copy article</button>` : `<button class="btn" type="button" data-act="write">Write the page</button>`; }
  else if (c.page) { const txt = M.fixpack; body = `<div class="pre md" id="dkText">${txt ? md(txt) : "I'll rewrite the opening, add question headings and an FAQ for this page."}</div>`; acts = txt ? `<button class="btn" type="button" data-act="copy">Copy fixes</button>` : `<button class="btn" type="button" data-act="write">Write the fixes</button>`; }
  el.innerHTML = `<div class="dcard" id="dk"><span class="kind">${esc(c.kind)} · ${Object.keys(M.deck).length + 1} of ${Object.keys(M.deck).length + DECK.length}</span><h4>${esc(c.title)}</h4><p class="why">${esc(c.why)}</p>${body}<div class="acts">${acts}<span style="flex:1"></span><button class="btn ghost sm" type="button" data-act="skip">Skip <span class="kbd">←</span></button><button class="btn ghost sm" type="button" data-act="done">Done <span class="kbd">→</span></button></div></div><div class="stack-under"></div>`;
}
const gmail = (to, txt) => { const m = txt.match(/^Subject:\s*(.+)\n+([\s\S]*)$/i); return `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(m ? m[1] : "")}&body=${encodeURIComponent(m ? m[2] : txt)}`; };
document.addEventListener("click", async (e) => {
  const b = e.target.closest("#deck [data-act]"); if (!b) return; const act = b.dataset.act, c = DECK[0], M = APP.M;
  if (act === "skip" || act === "done") return advance(act);
  if (act === "sent") { setTimeout(() => advance("done"), 500); return; }
  if (act === "copy") { const t = c.code || (c.t ? M.pitches[c.t.url] : c.q ? M.articles[c.q.id] : M.fixpack); try { await navigator.clipboard.writeText(t); b.textContent = "Copied ✓"; } catch { b.textContent = "Select the text to copy"; } return; }
  if (act === "write") {
    b.setAttribute("aria-disabled", "true"); b.innerHTML = `<svg class="pq think" viewBox="0 0 56 30" style="height:12px;width:22px"><rect x="0" width="16" height="30" rx="4.5" fill="currentColor" opacity=".55"/><rect x="20" width="16" height="30" rx="4.5" fill="#111114"/><rect x="40" width="16" height="30" rx="4.5" fill="currentColor" opacity=".55"/></svg> Writing`;
    const out = $("#dkText"); out.classList.remove("muted"); out.classList.add("typing"); let t = "";
    const req = c.t ? { kind: "pitch", data: { profile: M.profile, t: { url: c.t.final || c.t.url, title: c.t.title, author: c.t.contacts?.author, rivals: c.t.rivals, questions: (c.t.qs || []).map((q) => qText(M, q)), excerpt: c.t.excerpt } } }
      : c.q ? { kind: "article", data: { profile: M.profile, question: c.q.text, rivals: [...new Set(M.engines.flatMap((e) => M.answers[c.q.id + "|" + e]?.brands || []))].filter((x) => !isYou(x, M)), siteText: M.siteText } }
      : { kind: "fixpack", data: { profile: M.profile, page: c.page, text: M.siteText } };
    const paintK = throttled(() => { if (c.page) out.innerHTML = md(t); else out.textContent = t; out.scrollTop = out.scrollHeight; });
    try { await stream("/api/write", req, { delta: (d) => { t += d.text; paintK(); } }); }
    catch (err) { t = t || ""; toast(esc(err.message)); }
    if (c.t) M.pitches[c.t.url] = t; else if (c.q) M.articles[c.q.id] = t; else M.fixpack = t;
    save(); drawDeck();
  }
});
function advance(how) {
  const c = DECK[0]; if (!c) return; APP.M.deck[c.id] = how; save();
  const el = $("#dk"); el?.classList.add(how === "skip" ? "out-l" : "out-r");
  setTimeout(() => { DECK.shift(); if (DASH.page === "actions") dashRender(); else drawDeck(); }, 260);
}
addEventListener("keydown", (e) => {
  if ($("#reportWrap").hidden || $(".modal")) return;
  if (/input|textarea/i.test(document.activeElement?.tagName)) return;
  if (e.key === "/") { e.preventDefault(); toggleAgent(true); return; }
  if (DASH.page !== "actions") return;
  if (e.key === "ArrowRight") advance("done");
  if (e.key === "ArrowLeft") advance("skip");
});

/* ---------- ask the agent ---------- */
function renderSugs() {
  const M = APP.M; const ans = Object.values(M.answers); const rc = {}; ans.forEach((a) => (a.brands || []).forEach((b) => { if (!isYou(b, M)) rc[b] = (rc[b] || 0) + 1; }));
  const top = Object.entries(rc).sort((a, b) => b[1] - a[1])[0];
  const s = ["What should I do first this week?", top ? `Why does ${top[0]} beat us?` : "Which questions am I missing?", "Write a LinkedIn post about what we found", "Summarise this for my boss in 5 bullets", "Which page should I pitch first and why?"];
  $("#sugs").innerHTML = s.map((x) => `<button type="button">${esc(x)}</button>`).join("");
}
$("#sugs").addEventListener("click", (e) => { if (e.target.tagName === "BUTTON") ask(e.target.textContent); });
$("#askForm").addEventListener("submit", (e) => { e.preventDefault(); const q = $("#askIn").value.trim(); if (q) { $("#askIn").value = ""; ask(q); } });
function renderChat() { const M = APP.M; $("#chat").innerHTML = (M.chat || []).map((m) => `<div class="msg ${m.role}">${m.role === "me" ? esc(m.text) : `<div class="md">${md(m.text)}</div>`}</div>`).join(""); }
async function ask(q) {
  const M = APP.M; M.chat = M.chat || []; const hist = M.chat.slice(-8);
  M.chat.push({ role: "me", text: q }); renderChat();
  const el = document.createElement("div"); el.className = "msg ai"; el.innerHTML = `<div class="md typing"></div>`; $("#chat").append(el); el.scrollIntoView({ behavior: "smooth", block: "end" });
  let t = ""; const paintC = throttled(() => { el.firstChild.innerHTML = md(t); el.scrollIntoView({ block: "end" }); });
  try { await stream("/api/write", { kind: "chat", data: { context: digest(M) + (M.insights ? "\n\nINSIGHTS\n" + M.insights : ""), history: hist, question: q } }, { delta: (d) => { t += d.text; paintC(); } }); }
  catch (err) { t = t || "⚠️ " + err.message; }
  M.chat.push({ role: "ai", text: t }); save(); renderChat(); $("#chat").lastElementChild?.scrollIntoView({ behavior: "smooth", block: "end" });
}

/* =================================================================== SCREENS */
const SCREENS = ["landing", "mission", "onboard", "ready", "reportWrap"];
function screen(id) {
  SCREENS.forEach((s) => ($("#" + s).hidden = s !== id));
  document.body.classList.toggle("is-light", ["onboard", "ready", "reportWrap"].includes(id));
  $$(".modal,.drawer").forEach((x) => x.remove());
  scrollTo({ top: 0 });
}
const ICONS = {
  overview: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>',
  doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5c1 1.2 2.1 1.8 3.5 1.8s2.5-.6 3.5-1.8M9 9.5h.01M15 9.5h.01"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  gap: '<path d="M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3"/><path d="M9 12h6"/>',
  bolt: '<path d="M13 3L5 13h6l-1 8 8-10h-6z"/>',
  rank: '<path d="M5 20V11M12 20V5M19 20v-6"/>',
  chat: '<path d="M5 18l-1 3 4-2c1.2.5 2.6.8 4 .8 4.7 0 8-3.1 8-7.3S16.7 5.2 12 5.2 4 8.3 4 12.5c0 2.1.8 4 2 5.5z"/>',
  play: '<circle cx="12" cy="12" r="9"/><path d="M10 9l5 3-5 3z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  side: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  down: '<path d="M7 10l5 5 5-5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18"/>',
  research: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  compare: '<path d="M8 4v16M16 4v16M4 8h8M12 16h8"/>',
  action: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
};
const icon = (k, s = 16) => `<svg class="ic" viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k] || ""}</svg>`;
function paintIcons(root = document) { $$("i[data-ic]", root).forEach((el) => { el.outerHTML = icon(el.dataset.ic); }); }

// Brand avatars: real favicons for domains, a tinted letter for brand names.
const hue = (s) => [...norm(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const letterAv = (name, cls = "") => `<span class="av ${cls}" style="--h:${hue(name)}">${esc((String(name || "?").trim()[0] || "?").toUpperCase())}</span>`;
const favImg = (d) => `<img class="fav" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=64" alt="" loading="lazy" data-l="${esc((d[0] || "•").toUpperCase())}">`;
document.addEventListener("error", (e) => { const t = e.target; if (t?.matches?.("img.fav")) { const s = document.createElement("span"); s.className = "fav l"; s.textContent = t.dataset.l || "•"; t.replaceWith(s); } }, true);

/* =================================================================== ONBOARDING
   Modelled on Peec AI's setup flow: one question at a time under a ghosted preview of the app that fills in as you
   answer, with the detailed reviews (brand profile, prompt focus, prompt set) in full-height sheets.
   scan → brand profile → market → competitors → topics → focus → prompts → review → run. */
const INTENTS = { informational: ["Informational", "var(--i-info)"], commercial: ["Commercial", "var(--i-comm)"], transactional: ["Transactional", "var(--i-trans)"] };
const FOCUS = { research: ["Research", "More emphasis on exploring problems and solutions.", [50, 30, 20]], compare: ["Compare options", "More emphasis on comparisons and recommendations.", [25, 50, 25]], action: ["Take action", "More emphasis on buying, booking, or signing up.", [25, 25, 50]] };
const ENG_KEY = { chatgpt: "OPENAI_API_KEY", perplexity: "PERPLEXITY_API_KEY", gemini: "GEMINI_API_KEY", groq: "GROQ_API_KEY" };
const ENG_ALL = ["chatgpt", "perplexity", "gemini", "groq"];
const MARKETS = ["Global", "United States", "United Kingdom", "India", "Europe", "Australia"];
const OB_BACK = { scan: "home", profile: "home", market: "profile", rivals: "market", topicsGen: "rivals", topics: "rivals", focus: "topics", promptsGen: "focus", promptsReady: "focus", review: "promptsReady" };
let OB = null;
const splitList = (s) => String(s || "").split(/,|;|\/|\band\b/).map((x) => x.trim()).filter((x) => x.length > 1).slice(0, 6);

async function startOnboarding(url, saved) {
  APP.ctl?.abort(); APP.ctl = new AbortController(); const sig = APP.ctl.signal; APP.running = false;
  OB = { url, saved, step: "scan", scan: null, checks: [], pages: [], profile: null, rivals: [], topics: [], focus: "action", perTopic: 3, questions: [], selTopic: null, engines: APP.cfg.engines.slice(), gen: false, err: "" };
  screen("onboard"); $("#obSite").textContent = host(url); obRender();
  try {
    let result = null;
    await stream("/api/site", { url }, {
      step: (d) => { OB.checks.push({ id: d.id, text: d.text, state: "run" }); obRender(); },
      done: (d) => { const c = OB.checks.find((x) => x.id === d.id); if (c) { c.state = d.ok === false ? "bad" : "ok"; c.text = d.text || c.text; } obRender(); },
      page: (p) => { OB.pages.push(p); },
      result: (r) => { result = r; },
    }, sig);
    if (!result) throw new Error("The site scan didn't finish.");
    OB.scan = result;
    const p = { ...result.profile, ...(saved?.profile || {}), site: result.profile.site };
    for (const k of ["identity", "products", "facts"]) p[k] = p[k]?.length ? p[k] : result.profile[k] || [];
    p.personas = p.personas?.length ? p.personas : result.profile.personas?.length ? result.profile.personas : splitList(p.audience);
    OB.profile = p;
    OB.rivals = (p.competitors || []).map((name) => ({ name }));
    if (saved?.questions?.length) {
      OB.questions = saved.questions.map((q) => ({ topic: q.topic || "General", intent: q.intent, persona: q.persona || "", text: q.text, on: q.on !== false }));
      OB.topics = (saved.topics?.length ? saved.topics : [...new Set(OB.questions.map((q) => q.topic))]).map((t) => (typeof t === "string" ? { name: t } : t));
      OB.focus = saved.focus || OB.focus; OB.perTopic = saved.perTopic || OB.perTopic;
      const e = (saved.engines || []).filter((x) => APP.cfg.engines.includes(x)); if (e.length) OB.engines = e;
      OB.step = "promptsReady";
    } else { OB.step = "profile"; OB.sheet = "profile"; }
    obRender();
  } catch (err) { if (sig.aborted) return; OB.err = err.message; obRender(); }
}
function obProfile() {
  const p = OB.profile;
  return { ...p, name: (p.name || "").trim() || host(p.site), competitors: OB.rivals.map((r) => r.name), audience: (p.personas || []).join(", ") || p.audience || "" };
}
function obGo(step) {
  if (!OB) return;
  if (step === "home") { APP.ctl?.abort(); return goHome(); }
  if (step === "market" && !(OB.profile?.name || "").trim()) { toast("Add your company name first."); return $('[data-f="name"]')?.focus(); }
  OB.step = step; OB.sheet = step === "profile" ? "profile" : null; obRender();
  if (step === "topicsGen") obTopics(false);
  if (step === "promptsGen") obPrompts(false);
}
$("#obBack").addEventListener("click", () => obGo(OB ? OB_BACK[OB.step] || "home" : "home"));

/* ---- the ghosted app preview above each question */
const SKNAV = [["Home", ["Overview", "My website"]], ["Brand", ["Competitors", "Insights"]], ["Prompts", ["Topics", "All prompts"]], ["Sources", ["Gap analysis"]]];
function frame(nav, title, main) {
  const p = OB?.profile, d = host(OB?.url || "");
  const brand = `<div class="fr-brand">${p ? favImg(d) : '<span class="sk sq"></span>'}${p ? `<b>${esc(p.name)}</b>${icon("down", 13)}` : '<span class="sk" style="width:90px"></span>'}</div>`;
  const side = SKNAV.map(([g, items]) => nav ? `<div class="fr-g">${g}</div>${items.map((it) => `<div class="fr-i${it === nav ? " on" : ""}">${it}</div>`).join("")}`
    : `<div class="fr-g"><span class="sk" style="width:34px"></span></div>${items.map(() => `<div class="fr-i"><span class="sk sq sm"></span><span class="sk" style="width:${50 + Math.round(Math.random() * 30)}px"></span></div>`).join("")}`).join("");
  return `<div class="fr"><aside class="fr-side">${brand}<div class="fr-nav">${side}</div></aside><div class="fr-main"><div class="fr-top">${icon("side", 15)}${title ? `<b>${esc(title)}</b>` : '<span class="sk" style="width:80px"></span>'}<span class="sp"></span><span class="fr-ib">${icon("chat", 14)}</span><span class="fr-ib">${icon("info", 14)}</span></div>${main || skelChart()}</div></div>`;
}
function skelChart() {
  return `<div class="fr-pad"><div class="fr-chips">${[70, 52, 96, 84].map((w) => `<span class="fr-chip"><span class="sk sq sm"></span><span class="sk" style="width:${w}px"></span></span>`).join("")}</div>
  <span class="sk" style="width:62px;height:12px"></span><span class="sk" style="width:220px;margin-top:8px"></span>
  <div class="fr-card"><span class="sk" style="width:90px"></span><svg viewBox="0 0 600 150" preserveAspectRatio="none" class="fr-curve"><path d="M10 10 C 90 120, 160 150, 230 110 S 380 40, 470 40 S 560 70, 595 130" fill="none" stroke="currentColor" stroke-width="1.2"/></svg></div></div>`;
}
const skRows = (n, cols = [180, 70, 70, 90]) => Array.from({ length: n }, () => `<div class="fr-tr">${cols.map((w, i) => `<span class="sk" style="width:${i ? w : w - Math.round(Math.random() * 60)}px"></span>`).join("")}</div>`).join("");
function listCol(head, items, rm, addForm, addPh, loading) {
  return `<div class="fr-col"><div class="fr-colh">${head}</div>
    ${addForm ? `<form class="fr-add" data-form="${addForm}"><input id="obAdd-${addForm}" placeholder="${esc(addPh)}" aria-label="${esc(addPh)}" autocomplete="off"><button type="submit" aria-label="Add">${icon("plus", 14)}</button></form>` : ""}
    ${items.map((it, i) => `<div class="fr-row">${it}${rm ? `<button type="button" class="fr-x" data-${rm}="${i}" aria-label="Remove">${icon("trash", 14)}</button>` : ""}</div>`).join("")}
    ${loading ? Array.from({ length: 4 }, () => `<div class="fr-row"><span class="sk" style="width:${110 + Math.round(Math.random() * 70)}px"></span></div>`).join("") : ""}</div>`;
}
const intentTag = (i) => { const x = INTENTS[i]; return x ? `<span class="itag"><i style="background:${x[1]}"></i>${x[0]}</span>` : `<span class="itag">${esc(i || "–")}</span>`; };
function promptsTable(qs, opts = {}) {
  return `<div class="fr-table"><div class="fr-th">${opts.check ? `<input type="checkbox" data-pqall ${qs.length && qs.every((q) => q.on) ? "checked" : ""} aria-label="Select all">` : ""}<span>Prompt</span><span>Intent</span><span>Persona</span></div>
    ${qs.map((q) => `<div class="fr-tr${q.on === false ? " off" : ""}">${opts.check ? `<input type="checkbox" data-pq="${OB.questions.indexOf(q)}" ${q.on ? "checked" : ""} aria-label="Track this prompt">` : ""}<span class="t">${esc(q.text)}</span>${intentTag(q.intent)}<span>${q.persona ? `<span class="ptag">${esc(q.persona)}</span>` : "–"}</span></div>`).join("")}
    ${opts.loading ? skRows(3) : ""}</div>`;
}
function obFrame() {
  const s = OB.step;
  if (s === "scan" || s === "profile" || s === "market") return frame(null, "", "");
  if (s === "rivals") {
    const col = `<div class="fr-col"><div class="fr-colh">Competitors <span>${OB.rivals.length}</span></div>
      <form class="fr-add" data-form="rival"><input id="obAdd-rival" placeholder="Add competitor" aria-label="Add competitor" autocomplete="off"><button type="submit" aria-label="Add">${icon("plus", 14)}</button></form>
      <div class="fr-row">${letterAv(OB.profile.name, "you")}<span>${esc(OB.profile.name)}</span><span class="youtag">You</span></div>
      ${OB.rivals.map((r, i) => `<div class="fr-row">${letterAv(r.name)}<span>${esc(r.name)}</span><button type="button" class="fr-x" data-rvx="${i}" aria-label="Remove ${esc(r.name)}">${icon("trash", 14)}</button></div>`).join("")}</div>`;
    return frame("Competitors", "Competitors", `<div class="fr-split">${col}<div class="fr-col grow"><div class="fr-th"><span>Brand</span><span>Visibility</span><span>SoV</span><span>Position</span></div>${skRows(6, [150, 60, 60, 60])}</div></div>`);
  }
  if (s === "topicsGen" || s === "topics") return frame("Topics", "Topics", `<div class="fr-split">${listCol("Topics", OB.topics.map((t) => `<span>${esc(t.name)}</span>`), "tpx", s === "topics" ? "topic" : "", "Add topics", OB.gen)}<div class="fr-col grow"><div class="fr-th"><span>Prompt</span><span>Intent</span><span>Persona</span></div>${skRows(5, [220, 80, 90])}</div></div>`);
  if (s === "focus" || s === "promptsGen" || s === "promptsReady" || s === "review") {
    const sel = OB.selTopic && OB.topics.some((t) => t.name === OB.selTopic) ? OB.selTopic : OB.topics[0]?.name;
    const cnt = (t) => OB.questions.filter((q) => q.topic === t).length;
    const col = `<div class="fr-col"><div class="fr-colh">Topics</div>${OB.topics.map((t) => `<button type="button" class="fr-row sel${t.name === sel ? " on" : ""}" data-seltopic="${esc(t.name)}"><span>${esc(t.name)}</span><span class="n">${cnt(t.name) || ""}</span></button>`).join("")}</div>`;
    const qs = OB.questions.filter((q) => q.topic === sel);
    return frame("All prompts", sel || "All prompts", `<div class="fr-split">${col}<div class="fr-col grow">${s === "focus" ? `<div class="fr-th"><span>Prompt</span><span>Intent</span><span>Persona</span></div>${skRows(6, [220, 80, 90])}` : promptsTable(qs, { loading: OB.gen })}</div></div>`);
  }
  return frame(null, "", "");
}

/* ---- the question under the preview */
function pill(form, value, ph, ic, extra = "") {
  return `<form class="pill" data-form="${form}">${ic ? `<span class="pill-ic">${icon(ic, 17)}</span>` : ""}<input id="obPill" value="${esc(value || "")}" placeholder="${esc(ph)}" aria-label="${esc(ph)}" autocomplete="off">${extra}<button class="go" type="submit" aria-label="Continue">${icon("arrow", 16)}</button></form>`;
}
function obAsk() {
  const s = OB.step, p = OB.profile;
  if (s === "scan") {
    if (OB.err) return `<h1>We couldn't read ${esc(host(OB.url))}</h1><p>${esc(OB.err)}</p><div class="ob-btns"><button class="btn ghost" type="button" data-act="home">Use another site</button><button class="btn" type="button" data-act="retry">Try again</button></div>`;
    const done = OB.checks.filter((c) => c.state !== "run").length, cur = [...OB.checks].reverse().find((c) => c.state === "run") || OB.checks[OB.checks.length - 1];
    return `<h1>Reading ${esc(host(OB.url))}<span class="dots"></span></h1><p>${esc(cur?.text || "Connecting to your site")}</p><div class="ob-prog"><i style="width:${Math.min(96, 6 + done * 15)}%"></i></div>`;
  }
  if (s === "profile") return `<h1>Review your brand profile</h1><p>We pulled this from ${esc(host(p.site))}.</p><div class="ob-btns"><button class="btn" type="button" data-act="openProfile">Open profile</button></div>`;
  if (s === "market") return `<h1>Where do you sell?</h1><p>The market AI should answer for. We write prompts the way buyers there ask them.</p>${pill("market", p.market, "Search countries or regions", "globe")}<div class="ob-sugs">${[...new Set([p.market, ...MARKETS].filter(Boolean))].slice(0, 6).map((m) => `<button type="button" data-market="${esc(m)}"${norm(m) === norm(p.market) ? ' class="on"' : ""}>${esc(m)}</button>`).join("")}</div>`;
  if (s === "rivals") return `<h1>Review your competitors</h1><p>Remove any that aren't real rivals, or add your own. Suggested from your brand profile. <button type="button" class="lnk" data-act="openProfile">Edit profile</button></p><div class="ob-btns"><button class="btn ghost" type="button" data-act="focusAdd">Add competitor</button><button class="btn" type="button" data-go="topicsGen">Continue</button></div>`;
  if (s === "topicsGen") return `<h1>Generating topics<span class="dots"></span></h1><p>The themes your buyers research, from your products and services.</p>`;
  if (s === "topics") return `<h1>Review your topics</h1><p>Remove any that do not fit your brand, or add your own. Generated from your brand profile. <button type="button" class="lnk" data-act="openProfile">Edit profile</button></p><div class="ob-btns"><button class="btn ghost" type="button" data-act="focusAdd">Add topics</button><button class="btn" type="button" data-go="focus" ${OB.topics.length ? "" : 'aria-disabled="true"'}>Continue</button></div>`;
  if (s === "focus") return `<h1>What should your prompts focus on?</h1><p>Choose where your buyers are in their journey.</p><div class="ob-btns"><button class="btn" type="button" data-act="openFocus">Choose focus</button></div>`;
  if (s === "promptsGen") return `<h1>Writing your prompts<span class="dots"></span></h1><p>${OB.questions.length} of about ${OB.topics.length * OB.perTopic} written, as your buyers would ask them.</p><div class="ob-prog"><i style="width:${Math.min(96, (100 * OB.questions.length) / Math.max(1, OB.topics.length * OB.perTopic))}%"></i></div>`;
  if (s === "promptsReady" || s === "review") {
    const on = OB.questions.filter((q) => q.on).length;
    return `<h1>Your prompt set is ready</h1><p>${on} prompts across ${OB.topics.length} topics, generated from your brand profile. Your name is left out on purpose, so we see whether AI brings you up on its own.</p><div class="ob-btns"><button class="btn ghost" type="button" data-act="openReview">Review prompts</button><button class="btn" type="button" data-act="launch">Run analysis</button></div>`;
  }
  return "";
}

/* ---- sheets: the detailed reviews */
function chipEditor(key, items, ph) {
  return `<div class="chipin" data-chips="${key}">${(items || []).map((x, i) => `<span class="tag">${esc(x)}<button type="button" data-rm="${key}:${i}" aria-label="Remove ${esc(x)}">${icon("x", 11)}</button></span>`).join("")}<input data-add="${key}" id="chip-${key}" placeholder="${esc(ph)}" aria-label="${esc(ph)}"></div>`;
}
const fld = (label, hint, el, id) => `<div class="field"><label${id ? ` for="${id}"` : ""}>${label} <span class="q" title="${esc(hint)}">${icon("info", 13)}</span></label><span class="hint">${hint}</span>${el}</div>`;
function sheetProfile() {
  const p = OB.profile, a = OB.scan.audit || {};
  return {
    body: `<button type="button" class="sheet-back" data-act="home">${icon("arrow", 14)}Back</button>
    <div class="sheet-narrow"><h2 id="obSheetTitle">Review your brand profile</h2><p class="sub">We pulled this info from ${esc(host(p.site))}. You can change it now or update it later.</p>
      ${fld("Company name", "Exactly as customers say it. This is the name we look for in AI answers.", `<input id="ob-name" data-f="name" value="${esc(p.name)}">`, "ob-name")}
      ${fld("Description", "What your brand does, in a sentence or two.", `<textarea id="ob-offer" data-f="offer" rows="3">${esc(p.offer)}</textarea>`, "ob-offer")}
      ${fld("Category", "The specific niche your brand competes in, not a broad industry.", `<input id="ob-category" data-f="category" value="${esc(p.category)}">`, "ob-category")}
      ${fld("Brand identity", "Adjectives that describe your brand.", chipEditor("identity", p.identity, "Add +"))}
      ${fld("Products and services", "What your brand offers.", chipEditor("products", p.products, "Add +"))}
      ${fld("Personas", "Who your brand is for.", chipEditor("personas", p.personas, "Add +"))}
      ${fld("Facts", "What AI should get right about you. We fact-check AI against these.", chipEditor("facts", p.facts, "Add +"))}
      <div class="sitecheck"><div><span class="k">AI-readiness</span><b>${a.avg ?? "–"}<small>/100</small></b></div>${Object.entries(a.bots || {}).map(([b, ok]) => `<div><span class="k">${esc(b)}</span><span class="pillx ${ok ? "ok" : "no"}">${ok ? "Allowed" : "Blocked"}</span></div>`).join("")}<div><span class="k">llms.txt</span><span class="pillx ${a.llms ? "ok" : "no"}">${a.llms ? "Found" : "Missing"}</span></div></div>
    </div>`,
    foot: `<span class="sp"></span><button class="btn" type="button" data-act="profileOk">Looks good</button>`,
  };
}
function dbar(parts) { return `<div class="dbar">${parts.map(([v, c]) => `<i style="flex:${Math.max(0.0001, v)};background:${c}"></i>`).join("")}</div>`; }
function sheetFocus() {
  const d = FOCUS[OB.focus][2], n = OB.topics.length * OB.perTopic;
  return {
    body: `<button type="button" class="sheet-back" data-act="closeSheet">${icon("arrow", 14)}Back</button>
    <div class="sheet-narrow"><h2 id="obSheetTitle">What should your prompts focus on?</h2><p class="sub">We'll include a mix of questions, with more emphasis on your selection.</p>
    <div class="focus3">${Object.entries(FOCUS).map(([k, [t, sub]]) => `<button type="button" class="fcard${OB.focus === k ? " on" : ""}" data-focus="${k}"><b>${icon(k, 15)}${t}</b><span>${sub}</span></button>`).join("")}</div>
    <div class="fsec"><b>Non-branded vs branded</b><span>How many prompts name your brand</span></div>
    ${dbar([[100, "var(--line2)"], [0, "var(--i-trans)"]])}
    <div class="dleg"><span><i style="background:var(--line2)"></i>Non-branded <b>100%</b></span><span><i style="background:var(--i-trans)"></i>Branded <b>0%</b></span><span class="muted">Your name is left out, so a mention is earned.</span></div>
    <div class="fsec"><b>Intent distribution</b><span>Where buyers are in their journey</span></div>
    ${dbar([[d[0], "var(--i-info)"], [d[1], "var(--i-comm)"], [d[2], "var(--i-trans)"]])}
    <div class="dleg"><span><i style="background:var(--i-info)"></i>Informational <b>${d[0]}%</b></span><span><i style="background:var(--i-comm)"></i>Commercial <b>${d[1]}%</b></span><span><i style="background:var(--i-trans)"></i>Transactional <b>${d[2]}%</b></span></div>
    <div class="fsec"><b>Prompts per topic</b><span>${OB.topics.length} topics</span></div>
    <div class="seg">${[2, 3, 4, 5].map((k) => `<button type="button" data-per="${k}" aria-pressed="${OB.perTopic === k}">${k}</button>`).join("")}</div>
    <div class="fsec"><b>AI engines</b><span>Where the prompts run, live with web search</span></div>
    <div class="engs">${ENG_ALL.map((e) => { const av = APP.cfg.engines.includes(e), on = OB.engines.includes(e); return `<label class="engc${av ? "" : " na"}${on ? " on" : ""}"><input type="checkbox" data-eng="${e}" ${on ? "checked" : ""} ${av ? "" : "disabled"}><span class="edot" style="background:${ENGC[e]}"></span><b>${ENG[e]}</b>${av ? "" : `<span class="muted">Add ${ENG_KEY[e]}</span>`}</label>`; }).join("")}</div>
    </div>`,
    foot: `<span class="muted">About ${n} prompts × ${OB.engines.length} engine${OB.engines.length === 1 ? "" : "s"}</span><span class="sp"></span><button class="btn" type="button" data-act="genPrompts" ${n && OB.engines.length ? "" : 'aria-disabled="true"'}>Generate prompts</button>`,
  };
}
function sheetReview() {
  const qs = OB.questions, on = qs.filter((q) => q.on), sel = OB.reviewTopic || "";
  const shown = sel ? qs.filter((q) => q.topic === sel) : qs;
  const pers = [...new Set([...(OB.profile.personas || []), ...qs.map((q) => q.persona).filter(Boolean)])];
  const ic = Object.keys(INTENTS).map((k) => on.filter((q) => q.intent === k).length);
  const tot = Math.max(1, ic.reduce((a, b) => a + b, 0));
  const jobs = on.length * OB.engines.length;
  return {
    body: `<h2 id="obSheetTitle">Review your prompt set</h2><p class="sub">Review the prompts generated for your topics. Uncheck any that should not run.</p>
    <div class="rv-grid">
      <div class="rv-card rv-topics"><div class="rv-h">Topics</div>
        <button type="button" class="rv-t${sel ? "" : " on"}" data-rvtopic=""><span>All topics</span><span class="n">${qs.length}</span></button>
        ${OB.topics.map((t) => { const tq = qs.filter((q) => q.topic === t.name); return `<div class="rv-t${sel === t.name ? " on" : ""}"><input type="checkbox" data-tpon="${esc(t.name)}" ${tq.length && tq.every((q) => q.on) ? "checked" : ""} aria-label="Track all prompts in ${esc(t.name)}"><button type="button" data-rvtopic="${esc(t.name)}">${esc(t.name)}</button><span class="n">${tq.length}</span></div>`; }).join("")}
      </div>
      <div class="rv-card rv-main">${promptsTable(shown, { check: true })}
        <form class="rv-add" data-form="prompt">${icon("plus", 14)}<input placeholder="Add your own prompt${sel ? ` to ${esc(sel)}` : ""}" aria-label="Add your own prompt" autocomplete="off"><button class="btn ghost sm" type="submit">Add</button></form></div>
      <div class="rv-card rv-cov"><div class="rv-h">Coverage</div>
        <div class="cov-sec"><b>Personas</b><span class="muted">${pers.filter((x) => on.some((q) => q.persona === x)).length} of ${pers.length} covered</span></div>
        ${pers.map((x) => { const n = on.filter((q) => q.persona === x).length; return `<div class="cov-row"><span>${esc(x)}</span><span class="cov-n${n ? "" : " zero"}">${n}</span></div>`; }).join("")}
        <div class="cov-sec"><b>Intent distribution</b></div>
        ${dbar(Object.values(INTENTS).map((x, i) => [ic[i], x[1]]))}
        ${Object.values(INTENTS).map((x, i) => `<div class="cov-row"><span><i class="dotc" style="background:${x[1]}"></i>${x[0]}</span><b>${Math.round((100 * ic[i]) / tot)}%</b></div>`).join("")}
        <div class="cov-sec"><b>Engines</b></div>
        ${OB.engines.map((e) => `<div class="cov-row"><span><i class="dotc" style="background:${ENGC[e]}"></i>${ENG[e]}</span><b>${on.length}</b></div>`).join("")}
      </div>
    </div>`,
    foot: `<span class="muted">Tracking <b>${on.length} prompts</b> · ${jobs} live AI answers per run</span><span class="sp"></span><button class="btn ghost" type="button" data-act="closeSheet">Cancel</button><button class="btn" type="button" data-act="launch" ${jobs ? "" : 'aria-disabled="true"'}>Run analysis</button>`,
  };
}

function obRender() {
  if (!OB || $("#onboard").hidden) return;
  const keep = document.activeElement?.id, caret = document.activeElement?.selectionStart;
  $("#obFrame").innerHTML = obFrame();
  $("#obAsk").innerHTML = obAsk();
  const sheet = OB.sheet === "profile" ? sheetProfile() : OB.sheet === "focus" ? sheetFocus() : OB.sheet === "review" ? sheetReview() : null;
  const wasOpen = !$("#obSheet").hidden;
  $("#obSheet").hidden = !sheet;
  document.body.classList.toggle("sheet-open", !!sheet);
  if (sheet) { const sc = $("#obSheetBody").scrollTop; $("#obSheetBody").innerHTML = sheet.body; $("#obSheetFoot").innerHTML = sheet.foot; if (wasOpen) $("#obSheetBody").scrollTop = sc; }
  if (keep) { const el = document.getElementById(keep); if (el) { el.focus(); try { if (caret != null) el.setSelectionRange(caret, caret); } catch {} } }
}
function obSheet(name) { OB.sheet = name; obRender(); $("#obSheetBody").scrollTop = 0; }

/* ---- generation */
async function obTopics(more) {
  if (OB.gen) return; OB.gen = true; if (!more) OB.topics = []; obRender();
  let buf = "";
  const take = (l) => { const t = l.replace(/^[\s\-*•\d.)]+/, "").replace(/["“”*]/g, "").trim(); if (!t || t.length > 60 || OB.topics.some((x) => norm(x.name) === norm(t))) return; OB.topics.push({ name: t }); obRender(); };
  try { await stream("/api/write", { kind: "topics", data: { profile: obProfile(), exclude: more ? OB.topics.map((t) => t.name) : [] } }, { delta: (d) => { buf += d.text; const ls = buf.split("\n"); buf = ls.pop(); ls.forEach(take); }, final: () => { if (buf.trim()) take(buf); } }, APP.ctl.signal); }
  catch (e) { if (APP.ctl.signal.aborted) return; toast(esc(e.message)); }
  OB.gen = false;
  if (!OB.topics.length) { const p = OB.profile; (p.products?.length ? p.products.slice(0, 5) : [p.category || "Your category"]).forEach((name) => OB.topics.push({ name })); }
  if (OB.step === "topicsGen" || OB.step === "topics") { OB.step = "topics"; obRender(); }
}
async function obPrompts(more) {
  if (OB.gen) return; OB.gen = true; if (!more) OB.questions = []; OB.selTopic = null; obRender();
  const topics = OB.topics.map((t) => t.name), exclude = OB.questions.map((q) => q.text); let buf = "";
  const pick = (t) => topics.find((x) => norm(x) === norm(t)) || topics.find((x) => norm(t).includes(norm(x)) || norm(x).includes(norm(t))) || topics[0];
  const take = (line) => {
    const m = line.split("|").map((x) => x.trim()); if (m.length < 2) return;
    let q;
    if (m.length >= 4) q = { topic: pick(m[0]), intent: m[1].toLowerCase().replace(/[^a-z]/g, ""), persona: m[2], text: m.slice(3).join(" | ") };
    else q = { topic: m.length === 3 ? pick(m[0]) : topics[0], intent: (m.length === 3 ? m[1] : m[0]).toLowerCase().replace(/[^a-z]/g, ""), persona: "", text: m[m.length - 1] };
    q.text = q.text.replace(/^["“]|["”]$/g, "").trim(); if (!INTENTS[q.intent]) q.intent = "commercial";
    if (!q.text || q.text.length < 8 || OB.questions.some((x) => norm(x.text) === norm(q.text))) return;
    q.on = true; OB.questions.push(q); if (!OB.selTopic) OB.selTopic = q.topic; obRender();
  };
  try { await stream("/api/write", { kind: "topicQuestions", data: { profile: obProfile(), topics, perTopic: OB.perTopic, focus: OB.focus, exclude } }, { delta: (d) => { buf += d.text; const ls = buf.split("\n"); buf = ls.pop(); ls.forEach(take); }, final: () => { if (buf.trim()) take(buf); } }, APP.ctl.signal); }
  catch (e) { if (APP.ctl.signal.aborted) return; toast(esc(e.message)); }
  OB.gen = false;
  if (!OB.questions.length) { OB.step = "focus"; obRender(); return toast("The AI didn't return any prompts. Try again in a minute."); }
  if (OB.step === "promptsGen") OB.step = "promptsReady";
  obRender();
}

/* ---- events (delegated; all state lives in OB, so re-rendering never loses typing) */
$("#onboard").addEventListener("input", (e) => { const f = e.target.dataset.f; if (f && OB?.profile) OB.profile[f] = e.target.value; });
$("#onboard").addEventListener("keydown", (e) => {
  if (e.key === "Escape" && OB?.sheet && OB.sheet !== "profile") { OB.sheet = null; return obRender(); }
  const k = e.target.dataset.add; if (!k) return;
  if (e.key === "Backspace" && !e.target.value && OB.profile[k]?.length) { OB.profile[k].pop(); return obRender(); }
  if (e.key !== "Enter" && e.key !== ",") return;
  e.preventDefault(); const v = e.target.value.trim(); if (!v) return;
  OB.profile[k] = [...(OB.profile[k] || []), v]; obRender();
});
$("#onboard").addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset.pq != null) { OB.questions[+t.dataset.pq].on = t.checked; obRender(); }
  if (t.dataset.pqall != null) { const sel = OB.reviewTopic; OB.questions.filter((q) => !sel || q.topic === sel).forEach((q) => (q.on = t.checked)); obRender(); }
  if (t.dataset.tpon != null) { OB.questions.filter((q) => q.topic === t.dataset.tpon).forEach((q) => (q.on = t.checked)); obRender(); }
  if (t.dataset.eng) { OB.engines = t.checked ? ENG_ALL.filter((x) => x === t.dataset.eng || OB.engines.includes(x)) : OB.engines.filter((x) => x !== t.dataset.eng); obRender(); }
});
$("#onboard").addEventListener("submit", (e) => {
  e.preventDefault(); const f = e.target.dataset.form, inp = e.target.querySelector("input"), v = inp.value.trim();
  if (f === "market") { if (!v) return inp.focus(); OB.profile.market = v; return obGo("rivals"); }
  if (!v) return inp.focus();
  if (f === "rival" && !OB.rivals.some((r) => norm(r.name) === norm(v))) OB.rivals.push({ name: v, added: true });
  if (f === "topic" && !OB.topics.some((t) => norm(t.name) === norm(v))) OB.topics.push({ name: v });
  if (f === "prompt" && !OB.questions.some((q) => norm(q.text) === norm(v))) OB.questions.push({ topic: OB.reviewTopic || OB.topics[0]?.name || "General", intent: "commercial", persona: "", text: v, on: true });
  inp.value = ""; obRender(); setTimeout(() => (document.getElementById(inp.id) || e.target.querySelector("input"))?.focus(), 0);
});
$("#onboard").addEventListener("click", (e) => {
  const b = e.target.closest("[data-go],[data-act],[data-rm],[data-rvx],[data-tpx],[data-market],[data-focus],[data-per],[data-seltopic],[data-rvtopic]");
  if (!b || b.getAttribute("aria-disabled") === "true") return;
  const d = b.dataset;
  if (d.rm) { const [k, i] = d.rm.split(":"); OB.profile[k].splice(+i, 1); return obRender(); }
  if (d.rvx != null) { OB.rivals.splice(+d.rvx, 1); return obRender(); }
  if (d.tpx != null) { const t = OB.topics.splice(+d.tpx, 1)[0]; OB.questions = OB.questions.filter((q) => q.topic !== t?.name); return obRender(); }
  if (d.market) { OB.profile.market = d.market; return obGo("rivals"); }
  if (d.focus) { OB.focus = d.focus; return obRender(); }
  if (d.per) { OB.perTopic = +d.per; return obRender(); }
  if (d.seltopic != null) { OB.selTopic = d.seltopic; return obRender(); }
  if (d.rvtopic != null) { OB.reviewTopic = d.rvtopic; return obRender(); }
  if (d.go) return obGo(d.go);
  const a = d.act;
  if (a === "retry") return startOnboarding(OB.url, OB.saved);
  if (a === "home") return obGo("home");
  if (a === "openProfile") return obSheet("profile");
  if (a === "profileOk") { if (!(OB.profile.name || "").trim()) { toast("Add your company name first."); return $("#ob-name")?.focus(); } OB.sheet = null; return obGo(OB.step === "profile" ? "market" : OB.step); }
  if (a === "focusAdd") { const i = $("#obFrame input"); i?.focus(); i?.scrollIntoView({ block: "nearest" }); return; }
  if (a === "openFocus") return obSheet("focus");
  if (a === "genPrompts") { OB.sheet = null; return obGo("promptsGen"); }
  if (a === "openReview") { OB.reviewTopic = ""; return obSheet("review"); }
  if (a === "closeSheet") { OB.sheet = null; return obRender(); }
  if (a === "launch") return obLaunch();
});

async function obLaunch() {
  const profile = obProfile(), qs = OB.questions.filter((q) => q.on), r = OB.scan;
  if (!qs.length) return toast("Pick at least one prompt.");
  if (!OB.engines.length) { obSheet("focus"); return toast("Pick at least one AI engine."); }
  const slug = slugify(profile.name);
  if (await lockedElsewhere(slug)) return toast("This brand is running in another tab right now.");
  OB.sheet = null; document.body.classList.remove("sheet-open");
  const cos = store.get("companies", {});
  cos[slug] = { slug, profile, audit: r.audit, siteText: r.siteText, topics: OB.topics.map((t) => t.name), focus: OB.focus, perTopic: OB.perTopic,
    questions: OB.questions.map(({ topic, intent, persona, text, on }) => ({ topic, intent, persona, text, on })), engines: OB.engines.slice(), savedAt: Date.now() };
  store.set("companies", cos);
  const prev = store.get("mission:" + slug, null); if (prev?.finishedAt) store.set("prev:" + slug, prev);
  APP.M = newMission(profile, r.audit, r.siteText); const M = APP.M;
  M.engines = ENG_ALL.filter((e) => OB.engines.includes(e) && APP.cfg.engines.includes(e));
  M.questions = qs.map((q, i) => ({ id: "q" + (i + 1), intent: q.intent, topic: q.topic, persona: q.persona, text: q.text }));
  M.done.questions = true; save(true);
  const sig = missionUI(profile.name);
  rebuildMap(M); bump("q", M.questions.length); finishPhase("site"); finishPhase("questions"); renderMatrix($("#matrix"), M);
  thought(`<b>Setup approved for ${esc(profile.name)}.</b> ${M.questions.length} prompts across ${OB.topics.length} topics, ${profile.competitors.length} competitors, ${M.engines.map((e) => ENG[e]).join(", ")}. Saved to your companies.`, "Everything below runs on the profile, rivals and prompts you just approved.");
  add(`<div class="hd"><span>Tracked prompts</span><span class="sp"></span><span class="mono" style="font-size:.7rem">${M.questions.length}</span></div><div class="ql">${M.questions.map((q) => `<div><span>${esc(q.intent)}</span>${esc(q.text)}</div>`).join("")}</div>`, "card");
  try { await runPipeline(M, sig); } catch (err) { missionError(err, sig); }
}

/* =================================================================== RESULTS DASHBOARD (Peec-style)
   Sidebar workspace, filter chips, KPI strip, visibility chart, brand ranking, sources by domain and type,
   chats with a details panel, gap analysis, and the action deck. All numbers come from this run's answers. */
const DASH = { page: "overview", eng: "all", chatFilter: "all", domFilter: "all" };
const PAGES = { overview: ["Home", "Overview"], site: ["Home", "My website"], insights: ["Brand", "Insights"], perception: ["Brand", "Perception"], prompts: ["Prompts", "All prompts"], domains: ["Sources", "Domains"], gap: ["Sources", "Gap analysis"], actions: ["Optimize", "Actions"], ranking: ["Results", "Ranking"], chats: ["Results", "Chats"] };
const BAR = ["#7AC231", "#9A1AF0", "#1F5FF5", "#1B35B0", "#14B8A6", "#E11D74", "#64748B", "#A16207"];
const TYPEC = { You: "var(--petal)", Competitor: "#E2483D", UGC: "#3B82F6", Reviews: "#8B5CF6", Reference: "#14B8A6", Other: "#9A9AA0" };
const pct = (v, d = 1) => (v == null ? "–" : (100 * v).toFixed(d).replace(/\.0$/, "") + "%");
const finished = (a) => a && (a.status === "yes" || a.status === "no");

function domainType(d, M) {
  const own = host(M.profile.site || "");
  if (own && (d === own || d.endsWith("." + own))) return "You";
  const base = d.split(".").slice(-2, -1)[0] || d;
  if ((M.profile.competitors || []).some((r) => { const k = norm(r).replace(/ /g, ""); return k.length >= 3 && (base.includes(k) || k.includes(base) && base.length >= 4); })) return "Competitor";
  if (/(^|\.)(reddit|youtube|quora|linkedin|medium|x|twitter|facebook|instagram|tiktok|stackoverflow|stackexchange|github|substack|producthunt|news\.ycombinator)\./.test(d + ".") || /ycombinator\.com$/.test(d)) return "UGC";
  if (/(^|\.)(g2|capterra|trustpilot|clutch|gartner|getapp|softwareadvice|yelp|tripadvisor|trustradius|goodfirms|sitejabber|glassdoor)\./.test(d + ".")) return "Reviews";
  if (/(wikipedia|britannica|wikidata)\.|\.gov$|\.gov\.|\.edu$|\.ac\./.test(d)) return "Reference";
  return "Other";
}

function metrics(M, eng = "all") {
  if (!M) return null;
  const A = Object.values(M.answers || {}).filter((a) => finished(a) && (eng === "all" || a.engine === eng));
  const B = new Map(), YOU = "\u0000you";
  const get = (name) => { const you = isYou(name, M), k = you ? YOU : norm(name); if (!k) return null; if (!B.has(k)) B.set(k, { name: you ? M.profile.name : String(name).trim(), you, mentions: 0, pos: [], tracked: false, qids: new Set() }); return B.get(k); };
  get(M.profile.name); (M.profile.competitors || []).forEach((n) => { const r = get(n); if (r && !r.you) r.tracked = true; });
  let total = 0;
  for (const a of A) {
    const seen = new Set();
    (a.brands || []).forEach((b, i) => { const r = get(b); if (!r) return; const k = r.you ? YOU : norm(b); if (seen.has(k)) return; seen.add(k); r.mentions++; r.pos.push(i + 1); r.qids.add(a.qid); total++; });
    if (a.named && !seen.has(YOU)) { const r = B.get(YOU); r.mentions++; if (a.rank) r.pos.push(a.rank); r.qids.add(a.qid); total++; }
  }
  const brands = [...B.values()].map((r) => ({ ...r, vis: A.length ? r.mentions / A.length : 0, sov: total ? r.mentions / total : 0, position: r.pos.length ? r.pos.reduce((s, x) => s + x, 0) / r.pos.length : null }))
    .filter((r) => r.mentions || r.you || r.tracked).sort((a, b) => b.vis - a.vis || (a.position ?? 99) - (b.position ?? 99) || (a.you ? 1 : 0) - (b.you ? 1 : 0));
  const you = brands.find((b) => b.you), rank = brands.indexOf(you) + 1;
  const byEngine = M.engines.map((e) => { const x = Object.values(M.answers || {}).filter((a) => a.engine === e && finished(a)); return { e, n: x.length, vis: x.length ? x.filter((a) => a.named).length / x.length : null }; }).filter((x) => x.n);
  const D = new Map();
  for (const a of A) { const seen = new Set(); for (const s of a.sources || []) { const d = host(s.url); if (!d) continue; const r = D.get(d) || { d, retr: 0, chats: 0, cited: 0, urls: new Set() }; r.retr++; r.urls.add(s.url); if (s.cited) r.cited++; if (!seen.has(d)) { r.chats++; seen.add(d); } D.set(d, r); } }
  const insp = Object.values(M.inspections || {});
  const domains = [...D.values()].map((r) => { const pages = insp.filter((p) => host(p.url) === r.d && p.ok); return { ...r, nUrls: r.urls.size, type: domainType(r.d, M), youOn: pages.length ? pages.some((p) => p.you) : null, rivalsOn: [...new Set(pages.flatMap((p) => p.rivals || []))] }; }).sort((a, b) => b.retr - a.retr);
  const types = {}; domains.forEach((d) => (types[d.type] = (types[d.type] || 0) + d.retr));
  const opened = insp.filter((p) => p.ok);
  return { A, n: A.length, brands, you, rank, total, byEngine, domains, types, totalRetr: domains.reduce((s, d) => s + d.retr, 0), onPages: opened.filter((p) => p.you).length, opened: opened.length, gaps: pitchTargets(M) };
}
function prevMetrics(M, eng) { const p = store.get("prev:" + M.slug, null); return p && p.answers ? { at: p.startedAt, m: metrics(p, eng) } : null; }
function delta(cur, prev, { inv = false, unit = "pts", scale = 100 } = {}) {
  if (cur == null || prev == null) return "";
  const d = (cur - prev) * scale; if (Math.abs(d) < 0.05) return `<span class="dl">±0</span>`;
  const good = inv ? d < 0 : d > 0;
  return `<span class="dl ${good ? "up" : "down"}">${d > 0 ? "+" : ""}${d.toFixed(1)}${unit === "pts" ? "%" : ""}</span>`;
}
const brandAv = (b, M) => (b.you ? favImg(host(M.profile.site)) : letterAv(b.name));

/* ---- building blocks shared by the dashboard and the "ready" preview */
function kpiHtml(M, m, pm) {
  const y = m.you || {}, py = pm?.m?.you;
  const eng = m.byEngine.filter((x) => x.vis != null).sort((a, b) => b.vis - a.vis);
  const cell = (label, tip, val, dl = "") => `<div class="kpi"><span class="kl">${label} <span title="${esc(tip)}">${icon("info", 12)}</span></span><span class="kv">${val}${dl}</span></div>`;
  return `<div class="kpis">
    ${cell("Visibility", "Share of AI answers that mention you.", pct(y.vis), delta(y.vis, py?.vis))}
    ${cell("Share of voice", "Your mentions as a share of all brand mentions.", pct(y.sov), delta(y.sov, py?.sov))}
    ${cell("Position", "Your average rank when AI mentions you. Lower is better.", y.position ? "#" + y.position.toFixed(1) : "–", delta(y.position, py?.position, { inv: true, unit: "", scale: 1 }))}
    ${cell("On cited pages", "Of the pages AI cited that we opened, how many mention you.", `${m.onPages}<small>/${m.opened}</small>`)}
    ${eng.length > 1 ? cell("Strongest engine", "Engine that mentions you most.", `<span class="kengine"><i style="background:${ENGC[eng[0].e]}"></i>${ENG[eng[0].e]}</span>`) + cell("Weakest engine", "Engine that mentions you least.", `<span class="kengine"><i style="background:${ENGC[eng[eng.length - 1].e]}"></i>${ENG[eng[eng.length - 1].e]}</span>`)
      : cell("Answers", "Live AI answers in this view.", m.n) + cell("Sources", "Distinct domains AI retrieved.", m.domains.length)}
  </div>`;
}
function visChartHtml(M, m) {
  const top = m.brands.slice(0, 5); if (m.you && !top.includes(m.you)) top.push(m.you);
  const max = Math.max(0.05, ...top.map((b) => b.vis)); const ceil = Math.min(1, Math.ceil((max * 100) / 5) * 5 / 100) || 0.05;
  const ticks = [1, 0.75, 0.5, 0.25, 0].map((t) => t * ceil);
  let ci = 0;
  return `<div class="card"><div class="card-h"><b>Visibility</b><span title="Share of AI answers that mention each brand.">${icon("info", 13)}</span></div>
    <div class="vchart"><div class="vaxis">${ticks.map((t) => `<span>${Math.round(t * 100)}%</span>`).join("")}</div>
    <div class="vplot">${ticks.map(() => "<i></i>").join("")}<div class="vbars">${top.map((b) => `<div class="vcol" title="${esc(b.name)}: ${pct(b.vis)}"><div class="vbar${b.you ? " you" : ""}" style="height:${(100 * b.vis) / ceil}%;${b.you ? "" : `background:${BAR[ci++ % BAR.length]}`}"><span class="vv">${pct(b.vis)}</span></div><div class="vlab">${brandAv(b, M)}</div></div>`).join("")}</div></div></div></div>`;
}
function brandsTableHtml(M, m, limit = 5, title = "Top 5 brands") {
  const rows = m.brands.slice(0, limit); if (m.you && !rows.includes(m.you)) rows.push(m.you);
  return `<div class="card"><div class="card-h"><b>${title}</b><span title="Ranked by visibility across this view's answers.">${icon("info", 13)}</span>${limit < m.brands.length ? `<span class="sp"></span><button class="lnk" type="button" data-page="ranking">Show all</button>` : ""}</div>
    <table class="tbl"><thead><tr><th>#</th><th>Brand</th><th class="r">Visibility</th><th class="r">SoV</th><th class="r">Position</th></tr></thead><tbody>
    ${rows.map((b) => `<tr class="${b.you ? "you" : ""}"><td class="muted">${m.brands.indexOf(b) + 1}</td><td><span class="bcell">${brandAv(b, M)}<b>${esc(b.name)}</b>${b.you ? '<span class="youtag">You</span>' : ""}</span></td><td class="r">${pct(b.vis)}</td><td class="r">${pct(b.sov)}</td><td class="r">${b.position ? b.position.toFixed(1) : '<span class="sk" style="width:28px"></span>'}</td></tr>`).join("")}
    </tbody></table></div>`;
}
function topDomainsHtml(M, m, limit = 6) {
  const top = m.domains.slice(0, limit), max = Math.max(1, ...top.map((d) => d.retr));
  const types = Object.entries(m.types).sort((a, b) => b[1] - a[1]), tmax = Math.max(1, ...types.map((t) => t[1]));
  return `<div class="sec-h"><h3>Top domains</h3><p>The domains AI models retrieved while answering your prompts</p></div>
  <div class="grid2 eq"><div class="card"><div class="card-h"><b>Top</b><span class="sp"></span><span class="muted">Retrievals</span></div>
    ${top.length ? top.map((d) => `<div class="hbar"><span class="hb" style="width:${Math.max(30, (100 * d.retr) / max)}%">${favImg(d.d)}<span>${esc(d.d)}</span></span><span class="hn">${d.retr}</span></div>`).join("") : '<p class="muted pad">No sources yet.</p>'}
    ${m.domains.length > limit ? `<button class="lnk pad" type="button" data-page="domains">All domains ${icon("chev", 12)}</button>` : ""}</div>
  <div class="card"><div class="card-h"><b>Domain types</b><span class="sp"></span><span class="muted">${icon("info", 12)} Total retrievals · ${m.totalRetr}</span></div>
    ${types.map(([t, n]) => `<div class="hbar"><span class="hb" style="width:${Math.max(30, (100 * n) / tmax)}%"><i class="dotc" style="background:${TYPEC[t]}"></i><span>${t}</span></span><span class="hn">${n}</span></div>`).join("")}</div></div>`;
}
function chatCardsHtml(M, m, n = 6) {
  const list = m.A.slice().sort((a, b) => (b.named ? 1 : 0) - (a.named ? 1 : 0) || (b.brands || []).length - (a.brands || []).length).slice(0, n);
  return `<div class="card"><div class="card-h"><b>All chats</b><span title="The live AI answers behind these numbers.">${icon("info", 13)}</span><span class="sp"></span><button class="lnk" type="button" data-page="chats">${m.n} chats ${icon("chev", 12)}</button></div>
    <div class="ccards">${list.map((a) => `<button type="button" class="ccard" data-chat="${esc(a.qid + "|" + a.engine)}"><span class="ch">${engDot(a.engine)}<b>${esc(qText(M, a.qid))}</b></span><span class="cs">${esc(String(a.answer || "").replace(/[#*_`>]/g, "").slice(0, 150))}</span><span class="cf">${(a.brands || []).slice(0, 5).map((b) => (isYou(b, M) ? favImg(host(M.profile.site)) : letterAv(b))).join("")}<span class="sp"></span>${a.named ? `<span class="posb">#${a.rank || "–"}</span>` : '<span class="posb no">not named</span>'}</span></button>`).join("")}</div></div>`;
}
const engDot = (e) => `<span class="engd" title="${ENG[e]}"><i style="background:${ENGC[e]}"></i></span>`;

/* ---- READY: Peec's "workspace is almost ready" reveal, with the real numbers in a preview of the app */
function previewApp(M) {
  const m = metrics(M, "all");
  const nav = [["Home", [["overview", "Overview", true], ["globe", "My website"]]], ["Brand", [["doc", "Insights"], ["smile", "Perception"]]], ["Prompts", [["list", "All prompts"]]], ["Sources", [["link", "Domains"], ["gap", "Gap analysis"]]], ["Optimize", [["bolt", "Actions"]]]];
  return `<div class="fr preview"><aside class="fr-side"><div class="fr-brand">${favImg(host(M.profile.site))}<b>${esc(M.profile.name)}</b>${icon("down", 13)}</div><div class="fr-nav">${nav.map(([g, it]) => `<div class="fr-g">${icon("down", 11)}${g}</div>${it.map(([ic, l, on]) => `<div class="fr-i${on ? " on" : ""}">${icon(ic, 14)}${l}</div>`).join("")}`).join("")}</div></aside>
    <div class="fr-main"><div class="fr-top">${icon("side", 15)}<b>Overview</b><span class="sp"></span><span class="fr-ib">${icon("chat", 14)}</span><span class="fr-ib">${icon("info", 14)}</span></div>
    <div class="fr-chips pad">${[70, 52, 96, 84].map((w) => `<span class="fr-chip"><span class="sk sq sm"></span><span class="sk" style="width:${w}px"></span></span>`).join("")}<span class="sp"></span><span class="muted" style="font-size:.78rem">Preview result</span></div>
    <div class="fr-scroll"><div class="grid2">${visChartHtml(M, m)}${brandsTableHtml(M, m)}</div>${chatCardsHtml(M, m)}${topDomainsHtml(M, m)}</div></div></div>`;
}
function showReady() {
  const M = APP.M; if (!M) return;
  screen("ready");
  const m = metrics(M, "all");
  $("#readyTitle").textContent = `${M.profile.name}'s workspace is ready`;
  $("#readySub").textContent = `Here are your first results: ${m.n} live AI answers, ${m.domains.length} source domains, and ${m.gaps.length} cited pages where rivals are listed and you're not.`;
  $("#readyPreview").innerHTML = previewApp(M);
}
$("#readyGo").addEventListener("click", () => showReport("overview"));
$("#readyBack").addEventListener("click", () => $("#viewLog").click());
$("#readyPreview").addEventListener("click", (e) => { const c = e.target.closest("[data-chat]"); if (c) openChat(c.dataset.chat); });

/* ---- the dashboard */
function showReport(page) {
  const M = APP.M; if (!M) return goHome();
  screen("reportWrap");
  if (page) DASH.page = page; if (DASH.eng !== "all" && !M.engines.includes(DASH.eng)) DASH.eng = "all";
  $("#projName").textContent = M.profile.name; $("#projAv").innerHTML = favImg(host(M.profile.site));
  buildDeck(); renderSugs(); renderChat();
  dashRender();
}
function filtersHtml(M) {
  const pm = store.get("prev:" + M.slug, null);
  return `<div class="segc">${["all", ...M.engines].map((e) => `<button type="button" data-eng="${e}" aria-pressed="${DASH.eng === e}">${e === "all" ? "All engines" : `<i style="background:${ENGC[e]}"></i>${ENG[e]}`}</button>`).join("")}</div>
    <span class="fchip">${icon("rank", 14)}Run · ${new Date(M.startedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>
    <span class="fchip">${icon("list", 14)}${M.questions.length} prompts</span>
    ${pm ? `<span class="fchip muted">vs ${new Date(pm.startedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>` : ""}
    <span class="sp"></span><span class="fchip muted">${esc(M.profile.market || "Global")}</span>`;
}
function dashRender() {
  const M = APP.M; if (!M || $("#reportWrap").hidden) return;
  const [g, t] = PAGES[DASH.page] || PAGES.overview;
  $$("#nav [data-page]").forEach((b) => b.classList.toggle("on", b.dataset.page === DASH.page));
  $("#crumb").innerHTML = `<span class="muted">${g}</span>${icon("chev", 13)}<b>${t}</b>`;
  $("#filters").innerHTML = filtersHtml(M);
  $("#filters").hidden = ["actions", "site", "perception"].includes(DASH.page);
  const m = metrics(M, DASH.eng), pm = prevMetrics(M, DASH.eng);
  $("#pages").innerHTML = `<div class="pg">${(PAGE[DASH.page] || PAGE.overview)(M, m, pm)}</div>`;
  if (DASH.page === "actions") drawDeck();
  if (DASH.page === "insights") renderMatrix($("#matrixBig"), M, true);
  $(".main").scrollTop = 0; $("#side").classList.remove("open");
}
const head = (h, p) => `<div class="pg-hd"><h2>${h}</h2>${p ? `<p>${p}</p>` : ""}</div>`;
const PAGE = {
  overview(M, m, pm) {
    const y = m.you, lead = m.brands.find((b) => !b.you);
    const h = !y?.mentions ? "AI doesn't recommend you yet" : m.rank === 1 ? "You're #1 in AI visibility" : `You're #${m.rank} in AI visibility`;
    const p = !y?.mentions ? `${lead ? `${esc(lead.name)} appears in ${pct(lead.vis)} of answers. ` : ""}You weren't named in any of the ${m.n} answers.` : m.rank === 1 ? `You appear in more AI answers than any competitor, and are often the default choice.` : `${esc(lead.name)} appears in ${pct(lead.vis)} of answers; you appear in ${pct(y.vis)}.`;
    const acts = DECK.slice(0, 3);
    return head(h, p) + kpiHtml(M, m, pm) + `<div class="grid2">${visChartHtml(M, m)}${brandsTableHtml(M, m)}</div>`
      + `<div class="grid2"><div class="card"><div class="card-h"><b>Visibility by engine</b></div>${m.byEngine.map((x) => { const top = metrics(M, x.e).brands.find((b) => !b.you); return `<div class="erow"><span class="en">${engDot(x.e)}${ENG[x.e]}</span><span class="eb"><i style="width:${(100 * (x.vis || 0)).toFixed(0)}%"></i></span><b>${pct(x.vis, 0)}</b><span class="muted el">${top ? `Leader: ${esc(top.name)} ${pct(top.vis, 0)}` : ""}</span></div>`; }).join("")}</div>
        <div class="card"><div class="card-h"><b>Top recommended actions</b><span class="sp"></span><button class="lnk" type="button" data-page="actions">${DECK.length} actions ${icon("chev", 12)}</button></div>${acts.length ? acts.map((c) => `<button type="button" class="arow" data-page="actions" data-card="${esc(c.id)}"><span class="ak">${esc(c.kind)}</span><b>${esc(c.title)}</b><span class="muted">${esc(c.why)}</span></button>`).join("") : '<p class="muted pad">Nothing left to do. Run again next week.</p>'}</div></div>`
      + chatCardsHtml(M, m) + topDomainsHtml(M, m);
  },
  ranking(M, m) {
    return head("Ranking", "Every brand AI mentioned for your prompts, ranked by visibility.") + `<div class="card"><table class="tbl"><thead><tr><th>#</th><th>Brand</th><th class="r">Visibility</th><th class="r">SoV</th><th class="r">Position</th><th class="r">Mentions</th><th>Status</th></tr></thead><tbody>
      ${m.brands.map((b, i) => `<tr class="${b.you ? "you" : ""}"><td class="muted">${i + 1}</td><td><span class="bcell">${brandAv(b, M)}<b>${esc(b.name)}</b>${b.you ? '<span class="youtag">You</span>' : ""}</span></td><td class="r"><span class="minibar"><i style="width:${(100 * b.vis).toFixed(0)}%"></i></span>${pct(b.vis)}</td><td class="r">${pct(b.sov)}</td><td class="r">${b.position ? b.position.toFixed(1) : "–"}</td><td class="r">${b.mentions}</td><td>${b.you ? "" : b.tracked ? '<span class="tagx">Tracked</span>' : '<span class="tagx dim">Discovered</span>'}</td></tr>`).join("")}</tbody></table></div>`;
  },
  prompts(M, m) {
    const groups = {}; M.questions.forEach((q) => (groups[q.topic || TOPIC_OF[q.intent] || "Prompts"] = groups[q.topic || TOPIC_OF[q.intent] || "Prompts"] || []).push(q));
    const engs = DASH.eng === "all" ? M.engines : [DASH.eng];
    return head("All prompts", `${M.questions.length} prompts across ${Object.keys(groups).length} topics. Click one to read the answers.`) + Object.entries(groups).map(([t, qs]) => `<div class="card"><div class="card-h"><b>${esc(t)}</b><span class="muted">${qs.length}</span></div>
      <table class="tbl click"><thead><tr><th>Prompt</th><th>Intent</th><th>${engs.map((e) => engDot(e)).join("")}</th><th class="r">Visibility</th><th class="r">Position</th><th>Top brand</th></tr></thead><tbody>
      ${qs.map((q) => { const as = engs.map((e) => M.answers[q.id + "|" + e]).filter(finished); const named = as.filter((a) => a.named); const ranks = named.map((a) => a.rank).filter(Boolean); const tb = as.flatMap((a) => (a.brands || []).slice(0, 1)).find((b) => b); const first = as[0];
        return `<tr ${first ? `data-chat="${esc(first.qid + "|" + first.engine)}"` : ""}><td class="pt">${esc(q.text)}</td><td>${intentTag(q.intent)}</td><td><span class="dots3">${engs.map((e) => { const a = M.answers[q.id + "|" + e]; return `<i class="${!finished(a) ? "" : a.named ? "y" : "n"}" title="${ENG[e]}: ${!finished(a) ? "no answer" : a.named ? "named" : "not named"}"></i>`; }).join("")}</span></td><td class="r">${as.length ? pct(named.length / as.length, 0) : "–"}</td><td class="r">${ranks.length ? "#" + (ranks.reduce((s, x) => s + x, 0) / ranks.length).toFixed(1) : "–"}</td><td>${tb ? `<span class="bcell sm">${isYou(tb, M) ? favImg(host(M.profile.site)) : letterAv(tb)}${esc(tb)}</span>` : "–"}</td></tr>`; }).join("")}
      </tbody></table></div>`).join("");
  },
  chats(M, m) {
    const f = DASH.chatFilter, list = m.A.filter((a) => f === "all" || (f === "you" ? a.named : !a.named));
    return head("Chats", "The individual AI answers behind your metrics.") + `<div class="segc inl">${[["all", `All · ${m.n}`], ["you", `Mention you · ${m.A.filter((a) => a.named).length}`], ["not", `Don't mention you · ${m.A.filter((a) => !a.named).length}`]].map(([k, l]) => `<button type="button" data-chatf="${k}" aria-pressed="${f === k}">${l}</button>`).join("")}</div>
      <div class="card"><table class="tbl click"><thead><tr><th>Prompt</th><th>Engine</th><th class="r">Your position</th><th>Brands mentioned</th><th class="r">Sources</th></tr></thead><tbody>
      ${list.map((a) => `<tr data-chat="${esc(a.qid + "|" + a.engine)}"><td class="pt">${esc(qText(M, a.qid))}</td><td><span class="bcell sm">${engDot(a.engine)}${ENG[a.engine]}</span></td><td class="r">${a.named ? `<span class="posb">#${a.rank || "–"}</span>` : '<span class="posb no">–</span>'}</td><td><span class="avs">${(a.brands || []).slice(0, 6).map((b) => (isYou(b, M) ? favImg(host(M.profile.site)) : letterAv(b))).join("")}${(a.brands || []).length > 6 ? `<span class="more">+${a.brands.length - 6}</span>` : ""}</span></td><td class="r">${Math.max(a.nSrc || 0, (a.sources || []).length)}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">No chats in this view.</td></tr>'}
      </tbody></table></div>`;
  },
  domains(M, m) {
    const f = DASH.domFilter, list = m.domains.filter((d) => f === "all" || (f === "gap" ? d.youOn === false && d.rivalsOn.length : d.type === f));
    return head("Domains", "Which sites AI retrieves when it answers your prompts. Get onto the ones it trusts.") + `<div class="segc inl">${[["all", "All"], ["gap", "Rivals on it, you're not"], ...Object.keys(m.types).map((t) => [t, t])].map(([k, l]) => `<button type="button" data-domf="${esc(k)}" aria-pressed="${f === k}">${esc(l)}</button>`).join("")}</div>
      <div class="card"><table class="tbl"><thead><tr><th>Domain</th><th>Type</th><th class="r">Retrieved</th><th class="r">Retrievals</th><th class="r">Cited</th><th>You on it</th><th>Rivals on it</th></tr></thead><tbody>
      ${list.map((d) => `<tr><td><span class="bcell">${favImg(d.d)}<b>${esc(d.d)}</b></span></td><td><span class="itag"><i style="background:${TYPEC[d.type]}"></i>${d.type}</span></td><td class="r">${pct(m.n ? d.chats / m.n : 0, 0)}</td><td class="r">${d.retr}</td><td class="r">${d.cited}</td><td>${d.youOn == null ? '<span class="muted">not opened</span>' : d.youOn ? '<span class="pillx ok">Yes</span>' : '<span class="pillx no">No</span>'}</td><td class="muted ell">${esc(d.rivalsOn.slice(0, 3).join(", "))}</td></tr>`).join("") || '<tr><td colspan="7" class="muted">Nothing here.</td></tr>'}
      </tbody></table></div>`;
  },
  gap(M, m) {
    return head("Gap analysis", `Pages AI cited where rivals are listed and you're not. ${m.gaps.length} open targets. Getting onto these is the fastest way into AI answers.`) + `<div class="card">${m.gaps.length ? m.gaps.map((t) => `<div class="grow2">${favImg(t.domain || host(t.url))}<div class="gm"><a href="${esc(safeUrl(t.final || t.url) || "#")}" target="_blank" rel="noopener"><b>${esc(t.title || t.url)}</b></a><span class="muted">${esc(t.domain || host(t.url))} · cited ${t.n}× · for ${(t.qs || []).length} prompt${(t.qs || []).length === 1 ? "" : "s"}</span><span class="chips">${(t.rivals || []).map((r) => `<span class="tagx red">${esc(r)}</span>`).join("")}${t.contacts?.emails?.[0] ? `<span class="tagx mono">${esc(t.contacts.emails[0])}</span>` : t.contacts?.author ? `<span class="tagx">by ${esc(t.contacts.author)}</span>` : ""}</span></div><button class="btn sm${M.pitches[t.url] ? " ghost" : ""}" type="button" data-pitch="${esc(t.url)}">${M.pitches[t.url] ? "Open pitch" : "Draft pitch"}</button></div>`).join("") : '<p class="muted pad">No gaps found in the pages we opened. Nice.</p>'}</div>`;
  },
  insights(M, m) {
    return head("Insights", "The agent's read of everything it saw, with the evidence behind it.") + `<div class="card md pad">${M.insights ? md(M.insights) : '<p class="muted">No insights for this run.</p>'}</div>
      <div class="card"><div class="card-h"><b>Question by question</b><span class="muted">Each cell is one live AI answer. Click to read it.</span></div><div class="pad"><div class="matrix" id="matrixBig"></div></div></div>`;
  },
  perception(M) {
    const P = M.perception;
    const V = { accurate: "ok", unsupported: "warn", wrong: "no", outdated: "no" };
    return head("Perception", "What AI says about you when asked directly, fact-checked against your own site.") + (P ? `<div class="card pad"><p class="lead">${esc(P.summary || "")}</p></div>
      <div class="card"><table class="tbl"><thead><tr><th>What AI claims</th><th>Verdict</th><th>What to publish</th></tr></thead><tbody>${(P.claims || []).map((c) => `<tr><td>${esc(c.claim)}</td><td><span class="pillx ${V[c.verdict] || ""}">${esc(c.verdict)}</span></td><td class="muted">${esc(c.fix || "")}</td></tr>`).join("")}</tbody></table></div>` : '<div class="card pad"><p class="muted">The fact-check didn\'t run for this check.</p></div>');
  },
  site(M) {
    const a = M.audit || {};
    return head("My website", `How readable ${esc(host(M.profile.site))} is for AI crawlers and answer engines.`) + `<div class="kpis"><div class="kpi"><span class="kl">AI-readiness</span><span class="kv">${a.avg ?? "–"}<small>/100</small></span></div><div class="kpi"><span class="kl">llms.txt</span><span class="kv">${a.llms ? "Found" : "Missing"}</span></div><div class="kpi"><span class="kl">Organization schema</span><span class="kv">${a.orgSchema ? "Yes" : "No"}</span></div><div class="kpi"><span class="kl">FAQ schema</span><span class="kv">${a.faqSchema ? "Yes" : "No"}</span></div><div class="kpi"><span class="kl">Sitemap URLs</span><span class="kv">${a.sitemap ?? "–"}</span></div></div>
      <div class="grid2"><div class="card"><div class="card-h"><b>Crawler access</b><span class="muted">robots.txt</span></div><table class="tbl"><tbody>${Object.entries(a.bots || {}).map(([b, ok]) => `<tr><td><b>${esc(b)}</b></td><td class="r"><span class="pillx ${ok ? "ok" : "no"}">${ok ? "Allowed" : "Blocked"}</span></td></tr>`).join("")}</tbody></table></div>
      <div class="card"><div class="card-h"><b>Pages</b><span class="muted">AI-readiness score</span></div><table class="tbl"><tbody>${(a.pages || []).map((p) => `<tr><td><span class="score ${p.score >= 60 ? "hi" : p.score >= 35 ? "md" : "lo"}">${p.score}</span></td><td><a href="${esc(safeUrl(p.url) || "#")}" target="_blank" rel="noopener">${esc(p.title || host(p.url))}</a><div class="muted sm">${esc((p.fails || []).slice(0, 3).join(" · ") || "Strong page")}</div></td></tr>`).join("")}</tbody></table></div></div>`;
  },
  actions(M) {
    return head("Actions", "Ranked fixes with the evidence behind each one. Work through them one at a time.") + `<div class="grid2 act"><div class="card pad"><div class="deckbar" id="deckCount"></div><p class="muted sm"><span class="kbd">→</span> done · <span class="kbd">←</span> skip</p><div class="deck" id="deck"></div></div>
      <div class="card"><div class="card-h"><b>Up next</b><span class="muted">${Math.max(0, DECK.length - 1)}</span></div>${DECK.slice(1).map((c) => `<button type="button" class="arow" data-card="${esc(c.id)}"><span class="ak">${esc(c.kind)}</span><b>${esc(c.title)}</b></button>`).join("") || '<p class="muted pad">Nothing queued.</p>'}</div></div>`;
  },
};
const TOPIC_OF = { best: "Best-of lists", alternatives: "Alternatives", comparison: "Comparisons", problem: "Problems to solve", local: "Budget & location", informational: "Research", commercial: "Comparisons", transactional: "Ready to buy" };

/* ---- chat details modal (prev / next through the current list) */
function markHtml(html, M, extra) {
  const { you, rivals } = namesFor(M, extra);
  const all = [...you, ...rivals].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!all.length) return html;
  const re = new RegExp(`(?<![\\w])(${all.map((n) => reEsc(esc(n))).join("|")})(?![\\w])`, "gi");
  return html.split(/(<[^>]+>)/).map((seg) => (seg.startsWith("<") ? seg : seg.replace(re, (m0) => `<mark class="${isYou(m0, M) ? "you" : ""}">${m0}</mark>`))).join("");
}
function openChat(key) {
  const M = APP.M; if (!M) return;
  const list = metrics(M, DASH.eng).A.map((a) => a.qid + "|" + a.engine);
  if (!list.includes(key)) list.unshift(key);
  let i = list.indexOf(key);
  $$(".modal").forEach((x) => x.remove());
  const m = document.createElement("div"); m.className = "modal light cmodal";
  const draw = () => {
    const a = M.answers[list[i]]; if (!a) return;
    m.innerHTML = `<div class="cm" role="dialog" aria-modal="true" aria-label="AI answer">
      <div class="cm-main"><div class="cm-hd"><span class="engchip">${engDot(a.engine)}${ENG[a.engine]}</span>${a.model ? `<span class="muted mono sm">${esc(a.model)}</span>` : ""}<span class="sp"></span>${a.named ? `<span class="posb">Named #${a.rank || "–"}</span>` : '<span class="posb no">Not named</span>'}</div>
        <div class="cm-scroll"><div class="bubble">${esc(qText(M, a.qid))}</div><div class="cm-ans md">${markHtml(md(a.answer || a.error || ""), M, a.brands)}</div></div>
        <div class="cm-nav"><button type="button" class="lnk" data-cm="-1" ${i ? "" : "disabled"}>${icon("arrow", 14)} Previous</button><span class="muted sm">${i + 1} of ${list.length}</span><button type="button" class="lnk" data-cm="1" ${i < list.length - 1 ? "" : "disabled"}>Next ${icon("arrow", 14)}</button></div></div>
      <aside class="cm-side"><div class="cm-sh"><b>Details</b><span class="sp"></span><button type="button" class="iconbtn" data-cm="x" aria-label="Close">${icon("x", 15)}</button></div>
        <div class="cm-sec">${icon("rank", 14)}Brands</div>${(a.brands || []).map((b, j) => `<div class="cm-b${isYou(b, M) ? " you" : ""}">${isYou(b, M) ? favImg(host(M.profile.site)) : letterAv(b)}<span>${esc(b)}</span><span class="sp"></span><span class="muted">#${j + 1}</span></div>`).join("") || '<p class="muted sm">No brands named.</p>'}
        ${(a.searches || []).length ? `<div class="cm-sec">${icon("search", 14)}Searches it ran</div>${a.searches.map((s) => `<p class="cm-q">${esc(s)}</p>`).join("")}` : ""}
        <div class="cm-sec">${icon("link", 14)}Sources</div>${(a.sources || []).map((s) => `<a class="cm-s" href="${esc(safeUrl(s.url) || "#")}" target="_blank" rel="noopener">${favImg(host(s.url))}<span><b>${esc(s.title || host(s.url))}</b><span class="muted">${esc(host(s.url))}</span></span></a>`).join("") || '<p class="muted sm">No sources.</p>'}
      </aside></div>`;
  };
  m.addEventListener("click", (e) => {
    if (e.target === m) return m.remove();
    const b = e.target.closest("[data-cm]"); if (!b) return;
    if (b.dataset.cm === "x") return m.remove();
    i = Math.max(0, Math.min(list.length - 1, i + +b.dataset.cm)); draw();
  });
  m.tabIndex = -1; m.addEventListener("keydown", (e) => { if (e.key === "ArrowRight" && i < list.length - 1) { i++; draw(); } if (e.key === "ArrowLeft" && i > 0) { i--; draw(); } });
  draw(); document.body.append(m); m.focus();
}

/* ---- pitch modal (from gap analysis) */
async function pitchModal(url) {
  const M = APP.M, t = pitchTargets(M).find((x) => x.url === url) || M.inspections[url]; if (!t) return;
  modal(`<span class="status">${esc(t.domain || host(url))} · cited ${t.n}×</span><h3>Get named on “${esc(t.title || url)}”</h3>${contactHtml(t.contacts)}<div class="pre" id="pmText">${M.pitches[url] ? esc(M.pitches[url]) : ""}</div><div class="acts" style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm" type="button" id="pmCopy">Copy pitch</button>${t.contacts?.emails?.[0] ? `<a class="btn ghost sm" id="pmMail" target="_blank" rel="noopener" href="#">Open in Gmail</a>` : ""}<a class="btn ghost sm" href="${esc(safeUrl(t.final || url) || "#")}" target="_blank" rel="noopener">Open page</a></div>`);
  const box = $(".modal:last-of-type"); box.classList.add("light");
  const out = $("#pmText"); let txt = M.pitches[url] || "";
  const fin = () => { if ($("#pmMail")) $("#pmMail").href = gmail(t.contacts.emails[0], txt); };
  $("#pmCopy").onclick = async (e) => { e.stopPropagation(); try { await navigator.clipboard.writeText(txt); e.target.textContent = "Copied ✓"; } catch { e.target.textContent = "Select the text to copy"; } };
  if (!txt) {
    out.classList.add("typing");
    const paint = throttled(() => { out.textContent = txt; });
    try { await stream("/api/write", { kind: "pitch", data: { profile: M.profile, t: { url: t.final || url, title: t.title, author: t.contacts?.author, rivals: t.rivals, questions: (t.qs || []).map((q) => qText(M, q)), excerpt: t.excerpt } } }, { delta: (d) => { txt += d.text; paint(); } }); }
    catch (err) { toast(esc(err.message)); }
    out.classList.remove("typing"); out.textContent = txt; if (txt) { M.pitches[url] = txt; save(); }
  }
  fin();
}

/* ---- dashboard events */
$("#nav").addEventListener("click", (e) => { const b = e.target.closest("[data-page]"); if (b) { DASH.page = b.dataset.page; dashRender(); } });
$("#reportWrap").addEventListener("click", (e) => {
  const t = e.target;
  const pg = t.closest(".main [data-page]"); if (pg) { const id = pg.dataset.card; DASH.page = pg.dataset.page; if (id) focusCard(id); dashRender(); return; }
  const card = t.closest("[data-card]"); if (card && DASH.page === "actions") { focusCard(card.dataset.card); return dashRender(); }
  const ch = t.closest("[data-chat]"); if (ch && !t.closest("a")) return openChat(ch.dataset.chat);
  const en = t.closest("[data-eng]"); if (en) { DASH.eng = en.dataset.eng; return dashRender(); }
  const cf = t.closest("[data-chatf]"); if (cf) { DASH.chatFilter = cf.dataset.chatf; return dashRender(); }
  const df = t.closest("[data-domf]"); if (df) { DASH.domFilter = df.dataset.domf; return dashRender(); }
  const pi = t.closest("[data-pitch]"); if (pi) return pitchModal(pi.dataset.pitch);
});
function focusCard(id) { const i = DECK.findIndex((c) => c.id === id); if (i > 0) DECK.unshift(DECK.splice(i, 1)[0]); }
$("#agentBtn").addEventListener("click", () => toggleAgent());
$("#agentClose").addEventListener("click", () => toggleAgent(false));
function toggleAgent(on) { const p = $("#agentPanel"); const open = on ?? p.hidden; p.hidden = !open; $(".dash").classList.toggle("agent-open", open); $("#agentBtn").setAttribute("aria-pressed", String(open)); if (open) setTimeout(() => $("#askIn").focus(), 50); }
$("#sideToggle").addEventListener("click", () => $("#side").classList.toggle("open"));
$("#projBtn").addEventListener("click", (e) => {
  e.stopPropagation(); const menu = $("#projMenu"), open = menu.hidden;
  if (open) {
    const cos = Object.values(store.get("companies", {})).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    menu.innerHTML = `<div class="pm-h">Your brands</div>${cos.map((c) => { const m = store.get("mission:" + c.slug, null); return `<button type="button" data-proj="${esc(c.slug)}" class="${APP.M?.slug === c.slug ? "on" : ""}">${favImg(host(c.profile.site))}<span>${esc(c.profile.name)}</span><span class="sp"></span><span class="muted sm">${m?.finishedAt ? new Date(m.finishedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "set up"}</span></button>`; }).join("")}<button type="button" data-proj="__new">${icon("plus", 14)}<span>New brand</span></button>`;
  }
  menu.hidden = !open; $("#projBtn").setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (e) => { if (!e.target.closest(".proj-wrap")) $("#projMenu").hidden = true; });
$("#projMenu").addEventListener("click", (e) => {
  const b = e.target.closest("[data-proj]"); if (!b) return; $("#projMenu").hidden = true;
  if (b.dataset.proj === "__new") return goHome();
  const m = store.get("mission:" + b.dataset.proj, null);
  if (m?.finishedAt && !m.abandoned) { APP.M = m; DASH.page = "overview"; return showReport(); }
  const c = store.get("companies", {})[b.dataset.proj]; if (c) startOnboarding(c.profile.site, c);
});

/* =================================================================== LEAVING & COMING BACK */
// No "leave site?" prompt: the run is saved continuously and this tab picks it back up by itself when you return.
const AUTO = "wpetal:auto";
addEventListener("pagehide", () => {
  if (!APP.M) return;
  if (APP.running) { save(true); try { sessionStorage.setItem(AUTO, APP.M.slug); } catch {} }
  try { localStorage.removeItem("wpetal:lock:" + APP.M.slug); } catch {}
});
addEventListener("pageshow", (e) => {
  // Restored from the back/forward cache: open connections were cut while away, so resume from the saved state.
  if (e.persisted && APP.running && APP.M) { try { sessionStorage.removeItem(AUTO); } catch {} APP.resuming = true; APP.ctl?.abort(); setTimeout(() => resumeMission(store.get("mission:" + APP.M.slug, APP.M)), 80); }
  else if (e.persisted) renderRecent();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { if (APP.running) save(true); return; }
  if (!$("#mission").hidden) { G.sim?.alpha(0.3).restart(); if (APP.M) renderMatrix($("#matrix"), APP.M); scrollFeed(); }
});

/* =================================================================== BOOT */
(async () => {
  stars(); renderRecent(); paintIcons();
  $$(".wordmark .pq").forEach((m) => m.classList.add("anim"));
  try { APP.cfg = await (await fetch("/api/config")).json(); } catch { $("#startErr").textContent = "Can't reach the server."; }
  if (APP.cfg.access) { $("#accessRow").hidden = false; $("#accessCode").value = APP.code || ""; }
  if (APP.cfg.engines && !APP.cfg.engines.length) $("#startErr").textContent = "The server has no AI keys yet. Add GEMINI_API_KEY (free) in the environment variables.";
  // This tab was running a check when it navigated away or reloaded: carry on without asking.
  let auto = null; try { auto = sessionStorage.getItem(AUTO); sessionStorage.removeItem(AUTO); } catch {}
  const m = auto && store.get("mission:" + auto, null);
  if (m && !m.finishedAt && m.profile && m.done && APP.cfg.engines?.length && !(await lockedElsewhere(auto))) return resumeMission(m);
  $("#startUrl").focus();
})();
})();
