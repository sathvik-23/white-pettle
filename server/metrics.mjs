// The headline numbers of a run, computed on the server for trend lines, the brand list and alerts.
// Same definitions as public/app.js `metrics()` (Peec / Profound / Otterly naming); keep the two in step.
export const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const hostOf = (u) => { try { return new URL(String(u).includes("://") ? u : "https://" + u).hostname.replace(/^www\./, ""); } catch { return String(u || ""); } };
export const finished = (a) => a && (a.status === "yes" || a.status === "no") && !a.absent; // an AI Overview Google did not show is not a miss

export function youNames(profile) { return [profile?.name, hostOf(profile?.site || "").split(".")[0]].filter((x) => x && x.length >= 3); }
export function isYou(name, profile) { const n = norm(name); return youNames(profile).some((y) => { const a = norm(y); return n === a || (" " + n + " ").includes(" " + a + " "); }); }
export function textHasYou(t, profile) { const x = " " + norm(t) + " "; return youNames(profile).some((y) => x.includes(" " + norm(y) + " ")); }

// Visibility score, 0-100 (Surfer-style single number). Weighted so that being NAMED dominates:
// 50% visibility, 20% share of voice relative to the category leader, 20% position (#1 = full, #6+ = none),
// 10% sentiment. Documented in the app's "How we measure" panel.
export function visibilityScore({ vis = 0, sov = 0, leaderSov = 0, position = null, sentiment = null }) {
  const posF = position ? Math.max(0, Math.min(1, (6 - position) / 5)) : 0;
  const sovRel = leaderSov ? Math.min(1, sov / leaderSov) : 0;
  const sent = sentiment == null ? 0.5 : sentiment / 100;
  return Math.round(100 * (0.5 * vis + 0.2 * sovRel + 0.2 * posF + 0.1 * (vis ? sent : 0)));
}

export function summarize(M) {
  const profile = M.profile || {};
  const A = Object.values(M.answers || {}).filter(finished);
  const B = new Map(); const YOU = "\u0000you"; let total = 0;
  const get = (name) => { const you = isYou(name, profile), k = you ? YOU : norm(name); if (!k) return null; if (!B.has(k)) B.set(k, { name: you ? profile.name : String(name).trim(), you, mentions: 0, pos: [], sent: [] }); return B.get(k); };
  get(profile.name || "you");
  for (const a of A) {
    const seen = new Set();
    (a.brands || []).forEach((b, i) => { const r = get(b); if (!r) return; const k = r.you ? YOU : norm(b); if (seen.has(k)) return; seen.add(k); r.mentions++; r.pos.push(i + 1); total++; });
    if (a.named && !seen.has(YOU)) { const r = B.get(YOU); r.mentions++; if (a.rank) r.pos.push(a.rank); total++; seen.add(YOU); }
    for (const [n, v] of Object.entries(a.sent || {})) { const r = get(n); const k = r?.you ? YOU : norm(n); if (r && seen.has(k) && typeof v === "number") r.sent.push(v); }
  }
  const avg = (x) => (x.length ? x.reduce((s, v) => s + v, 0) / x.length : null);
  const brands = [...B.values()].map((r) => ({ name: r.name, you: r.you, mentions: r.mentions, vis: A.length ? r.mentions / A.length : 0, sov: total ? r.mentions / total : 0, position: avg(r.pos), sentiment: avg(r.sent), win: A.length ? r.pos.filter((p) => p === 1).length / A.length : 0 }))
    .sort((a, b) => b.vis - a.vis || (a.position ?? 99) - (b.position ?? 99));
  const you = brands.find((b) => b.you) || { vis: 0, sov: 0, position: null, sentiment: null, win: 0, mentions: 0 };
  const leader = brands.find((b) => !b.you) || null;
  const engines = {};
  for (const e of new Set(A.map((a) => a.engine))) { const x = A.filter((a) => a.engine === e); engines[e] = x.length ? x.filter((a) => a.named).length / x.length : null; }
  const own = hostOf(profile.site || "");
  const used = A.filter((a) => (a.sources || []).some((s) => { const h = hostOf(s.url); return own && (h === own || h.endsWith("." + own)); })).length;
  const leaderSov = Math.max(you.sov, ...brands.filter((b) => !b.you).map((b) => b.sov), 0);
  return {
    n: A.length, visibility: you.vis, sov: you.sov, position: you.position, sentiment: you.sentiment, win: you.win, mentions: you.mentions,
    usedAsSource: A.length ? used / A.length : null, rank: brands.indexOf(you) + 1, brands: brands.length,
    leader: leader ? { name: leader.name, vis: leader.vis } : null, engines,
    score: visibilityScore({ vis: you.vis, sov: you.sov, leaderSov, position: you.position, sentiment: you.sentiment }),
    pagesOpened: Object.values(M.inspections || {}).filter((p) => p.ok).length,
    onPages: Object.values(M.inspections || {}).filter((p) => p.ok && p.you).length,
  };
}
