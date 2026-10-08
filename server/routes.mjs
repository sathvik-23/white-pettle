// JSON API for accounts, brands (workspaces), runs, integrations and the scheduler.
// The AI routes (ask, site, write, inspect) are the original api/*.js handlers; server/index.mjs mounts both.
import { q, one, hasDb } from "./db.mjs";
import { hashPassword, verifyPassword, newToken, tokenId, randomId, seal, unseal, limited, safeEqual } from "./security.mjs";
import { fail, sendJson, redirect, readJson, cookies, cookie, clientIp, origin } from "./http.mjs";
import { PROVIDERS, listMeta, getProvider, secretFields } from "./integrations/index.mjs";
import * as google from "./integrations/google.mjs";
import * as serp from "./integrations/serp.mjs";
import * as entity from "./integrations/entity.mjs";
import * as slack from "./integrations/slack.mjs";
import { serpConfig } from "../api/_lib.js";
import { summarize, hostOf } from "./metrics.mjs";
import { runCheck } from "./runner.mjs";

const SESSION = "wp_session";
const DAY = 864e5;
const slugify = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "brand";
const emailOk = (e) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(String(e || ""));
const nextRun = (schedule, from = Date.now()) => (schedule === "daily" ? new Date(from + DAY) : schedule === "weekly" ? new Date(from + 7 * DAY) : null);

// ── sessions ────────────────────────────────────────────────────────────────
export async function currentUser(req) {
  if (!hasDb()) return null;
  const t = cookies(req)[SESSION]; if (!t) return null;
  return one(`select u.id, u.email, u.name from sessions s join users u on u.id = s.user_id where s.id = $1 and s.expires_at > now()`, [tokenId(t)]);
}
async function startSession(req, res, userId) {
  const t = newToken();
  await q(`insert into sessions (id, user_id, expires_at) values ($1, $2, now() + interval '30 days')`, [tokenId(t), userId]);
  await q(`delete from sessions where user_id = $1 and expires_at < now()`, [userId]);
  return cookie(req, SESSION, t, { maxAge: 30 * 86400 });
}
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name });
async function needUser(req) { const u = await currentUser(req); if (!u) fail(401, "Please sign in.", { code: "auth" }); return u; }
async function needWorkspace(user, slug) {
  const w = await one(`select * from workspaces where owner_id = $1 and slug = $2`, [user.id, slug]);
  if (!w) fail(404, "That brand doesn't exist (or isn't yours).");
  return w;
}
const wsOut = (w, extra = {}) => ({ slug: w.slug, name: w.name, site: w.site, schedule: w.schedule, samples: w.samples, nextRunAt: w.next_run_at, lastRunAt: w.last_run_at, running: !!w.running_at && Date.now() - new Date(w.running_at) < 40 * 60000, createdAt: w.created_at, updatedAt: w.updated_at, ...extra });

