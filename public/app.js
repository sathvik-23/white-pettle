/* White Petal by Perfstaq: a visible AI agent.
   Flow: scan site → you approve the company profile (saved) → questions → live AI answers → follow the sources →
   what AI says about you → insights → drafts → results with an action deck and an agent you can ask. */
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
  if (m && m.finishedAt && !m.abandoned) { APP.M = m; showReport(); } else { const c = store.get("companies", {})[slug]; if (c) startMission(c.profile.site, c); }
}
$("#startForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = $("#startUrl").value.trim();
  if (!url) return $("#startUrl").focus();
  if (APP.cfg.access) { APP.code = $("#accessCode").value.trim() || APP.code; store.set("code", APP.code); if (!APP.code) { $("#startErr").textContent = "Enter the access code first."; return; } }
  if (!APP.cfg.engines.length) { $("#startErr").textContent = "No AI engine is configured on the server. Add GEMINI_API_KEY (free) to the environment variables."; return; }
  startMission(url);
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
  modal(`<span class="status">${ENG[a.engine]} · ${esc(a.model || "")}</span><h3>${esc(qText(APP.M, a.qid))}</h3><div>${verdictHtml(a)}</div>${(a.searches || []).length ? `<div class="chips">${a.searches.map((s) => `<span class="search">searched: ${esc(s)}</span>`).join("")}</div>` : ""}<div class="answer full">${highlight(a.answer || a.error || "", APP.M, a.brands)}</div><b style="font-size:.85rem">Sources it used</b>${srcChips(a.sources)}`);
});
function modal(html) { const m = document.createElement("div"); m.className = "modal"; m.innerHTML = `<div class="box">${html}<div><button class="btn ghost sm" type="button">Close</button></div></div>`; m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("button.btn")) m.remove(); }); document.body.append(m); }
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
  $("#landing").hidden = true; $("#reportWrap").hidden = true; $("#mission").hidden = false;
  $("#feed").innerHTML = ""; setupHud(); gInit(); setRing(null); $("#toReport").hidden = true; $("#stopBtn").hidden = false;
  $("#liveTag").className = "live"; $("#liveTag").innerHTML = "<i></i>Live"; $("#matrix").innerHTML = "";
  APP.ctl?.abort(); APP.ctl = new AbortController(); APP.running = true; APP.resuming = false; APP.frozen = null; stick = true;
  $("#hudBrand").textContent = title;
  return APP.ctl.signal;
}