// ── integrations helpers ────────────────────────────────────────────────────
async function integrationCfg(ws, provider) {
  const row = await one(`select * from integrations where workspace_id = $1 and provider = $2`, [ws.id, provider]);
  if (!row) return null;
  const cfg = { ...(row.config || {}), ...unseal(row.secret) };
  if (provider === "google") Object.assign(cfg, { clientId: process.env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET });
  return { row, cfg };
}
async function saveIntegration(ws, provider, cfg, patch = {}) {
  const secretKeys = new Set([...secretFields(provider), "accessToken", "refreshToken"]);
  const pub = {}, sec = {};
  for (const [k, v] of Object.entries(cfg)) { if (["clientId", "clientSecret"].includes(k) || v == null || v === "") continue; (secretKeys.has(k) ? sec : pub)[k] = v; }
  await q(`insert into integrations (workspace_id, provider, config, secret, status, detail, data, collected_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, now())
           on conflict (workspace_id, provider) do update set config = excluded.config, secret = excluded.secret,
             status = coalesce($5, integrations.status), detail = coalesce($6, integrations.detail),
             data = coalesce($7, integrations.data), collected_at = coalesce($8, integrations.collected_at), updated_at = now()`,
    [ws.id, provider, pub, seal(sec), patch.status || null, patch.detail ?? null, patch.data ?? null, patch.collectedAt || null]);
}
function ctxFor(ws, extra = {}) {
  const s = ws.setup || {}, p = s.profile || {};
  const site = ws.site || p.site || "";
  return { site, host: hostOf(site), brand: ws.name, competitors: p.competitors || [], queries: (s.questions || []).filter((x) => x.on !== false).map((x) => x.text), urls: (s.audit?.pages || []).map((x) => x.url), orgSchema: s.orgSchema, ...extra };
}
async function collectOne(ws, provider) {
  const got = await integrationCfg(ws, provider); if (!got) fail(404, "Not connected.");
  const mod = getProvider(provider);
  const ctx = ctxFor(ws, { onToken: async (t) => { Object.assign(got.cfg, t); await saveIntegration(ws, provider, got.cfg); } });
  try {
    const data = await mod.collect(got.cfg, ctx);
    await saveIntegration(ws, provider, got.cfg, { status: "connected", detail: "", data, collectedAt: new Date() });
    return data;
  } catch (e) {
    await saveIntegration(ws, provider, got.cfg, { status: "error", detail: String(e.message || e).slice(0, 300) });
    throw e;
  }
}
async function integrationsFor(ws) {
  const rows = await q(`select provider, config, status, detail, data, collected_at, updated_at from integrations where workspace_id = $1`, [ws.id]);
  const by = Object.fromEntries(rows.map((r) => [r.provider, r]));
  return listMeta().filter((m) => m.id !== "serp").map((m) => {
    const r = by[m.id];
    return { ...m, connected: !!r, status: r?.status || null, detail: r?.detail || null, config: r?.config || {}, data: r?.data || null, collectedAt: r?.collected_at || null,
      available: m.id !== "google" || !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET) };
  });
}

// ── scheduled checks ────────────────────────────────────────────────────────
// One tick: claim due brands one at a time (FOR UPDATE SKIP LOCKED, so overlapping ticks never double-run one),
// run each, save, refresh connected tools, alert. Stops claiming new work with ~5 minutes left of the budget,
// because Cloud Scheduler gives up on an HTTP target after 30 minutes and CPU is throttled once we respond.
export async function tick({ budgetMs = 25 * 60000, log = console.log } = {}) {
  const until = Date.now() + budgetMs, done = [];
  while (Date.now() < until - 5 * 60000) {
    const ws = await one(`update workspaces set running_at = now()
      where id = (select id from workspaces where schedule <> 'off' and next_run_at <= now() and (running_at is null or running_at < now() - interval '45 minutes')
                  order by next_run_at limit 1 for update skip locked)
      returning *`);
    if (!ws) break;
    const prev = await one(`select data from runs where workspace_id = $1 and status = 'done' order by started_at desc limit 1`, [ws.id]);
    const prevSummary = prev?.data ? summarize(prev.data) : null;
    let M = null, err = null;
    try { M = await runCheck(ws, { prev: prev?.data, deadline: until - 60000, log: (m) => log(`[tick ${ws.slug}] ${m}`) }); }
    catch (e) { err = String(e.message || e); log(`[tick ${ws.slug}] failed: ${err}`); }
    if (M) {
      const s = summarize(M);
      await q(`insert into runs (id, workspace_id, source, status, started_at, finished_at, summary, data) values ($1, $2, 'scheduled', 'done', to_timestamp($3 / 1000.0), now(), $4, $5)`, [M.id, ws.id, M.startedAt, s, M]);
      for (const p of ["google", "bing", "cloudflare", "entity"]) { if (await one(`select 1 from integrations where workspace_id = $1 and provider = $2`, [ws.id, p])) await collectOne(ws, p).catch(() => {}); }
      await notifySlack(ws, s, prevSummary).catch(() => {});
      done.push({ slug: ws.slug, visibility: s.visibility, score: s.score });
    }
    await q(`update workspaces set running_at = null, last_run_at = case when $2 then now() else last_run_at end, next_run_at = $3, updated_at = now() where id = $1`,
      [ws.id, !!M, nextRun(ws.schedule) || null]);
    if (err) await q(`insert into runs (id, workspace_id, source, status, error, finished_at) values ($1, $2, 'scheduled', 'failed', $3, now())`, [randomId(9), ws.id, err]);
  }
  return done;
}
async function notifySlack(ws, s, prev) {
  const got = await integrationCfg(ws, "slack"); if (!got) return;
  const pct = (v) => (v == null ? "–" : `${Math.round(v * 100)}%`), d = (a, b) => (b == null || a == null ? "" : ` (${a >= b ? "▲" : "▼"} ${Math.abs(Math.round((a - b) * 100))} pts)`);
  await slack.notify(got.cfg, { title: `${ws.name}: weekly AI visibility`, lines: [`*Visibility* ${pct(s.visibility)}${d(s.visibility, prev?.visibility)}`, `*Score* ${s.score}/100 · *Share of voice* ${pct(s.sov)} · *Position* ${s.position ? "#" + s.position.toFixed(1) : "–"}`, s.leader ? `*Leader* ${s.leader.name} at ${pct(s.leader.vis)}` : ""].filter(Boolean), url: process.env.PUBLIC_ORIGIN || undefined });
}

// ── route table ─────────────────────────────────────────────────────────────
// [method, pattern, handler(req, res, params, url)]. Patterns use :name segments.
export const ROUTES = [
  ["POST", "/api/auth/signup", async (req, res) => {
    if (!hasDb()) fail(400, "Accounts need a database (DATABASE_URL).");
    if (limited("signup:" + clientIp(req), 8, 3600e3)) fail(429, "Too many sign-ups from here. Try again later.");
    const b = await readJson(req, 20000); const email = String(b.email || "").trim().toLowerCase();
    if (!emailOk(email)) fail(400, "Enter a valid email address.");
    if (String(b.password || "").length < 8) fail(400, "Use a password of at least 8 characters.");
    if (process.env.ACCESS_CODE && !safeEqual(b.code, process.env.ACCESS_CODE)) fail(403, "That invite code isn't right.", { code: "invite" });
    if (await one(`select 1 from users where email = $1`, [email])) fail(409, "There's already an account with that email. Sign in instead.");
    const u = await one(`insert into users (email, name, pw_hash, last_login_at) values ($1, $2, $3, now()) returning id, email, name`, [email, String(b.name || "").trim().slice(0, 80) || null, await hashPassword(b.password)]);
    sendJson(res, 200, { user: publicUser(u) }, { "set-cookie": await startSession(req, res, u.id) });
  }],
  ["POST", "/api/auth/login", async (req, res) => {
    if (!hasDb()) fail(400, "Accounts need a database (DATABASE_URL).");
    const b = await readJson(req, 20000); const email = String(b.email || "").trim().toLowerCase();
    if (limited("login:" + clientIp(req), 10) || limited("login:" + email, 10)) fail(429, "Too many attempts. Wait a minute and try again.");
    const u = await one(`select * from users where email = $1`, [email]);
    // Same answer for an unknown email and a wrong password, so the form can't be used to find accounts.
    if (!u || !(await verifyPassword(b.password, u.pw_hash))) fail(401, "That email and password don't match.");
    await q(`update users set last_login_at = now() where id = $1`, [u.id]);
    sendJson(res, 200, { user: publicUser(u) }, { "set-cookie": await startSession(req, res, u.id) });
  }],
  ["POST", "/api/auth/logout", async (req, res) => {
    const t = cookies(req)[SESSION]; if (t && hasDb()) await q(`delete from sessions where id = $1`, [tokenId(t)]);
    sendJson(res, 200, { ok: true }, { "set-cookie": cookie(req, SESSION, "", { maxAge: 0 }) });
  }],
  ["GET", "/api/me", async (req, res) => {
    const u = await currentUser(req); if (!u) return sendJson(res, 200, { user: null });
    sendJson(res, 200, { user: publicUser(u) });
  }],

  // Brands with their recent trend, for the switcher and the brand list.
  ["GET", "/api/workspaces", async (req, res) => {
    const u = await needUser(req);
    const rows = await q(`select w.*, (select coalesce(json_agg(t order by t.started_at), '[]') from (select id, started_at, source, summary from runs r where r.workspace_id = w.id and r.status = 'done' order by r.started_at desc limit 12) t) as trend
                           from workspaces w where owner_id = $1 order by updated_at desc`, [u.id]);
    sendJson(res, 200, { workspaces: rows.map((w) => wsOut(w, { trend: w.trend, setup: w.setup })) });
  }],
  ["PUT", "/api/workspaces/:slug", async (req, res, p) => {
    const u = await needUser(req); const b = await readJson(req);
    const slug = slugify(p.slug), name = String(b.name || b.setup?.profile?.name || slug).slice(0, 120);
    const setup = b.setup || {};
    const w = await one(`insert into workspaces (owner_id, slug, name, site, setup) values ($1, $2, $3, $4, $5)
      on conflict (owner_id, slug) do update set name = excluded.name, site = excluded.site, setup = excluded.setup, updated_at = now() returning *`, [u.id, slug, name, b.site || setup.profile?.site || null, setup]);
    sendJson(res, 200, { workspace: wsOut(w, { setup: w.setup }) });
  }],
  ["PATCH", "/api/workspaces/:slug", async (req, res, p) => {
    const u = await needUser(req); const w = await needWorkspace(u, p.slug); const b = await readJson(req, 200000);
    const schedule = ["off", "daily", "weekly"].includes(b.schedule) ? b.schedule : w.schedule;
    const samples = b.samples != null ? Math.max(1, Math.min(5, Number(b.samples) || 1)) : w.samples;
    const setup = b.setup ? { ...w.setup, ...b.setup } : w.setup;
    // A new or changed schedule starts from now: the next run is one period away, or "soon" if asked (runNow).
    const next = b.runNow ? new Date() : schedule === w.schedule && w.next_run_at ? w.next_run_at : nextRun(schedule);
    const out = await one(`update workspaces set schedule = $2, samples = $3, setup = $4, next_run_at = $5, name = coalesce($6, name), updated_at = now() where id = $1 returning *`,
      [w.id, schedule, samples, setup, schedule === "off" && !b.runNow ? null : next, b.name || null]);
    sendJson(res, 200, { workspace: wsOut(out, { setup: out.setup }) });
  }],
  ["DELETE", "/api/workspaces/:slug", async (req, res, p) => {
    const u = await needUser(req); const w = await needWorkspace(u, p.slug);
    await q(`delete from workspaces where id = $1`, [w.id]); sendJson(res, 200, { ok: true });
  }],

  // Runs: the browser saves its live run as it goes; scheduled runs arrive from the tick.
  ["GET", "/api/workspaces/:slug/runs", async (req, res, p) => {
    const u = await needUser(req); const w = await needWorkspace(u, p.slug);
    const runs = await q(`select id, source, status, started_at, finished_at, summary, error from runs where workspace_id = $1 order by started_at desc limit 60`, [w.id]);
    sendJson(res, 200, { runs });
  }],
  ["GET", "/api/workspaces/:slug/runs/latest", async (req, res, p) => {
    const u = await needUser(req); const w = await needWorkspace(u, p.slug);
    const r = await one(`select id, source, status, data from runs where workspace_id = $1 and data is not null order by (status = 'done') desc, started_at desc limit 1`, [w.id]);
    const prev = r ? await one(`select data from runs where workspace_id = $1 and status = 'done' and id <> $2 and data is not null order by started_at desc limit 1`, [w.id, r.id]) : null;
    sendJson(res, 200, { run: r?.data || null, status: r?.status || null, prev: prev?.data || null });
  }],
  ["GET", "/api/runs/:id", async (req, res, p) => {
    const u = await needUser(req);
    const r = await one(`select r.data, r.status from runs r join workspaces w on w.id = r.workspace_id where r.id = $1 and w.owner_id = $2`, [p.id, u.id]);
    if (!r) fail(404, "Run not found."); sendJson(res, 200, { run: r.data, status: r.status });
  }],
  ["PUT", "/api/runs/:id", async (req, res, p) => {
    const u = await needUser(req); const b = await readJson(req, 12 * 1024 * 1024);
    const w = await needWorkspace(u, slugify(b.slug || b.data?.slug));
    const data = b.data || {}; const status = data.finishedAt ? "done" : b.status === "stopped" ? "stopped" : "running";
    const owner = await one(`select workspace_id from runs where id = $1`, [p.id]);
    if (owner && owner.workspace_id !== w.id) fail(409, "That run id belongs to another brand.");
    await q(`insert into runs (id, workspace_id, source, status, started_at, finished_at, summary, data, updated_at)
             values ($1, $2, 'live', $3, to_timestamp($4 / 1000.0), $5, $6, $7, now())
             on conflict (id) do update set status = excluded.status, finished_at = excluded.finished_at, summary = excluded.summary, data = excluded.data, updated_at = now()`,
      [p.id, w.id, status, data.startedAt || Date.now(), data.finishedAt ? new Date(data.finishedAt) : null, status === "done" ? summarize(data) : null, data]);
    if (status === "done") await q(`update workspaces set last_run_at = now(), updated_at = now(), next_run_at = case when schedule <> 'off' then now() + case schedule when 'daily' then interval '1 day' else interval '7 days' end else null end where id = $1`, [w.id]);
    sendJson(res, 200, { ok: true, status });
  }],

  // Integrations, per brand.
  ["GET", "/api/workspaces/:slug/integrations", async (req, res, p) => {
    const u = await needUser(req); const w = await needWorkspace(u, p.slug);
    sendJson(res, 200, { integrations: await integrationsFor(w), platform: { serp: !!serpConfig(), googleOAuth: !!process.env.GOOGLE_OAUTH_CLIENT_ID } });
  }],
  ["PUT", "/api/workspaces/:slug/integrations/:provider", async (req, res, p) => {
    const u = await needUser(req); const w = await needWorkspace(u, p.slug); const mod = getProvider(p.provider);
    if (!mod || p.provider === "serp") fail(404, "Unknown integration.");
    const b = await readJson(req, 50000);
    const prev = (await integrationCfg(w, p.provider))?.cfg || {};
    const cfg = { ...prev };
    for (const f of mod.meta.fields) if (b[f.key] != null && String(b[f.key]).trim() !== "") cfg[f.key] = String(b[f.key]).trim();
    if (p.provider === "indexnow") { const { ensureKey } = await import("./integrations/indexnow.mjs"); ensureKey(cfg); }
    const t = await mod.test(cfg, ctxFor(w));
    if (t.key && !cfg.key) cfg.key = t.key;
    await saveIntegration(w, p.provider, cfg, { status: t.ok ? "connected" : "error", detail: t.detail });
    let data = null; if (t.ok && p.provider !== "slack") data = await collectOne(w, p.provider).catch(() => null);
    sendJson(res, 200, { ok: t.ok, detail: t.detail, data, integrations: await integrationsFor(w) });
  }],
  ["DELETE", "/api/workspaces/:slug/integrations/:provider", async (req, res, p) => {
    const u = await needUser(req); const w = await needWorkspace(u, p.slug);
    await q(`delete from integrations where workspace_id = $1 and provider = $2`, [w.id, p.provider]);
    sendJson(res, 200, { integrations: await integrationsFor(w) });
  }],
  ["POST", "/api/workspaces/:slug/integrations/:provider/collect", async (req, res, p) => {
    const u = await needUser(req); const w = await needWorkspace(u, p.slug);
    sendJson(res, 200, { data: await collectOne(w, p.provider), integrations: await integrationsFor(w) });
  }],
  // Push changed pages to Bing (and so ChatGPT search) right away: IndexNow and/or Bing's URL submission.
  ["POST", "/api/workspaces/:slug/integrations/:provider/submit", async (req, res, p) => {
    const u = await needUser(req); const w = await needWorkspace(u, p.slug); const b = await readJson(req, 200000);
    if (!["indexnow", "bing"].includes(p.provider)) fail(400, "This tool can't submit URLs.");
    const got = await integrationCfg(w, p.provider); if (!got) fail(404, "Not connected.");
    const urls = (b.urls || []).map(String).filter((x) => /^https?:\/\//.test(x)).slice(0, 500);
    if (!urls.length) fail(400, "No URLs to submit.");
    const r = await getProvider(p.provider).submitUrls(got.cfg, urls, ctxFor(w));
    if (p.provider === "indexnow") { got.cfg.lastSubmit = r; await saveIntegration(w, "indexnow", got.cfg); }
    sendJson(res, 200, r);
  }],
  ["POST", "/api/workspaces/:slug/integrations/google/properties", async (req, res, p) => {
    const u = await needUser(req); const w = await needWorkspace(u, p.slug);
    const got = await integrationCfg(w, "google"); if (!got) fail(404, "Connect Google first.");
    const props = await google.listProperties(got.cfg, ctxFor(w, { onToken: async (t) => { Object.assign(got.cfg, t); await saveIntegration(w, "google", got.cfg); } }));
    sendJson(res, 200, props);
  }],

  // Google OAuth (Search Console + GA4). The state row ties the callback to this user and brand, once.
  ["GET", "/api/oauth/google/start", async (req, res, p, url) => {
    const u = await needUser(req); const w = await needWorkspace(u, url.searchParams.get("ws") || "");
    if (!process.env.GOOGLE_OAUTH_CLIENT_ID) fail(400, "Google sign-in isn't configured on this server (GOOGLE_OAUTH_CLIENT_ID).");
    const state = randomId(18);
    await q(`insert into oauth_states (state, user_id, workspace_id) values ($1, $2, $3)`, [state, u.id, w.id]);
    await q(`delete from oauth_states where created_at < now() - interval '1 hour'`);
    redirect(res, google.oauthUrl({ clientId: process.env.GOOGLE_OAUTH_CLIENT_ID, redirectUri: `${origin(req)}/api/oauth/google/callback`, state }));
  }],
  ["GET", "/api/oauth/google/callback", async (req, res, p, url) => {
    const u = await needUser(req);
    const st = await one(`delete from oauth_states where state = $1 and user_id = $2 and created_at > now() - interval '1 hour' returning workspace_id`, [url.searchParams.get("state") || "", u.id]);
    if (!st) fail(400, "This Google sign-in link expired. Start again from Settings.");
    const w = await one(`select * from workspaces where id = $1`, [st.workspace_id]);
    if (url.searchParams.get("error")) return redirect(res, `/#settings/${w.slug}?google=denied`);
    const tok = await google.exchangeCode({ clientId: process.env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri: `${origin(req)}/api/oauth/google/callback`, code: url.searchParams.get("code") || "" });
    await saveIntegration(w, "google", tok, { status: "connected", detail: `Signed in as ${tok.email || "Google user"}. Choose your properties.` });
    redirect(res, `/#settings/${w.slug}?google=connected`);
  }],

  // Live checks the browser pipeline needs from the server (keys stay server-side).
  ["POST", "/api/serp/organic", async (req, res) => {
    await gate(req);
    const cfg = serpConfig(); if (!cfg) fail(400, "Google rank checks need DATAFORSEO_LOGIN/DATAFORSEO_PASSWORD or SERPAPI_KEY on the server.");
    const b = await readJson(req, 20000);
    const query = String(b.query || "").slice(0, 300); if (!query) fail(400, "No query.");
    const r = await serp.organic({ ...cfg, locationName: b.market && !/global/i.test(b.market) ? b.market : undefined }, query);
    sendJson(res, 200, { query, results: r.results || [] });
  }],
  ["POST", "/api/entity", async (req, res) => {
    await gate(req);
    const b = await readJson(req, 100000);
    const data = await entity.collect({ googleApiKey: process.env.GOOGLE_API_KEY || "" }, { brand: String(b.name || ""), host: hostOf(b.site || ""), site: b.site, orgSchema: b.orgSchema });
    sendJson(res, 200, data);
  }],

  // Cloud Scheduler → here, hourly, with the shared secret. Runs due brands before answering (see tick()).
  ["POST", "/api/cron/tick", async (req, res) => {
    if (!process.env.CRON_SECRET || !safeEqual(req.headers["x-cron-secret"], process.env.CRON_SECRET)) fail(401, "Bad cron secret.");
    if (!hasDb()) fail(400, "No database.");
    sendJson(res, 200, { ran: await tick() });
  }],
];

// Who may spend AI credits: a signed-in user, or (no database) whoever has the access code.
export async function gate(req) {
  if (hasDb()) { const u = await currentUser(req); if (u) return u; fail(401, "Please sign in.", { code: "auth" }); }
  if (process.env.ACCESS_CODE && req.headers["x-access-code"] !== process.env.ACCESS_CODE) fail(401, "Access code required", { code: "access" });
  return null;
}