async function startMission(url, saved) {
  const sig = missionUI(host(url));
  try {
    // ---------- 1. read the site
    phase("site", 5, "Reading your website");
    thought(`<b>Starting.</b> I'll read <b>${esc(host(url))}</b> the way GPTBot and PerplexityBot do, then work out what you sell and who you compete with.`, "AI can only recommend what it can read and understand.");
    let result = null; const steps = {}; let pagesCard = null; let n = 0;
    await stream("/api/site", { url }, {
      step: (d) => { steps[d.id] = stepEl(d.text, d.why); phase("site", Math.min(90, (n += 14))); },
      done: (d) => { steps[d.id]?.done(d.text, d.ok !== false); if (d.id === "robots" && d.data?.bots) gNode("you", "you", host(url)); },
      page: (p) => {
        if (!pagesCard) pagesCard = add(`<div class="hd"><span>Page AI-readiness</span><span class="sp"></span><span class="mono" style="font-size:.7rem">score / 100</span></div><div class="pages"></div>`, "card");
        const cls = p.score >= 60 ? "hi" : p.score >= 35 ? "md" : "lo";
        pagesCard.querySelector(".pages").insertAdjacentHTML("beforeend", `<div class="prow"><span class="score ${cls}">${p.score}</span><span class="t" title="${esc(p.url)}">${esc(p.title || host(p.url))}</span><span class="f">${esc((p.fails || []).slice(0, 3).join(" · ") || "Strong page")}</span></div>`);
        scrollFeed();
      },
      result: (r) => { result = r; },
    }, sig);
    if (!result) throw new Error("The site scan didn't finish.");
    finishPhase("site");

    // ---------- approval: the company profile
    if (saved?.profile) { result.profile = { ...result.profile, ...saved.profile, site: result.profile.site }; }
    const profile = await approveProfile(result.profile, result.audit, !!saved?.profile);
    const cos = store.get("companies", {}); cos[slugify(profile.name)] = { slug: slugify(profile.name), profile, audit: result.audit, siteText: result.siteText, savedAt: Date.now() }; store.set("companies", cos);
    const prev = store.get("mission:" + slugify(profile.name), null); if (prev?.finishedAt) store.set("prev:" + slugify(profile.name), prev);
    APP.M = newMission(profile, result.audit, result.siteText); const M = APP.M; save();
    $("#hudBrand").textContent = profile.name;
    gNode("you", "you", profile.name);
    add(`<span class="ic">✓</span><div><span class="tx">Saved <b>${esc(profile.name)}</b> to your companies. Continuing.</span></div>`, "step ok");
    await runPipeline(M, sig);
  } catch (err) { missionError(err, sig); }
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
    fin.querySelector("#goResults").onclick = showReport;
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

/* ---------- approval card ---------- */
function approveProfile(p, audit, auto) {
  return new Promise((resolve) => {
    thought(`<b>Here's what I understood about the company.</b> Check it before I continue. I'll save it and use it for every question I ask AI.`, "Wrong rivals or the wrong category means asking AI the wrong questions.");
    const card = add(`<div class="hd"><span class="chip ok">Company profile</span><span class="sp"></span><span class="mono" style="font-size:.7rem">${esc(host(p.site))} · AI-readiness ${audit?.avg ?? "–"}/100</span></div>
      <div class="profile"><div class="grid">
        <div class="fld"><label for="pf-name">Company</label><input id="pf-name" value="${esc(p.name)}"></div>
        <div class="fld"><label for="pf-cat">What buyers search for</label><input id="pf-cat" value="${esc(p.category)}"></div>
        <div class="fld"><label for="pf-mkt">Main market</label><input id="pf-mkt" value="${esc(p.market)}"></div>
        <div class="fld"><label for="pf-aud">Who buys it</label><input id="pf-aud" value="${esc(p.audience)}"></div>
      </div>
      <div class="fld" style="margin-top:10px"><label for="pf-offer">What they sell</label><input id="pf-offer" value="${esc(p.offer)}"></div>
      <div class="fld" style="margin-top:10px"><label>Rivals to track · click ✕ to remove, type to add</label><div class="chips" id="pf-rivals"></div></div>
      ${(p.facts || []).length ? `<div class="fld" style="margin-top:10px"><label>Facts I found on the site</label><div class="chips">${p.facts.map((f) => `<span class="chip">${esc(f)}</span>`).join("")}</div></div>` : ""}
      </div><div class="row1" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="btn" type="button" id="pf-ok">Approve and continue</button><span class="muted" style="font-size:.8rem">Saved to your companies when you approve.</span></div>`, "card hot");
    const rivals = (p.competitors || []).slice();
    const draw = () => { $("#pf-rivals").innerHTML = rivals.map((r, i) => `<span class="chip rv">${esc(r)} <button class="linkbtn" type="button" data-i="${i}" aria-label="Remove ${esc(r)}">✕</button></span>`).join("") + `<input id="pf-add" placeholder="+ add rival" style="background:transparent;border:1px dashed var(--line2);border-radius:999px;padding:2px 10px;width:130px;font-size:.78rem">`; };
    draw();
    $("#pf-rivals").addEventListener("click", (e) => { if (e.target.dataset.i != null) { rivals.splice(+e.target.dataset.i, 1); draw(); } });
    $("#pf-rivals").addEventListener("keydown", (e) => { if (e.target.id === "pf-add" && (e.key === "Enter" || e.key === ",")) { e.preventDefault(); const v = e.target.value.trim(); if (v) { rivals.push(v); draw(); $("#pf-add").focus(); } } });
    phase("site", 100, "Waiting for your approval");
    $("#liveTag").innerHTML = "<i></i>Your turn";
    // A company approved before: carry on by itself after a few seconds unless you start editing.
    let left = auto ? 8 : 0, timer = 0;
    const stopAuto = () => { if (!timer) return; clearInterval(timer); timer = 0; $("#pf-ok").textContent = "Approve and continue"; };
    if (auto) {
      card.querySelector(".muted").textContent = "You approved this profile before. Edit anything to pause.";
      $("#pf-ok").textContent = `Continue (${left})`;
      timer = setInterval(() => { if (--left <= 0) { clearInterval(timer); timer = 0; $("#pf-ok").click(); } else $("#pf-ok").textContent = `Continue (${left})`; }, 1000);
      card.addEventListener("focusin", (e) => { if (e.target.id !== "pf-ok") stopAuto(); });
      card.addEventListener("pointerdown", (e) => { if (e.target.id !== "pf-ok") stopAuto(); });
    }
    $("#pf-ok").addEventListener("click", () => {
      if (timer) { clearInterval(timer); timer = 0; }
      const extra = $("#pf-add")?.value.trim(); if (extra) rivals.push(extra);
      const out = { ...p, name: $("#pf-name").value.trim() || p.name, category: $("#pf-cat").value.trim(), market: $("#pf-mkt").value.trim(), audience: $("#pf-aud").value.trim(), offer: $("#pf-offer").value.trim(), competitors: rivals };
      card.classList.remove("hot"); card.querySelectorAll("input,button").forEach((x) => (x.disabled = true)); $("#pf-ok").textContent = "Approved ✓";
      $("#liveTag").innerHTML = "<i></i>Live";
      resolve(out);
    }, { once: true });
  });
}

/* =================================================================== REPORT */
function showReport() {
  const M = APP.M; if (!M) return goHome();
  $("#landing").hidden = true; $("#mission").hidden = true; $("#reportWrap").hidden = false; scrollTo({ top: 0 });
  const prev = store.get("prev:" + M.slug, null);
  const ans = Object.values(M.answers).filter((a) => a.status === "yes" || a.status === "no");
  const score = ans.length ? Math.round((100 * ans.filter((a) => a.named).length) / ans.length) : 0;
  const pScore = prev ? (() => { const x = Object.values(prev.answers).filter((a) => a.status === "yes" || a.status === "no"); return x.length ? Math.round((100 * x.filter((a) => a.named).length) / x.length) : null; })() : null;
  const rc = {}; ans.forEach((a) => (a.brands || []).forEach((b) => { if (!isYou(b, M)) rc[b] = (rc[b] || 0) + 1; }));
  const rivals = Object.entries(rc).sort((a, b) => b[1] - a[1]);
  const youN = ans.filter((a) => a.named).length;
  const line = youN === 0 ? `AI doesn't recommend <em>${esc(M.profile.name)}</em> yet${rivals[0] ? `. ${esc(rivals[0][0])} gets named instead` : ""}.` : `AI named you in <em>${youN} of ${ans.length}</em> answers${rivals[0] ? `. ${esc(rivals[0][0])}: ${rivals[0][1]}` : ""}.`;
  const sov = [...rivals.slice(0, 6).map(([n, c]) => ({ n, c })), { n: M.profile.name, c: youN, you: true }].sort((a, b) => b.c - a.c);
  const max = Math.max(1, ...sov.map((x) => x.c));
  $("#hero").innerHTML = `<div class="big tnum">${score}<small>%</small></div>
    <div><p class="line">${line}</p><div class="pills">${M.engines.map((e) => { const x = ans.filter((a) => a.engine === e); const v = x.length ? Math.round((100 * x.filter((a) => a.named).length) / x.length) : 0; return `<span class="pill">${ENG[e]} <b>${v}%</b></span>`; }).join("")}${pScore != null ? `<span class="pill ${score > pScore ? "up" : score < pScore ? "down" : ""}">${score === pScore ? `No change since last check (${new Date(prev.startedAt).toLocaleDateString()})` : `${score > pScore ? "▲" : "▼"} ${Math.abs(score - pScore)} pts since ${new Date(prev.startedAt).toLocaleDateString()}`}</span>` : ""}<span class="pill">${(estimateMinutes(M) / 60).toFixed(1)}h of work done</span></div></div>
    <div class="sov">${sov.map((x) => `<div class="r${x.you ? " you" : ""}"><span class="n">${esc(x.n)}</span><span class="b"><i style="width:${((100 * x.c) / max).toFixed(0)}%"></i></span><span class="c">${x.c}</span></div>`).join("")}</div>`;
  $("#insights").innerHTML = M.insights ? md(M.insights) : `<p class="muted">No insights for this run.</p>`;
  renderMatrix($("#matrixBig"), M, true);
  const ins = Object.values(M.inspections).sort((a, b) => (a.you ? 1 : 0) - (b.you ? 1 : 0) || b.n - a.n);
  $("#sourcesList").innerHTML = ins.length ? ins.map((p) => `<div class="irow"><span class="chip ${!p.ok ? "" : p.you ? "ok" : "no"}">${!p.ok ? "blocked" : p.you ? "you ✓" : "you ✕"}</span><div style="min-width:0"><div class="d"><a href="${esc(safeUrl(p.final || p.url) || "#")}" target="_blank" rel="noopener">${esc(p.title || p.url)}</a> <span class="muted" style="font-weight:400">· ${esc(p.domain || host(p.url))} · cited ${p.n}×</span></div>${p.ok ? `<div class="ev2">${(p.rivals || []).length ? `Rivals here: ${p.rivals.map((x) => `<b>${esc(x)}</b>`).join(", ")}` : "No tracked rivals"}</div>` : ""}</div></div>`).join("") : `<p class="muted">No cited pages this run.</p>`;
  buildDeck(); renderChat(); renderSugs();
}
$("#viewLog").addEventListener("click", () => {
  $("#reportWrap").hidden = true; $("#mission").hidden = false;
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
$("#rerun").addEventListener("click", async () => { const M = APP.M; if (!M) return; if (await lockedElsewhere(M.slug)) return toast("This brand is running in another tab right now."); startMission(M.profile.site, { profile: M.profile }); });
$("#newBrand").addEventListener("click", goHome);
function goHome() { if (APP.running) { APP.ctl?.abort(); } if (APP.M) lockRelease(APP.M.slug); $("#mission").hidden = true; $("#reportWrap").hidden = true; $("#landing").hidden = false; $("#startUrl").value = ""; renderRecent(); }

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
$("#deck").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]"); if (!b) return; const act = b.dataset.act, c = DECK[0], M = APP.M;
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
  const el = $("#dk"); el.classList.add(how === "skip" ? "out-l" : "out-r");
  setTimeout(() => { DECK.shift(); drawDeck(); }, 260);
}
addEventListener("keydown", (e) => {
  if ($("#reportWrap").hidden || /input|textarea/i.test(document.activeElement?.tagName)) { if (e.key === "/" && !$("#reportWrap").hidden && document.activeElement !== $("#askIn")) { e.preventDefault(); $("#askIn").focus(); } return; }
  if (e.key === "ArrowRight") advance("done");
  if (e.key === "ArrowLeft") advance("skip");
  if (e.key === "/") { e.preventDefault(); $("#askIn").focus(); }
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
  stars(); renderRecent();
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
