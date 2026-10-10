// JSON API for accounts, organisations, brands (workspaces), runs, integrations and the scheduler.
// The AI routes (ask, site, write, inspect) are the original api/*.js handlers; server/app.mjs mounts both.
//
// Every brand belongs to an organisation. A request works in the session's current organisation, and each route
// names the lowest role it needs (viewer < editor < admin < owner; see server/orgs.mjs).
import { q, one, hasDb, tx } from "./db.mjs";
import { hashPassword, verifyPassword, newToken, tokenId, randomId, seal, unseal, limited, safeEqual } from "./security.mjs";
import { fail, sendJson, redirect, readJson, cookies, cookie, clientIp, origin } from "./http.mjs";
import { listMeta, getProvider, secretFields } from "./integrations/index.mjs";
import * as google from "./integrations/google.mjs";
import * as serp from "./integrations/serp.mjs";
import * as entity from "./integrations/entity.mjs";
import * as slack from "./integrations/slack.mjs";
import { serpConfig, env } from "../api/_lib.js";
import { summarize, hostOf } from "./metrics.mjs";
import { runCheck } from "./runner.mjs";
import { slugify, emailOk, normEmail } from "./util.mjs";
import * as O from "./orgs.mjs";
import * as mail from "./mail.mjs";
import { makeBillingRoutes } from "./billing-routes.mjs";

const SESSION = "wp_session";
const GSTATE = "wp_gstate";
const DAY = 864e5;
const nextRun = (schedule, from = Date.now()) => (schedule === "daily" ? new Date(from + DAY) : schedule === "weekly" ? new Date(from + 7 * DAY) : null);
const personalOrgName = (u) => `${(u.name || "").trim() || u.email.split("@")[0]}'s brands`;
const platformKeysForSignups = () => process.env.PLATFORM_KEYS_FOR_SIGNUPS !== "0";

// ── sessions and context ────────────────────────────────────────────────────
export async function currentUser(req) {
  if (!hasDb()) return null;
  const t = cookies(req)[SESSION]; if (!t) return null;
  return one(`select u.id, u.email, u.name, u.email_verified_at, s.id as sid, s.org_id as session_org from sessions s join users u on u.id = s.user_id where s.id = $1 and s.expires_at > now()`, [tokenId(t)]);
}
async function startSession(req, userId, orgId = null) {
  const t = newToken();
  await q(`insert into sessions (id, user_id, org_id, expires_at) values ($1, $2, $3, now() + interval '30 days')`, [tokenId(t), userId, orgId]);
  await q(`delete from sessions where user_id = $1 and expires_at < now()`, [userId]);
  return cookie(req, SESSION, t, { maxAge: 30 * 86400 });
}
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, verified: !!u.email_verified_at });
async function needUser(req) { const u = await currentUser(req); if (!u) fail(401, "Please sign in.", { code: "auth" }); return u; }
export async function needCtx(req, min = "viewer") {
  const ctx = await O.context(await needUser(req));
  if (!ctx.org) fail(403, "You're not in an organisation yet. Ask an admin to invite you.", { code: "no_org" });
  O.needRole(ctx, min);
  return ctx;
}
async function needWorkspace(ctx, slug, min = "viewer") {
  O.needRole(ctx, min);
  const w = await one(`select * from workspaces where org_id = $1 and slug = $2`, [ctx.org.id, slug]);
  if (!w) fail(404, "That brand doesn't exist in this organisation.");
  return w;
}
const setSessionOrg = (u, orgId) => q(`update sessions set org_id = $2 where id = $1`, [u.sid, orgId]);
async function meOut(u) {
  const ctx = await O.context(u);
  const cap = ctx.org ? await O.capState(ctx.org.id) : null;
  return { user: publicUser(u), operator: ctx.operator, org: O.orgOut(ctx), orgs: ctx.orgs.map((o) => ({ slug: o.slug, name: o.name, role: o.role })),
    budget: cap ? { warn: cap.warn, over: cap.over, pct: cap.pct } : null };
}
const wsOut = (w, extra = {}) => ({ slug: w.slug, name: w.name, site: w.site, schedule: w.schedule, samples: w.samples, nextRunAt: w.next_run_at, lastRunAt: w.last_run_at, running: !!w.running_at && Date.now() - new Date(w.running_at) < 40 * 60000, createdAt: w.created_at, updatedAt: w.updated_at, ...extra });

// Who may spend AI credits. With a database: a member with at least `min` (editor by default), inside the monthly
// budget; the request then runs on the organisation's keys (see app.mjs). Without one: the access code, as before.
// A request from this same machine to a dev server (npm run dev) is the owner testing: no access code needed.
export function isLocalDev(req) {
  if (process.env.NODE_ENV === "production" || req.headers["x-forwarded-for"]) return false;
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket?.remoteAddress);
}
// Two steps, so the AI routes can check who is asking before reading a (possibly large) body:
// aiAuth (signed in, or the access code without a database), then aiAllow (role, budget, which brand).
export async function aiAuth(req) {
  if (!hasDb()) {
    if (process.env.ACCESS_CODE && !isLocalDev(req) && req.headers["x-access-code"] !== process.env.ACCESS_CODE) fail(401, "Access code required", { code: "access" });
    return null;
  }
  return needCtx(req, "viewer");
}
export async function aiAllow(ctx, req, min = "editor") {
  if (!ctx) return null;
  O.needRole(ctx, min);
  await O.needBudget(ctx.org.id);
  const slug = String(req.headers["x-wp-brand"] || "").slice(0, 60);
  ctx.workspaceId = slug ? (await one(`select id from workspaces where org_id = $1 and slug = $2`, [ctx.org.id, slug]))?.id || null : null;
  return ctx;
}
export async function aiContext(req, min = "editor") { return aiAllow(await aiAuth(req), req, min); }
export const gate = (req) => aiContext(req, "editor");

// ── one-time email links (password reset, email verification) ─────────────────
async function emailLink(req, user, purpose) {
  const t = newToken();
  await q(`insert into user_tokens (token_hash, user_id, purpose, expires_at) values ($1, $2, $3, now() + $4::interval)`, [tokenId(t), user.id, purpose, purpose === "reset" ? "1 hour" : "3 days"]);
  const link = `${origin(req)}/#${purpose}=${t}`;
  return purpose === "reset" ? mail.resetEmail({ to: user.email, link }) : mail.verifyEmail({ to: user.email, link });
}
async function useToken(token, purpose) {
  const r = await one(`update user_tokens set used_at = now() where token_hash = $1 and purpose = $2 and used_at is null and expires_at > now() returning user_id`, [tokenId(String(token || "")), purpose]);
  if (r) await q(`update user_tokens set used_at = now() where user_id = $1 and purpose = $2 and used_at is null`, [r.user_id, purpose]); // older links die too
  return r?.user_id || null;
}

// ── invitations ─────────────────────────────────────────────────────────────
async function sendInvite(req, by, org, email, role) {
  const { invite, token } = await O.createInvite({ orgId: org.id, email, role, by: by.id });
  const link = `${origin(req)}/#invite=${token}`;
  const r = await mail.inviteEmail({ to: email, orgName: org.name, role, inviter: by.name || by.email, link });
  await O.audit(org.id, by.id, "invite.sent", email, { role, emailed: r.sent });
  // The link goes back to the admin too, so an invite still works before email is set up (or lands in spam).
  return { ...invite, link, emailed: r.sent };
}

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
// run each on its organisation's keys, save, refresh connected tools, alert. Stops claiming new work with ~5
// minutes left of the budget, because Cloud Scheduler gives up on an HTTP target after 30 minutes.
export async function tick({ budgetMs = 25 * 60000, log = console.log } = {}) {
  const until = Date.now() + budgetMs, done = [];
  while (Date.now() < until - 5 * 60000) {
    const ws = await one(`update workspaces set running_at = now()
      where id = (select id from workspaces where schedule <> 'off' and next_run_at <= now() and (running_at is null or running_at < now() - interval '45 minutes')
                  order by next_run_at limit 1 for update skip locked)
      returning *`);
    if (!ws) break;
    const budget = await O.capState(ws.org_id);
    if (budget.over) {
      log(`[tick ${ws.slug}] skipped: monthly AI budget reached`);
      await q(`update workspaces set running_at = null, next_run_at = now() + interval '1 day' where id = $1`, [ws.id]);
      await O.audit(ws.org_id, null, "check.skipped", ws.name, { reason: "monthly AI budget reached", spent: budget.spent, cap: budget.cap });
      continue;
    }
    const prev = await one(`select data from runs where workspace_id = $1 and status = 'done' order by started_at desc limit 1`, [ws.id]);
    const prevSummary = prev?.data ? summarize(prev.data) : null;
    let M = null, err = null;
    try {
      const keys = O.envFor(await O.orgKeys(ws.org_id));
      // Stop asking once this run's estimated cost would pass what's left of the monthly budget.
      const budgetUsd = budget.cap == null ? null : Math.max(0, budget.cap - budget.spent);
      M = await O.withEnv(keys, () => runCheck(ws, { prev: prev?.data, deadline: until - 60000, budgetUsd, costOf: O.costOf, log: (m) => log(`[tick ${ws.slug}] ${m}`) }));
    } catch (e) { err = String(e.message || e); log(`[tick ${ws.slug}] failed: ${err}`); }
    if (M) {
      const s = summarize(M);
      await q(`insert into runs (id, workspace_id, source, status, started_at, finished_at, summary, data) values ($1, $2, 'scheduled', 'done', to_timestamp($3 / 1000.0), now(), $4, $5)`, [M.id, ws.id, M.startedAt, s, M]);
      await meterRun(ws, M);
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
// A scheduled run calls the engines in-process, so its usage is counted from the finished run.
async function meterRun(ws, M) {
  const by = {}; for (const a of Object.values(M.answers || {})) by[a.engine] = (by[a.engine] || 0) + 1;
  const base = { orgId: ws.org_id, workspaceId: ws.id };
  for (const [engine, n] of Object.entries(by)) await O.meter({ ...base, kind: "ask", engine, n });
  if (M.perception) await O.meter({ ...base, kind: "ask", engine: M.engines.find((e) => !["aio", "aimode"].includes(e)) || M.engines[0], n: 2 });
  await O.meter({ ...base, kind: "inspect", n: Object.keys(M.inspections || {}).length });
  await O.meter({ ...base, kind: "write", n: 3 });
}
async function notifySlack(ws, s, prev) {
  const got = await integrationCfg(ws, "slack"); if (!got) return;
  const pct = (v) => (v == null ? "–" : `${Math.round(v * 100)}%`), d = (a, b) => (b == null || a == null ? "" : ` (${a >= b ? "▲" : "▼"} ${Math.abs(Math.round((a - b) * 100))} pts)`);
  await slack.notify(got.cfg, { title: `${ws.name}: weekly AI visibility`, lines: [`*Visibility* ${pct(s.visibility)}${d(s.visibility, prev?.visibility)}`, `*Score* ${s.score}/100 · *Share of voice* ${pct(s.sov)} · *Position* ${s.position ? "#" + s.position.toFixed(1) : "–"}`, s.leader ? `*Leader* ${s.leader.name} at ${pct(s.leader.vis)}` : ""].filter(Boolean), url: process.env.PUBLIC_ORIGIN || undefined });
}

const needDb = () => { if (!hasDb()) fail(400, "Accounts need a database (DATABASE_URL)."); };
const roleOk = (r) => O.ROLES.includes(r);

// ── route table ─────────────────────────────────────────────────────────────
// [method, pattern, handler(req, res, params, url)]. Patterns use :name segments.
export const ROUTES = [
  // ── billing (first, so the webhook is matched before anything generic) ──
  ...makeBillingRoutes({ needCtx }),
  // ── accounts ──
  ["POST", "/api/auth/signup", async (req, res) => {
    needDb();
    const b = await readJson(req, 20000); const email = normEmail(b.email);
    // Open sign-ups are rate limited per address; invited ones are already gated by their one-time token.
    if (limited(b.invite ? "signup-invite:" + clientIp(req) : "signup:" + clientIp(req), b.invite ? 60 : 8, 3600e3)) fail(429, "Too many sign-ups from here. Try again later.");
    if (!emailOk(email)) fail(400, "Enter a valid email address.");
    if (String(b.password || "").length < 8) fail(400, "Use a password of at least 8 characters.");
    const inv = b.invite ? await O.findInvite(String(b.invite)) : null;
    if (b.invite && !inv) fail(400, "This invite link has expired or was already used. Ask for a new one.", { code: "invite_gone" });
    if (inv && normEmail(inv.email) !== email) fail(403, `This invite is for ${inv.email}.`, { code: "invite_email" });
    if (!inv && process.env.ACCESS_CODE && !safeEqual(b.code, process.env.ACCESS_CODE)) fail(403, "That invite code isn't right.", { code: "invite" });
    if (await one(`select 1 from users where email = $1`, [email])) fail(409, "There's already an account with that email. Sign in instead.");
    const pw = await hashPassword(b.password), name = String(b.name || "").trim().slice(0, 80) || null;
    let u, orgId;
    if (inv) {
      // The account and its membership are made together: if the invite can't be accepted, no orphan account is left.
      ({ u, orgId } = await tx(async (c) => {
        const u = (await c.query(`insert into users (email, name, pw_hash, last_login_at) values ($1, $2, $3, now()) returning id, email, name`, [email, name, pw])).rows[0];
        return { u, orgId: (await O.acceptInvite(inv, u, c)).orgId };
      }));
      u.email_verified_at = new Date();
    } else {
      u = await one(`insert into users (email, name, pw_hash, last_login_at) values ($1, $2, $3, now()) returning id, email, name, email_verified_at`, [email, name, pw]);
      orgId = (await O.createOrg({ name: personalOrgName(u), by: u.id, allowPlatformKeys: platformKeysForSignups() })).id;
      emailLink(req, u, "verify").catch((e) => console.warn("[verify]", e.message));
    }
    sendJson(res, 200, { user: publicUser(u) }, { "set-cookie": await startSession(req, u.id, orgId) });
  }],
  ["POST", "/api/auth/login", async (req, res) => {
    needDb();
    const b = await readJson(req, 20000); const email = normEmail(b.email);
    if (limited("login:" + clientIp(req), 10) || limited("login:" + email, 10)) fail(429, "Too many attempts. Wait a minute and try again.");
    const u = await one(`select * from users where email = $1`, [email]);
    // Same answer for an unknown email, a Google-only account and a wrong password, so the form can't find accounts.
    if (!u || !u.pw_hash || !(await verifyPassword(b.password, u.pw_hash))) fail(401, "That email and password don't match. If you signed up with Google, use Continue with Google.");
    await q(`update users set last_login_at = now() where id = $1`, [u.id]);
    let orgId = null;
    if (b.invite) { const inv = await O.findInvite(String(b.invite)); if (inv) orgId = (await O.acceptInvite(inv, u)).orgId; }
    sendJson(res, 200, { user: publicUser(u) }, { "set-cookie": await startSession(req, u.id, orgId) });
  }],
  ["POST", "/api/auth/logout", async (req, res) => {
    const t = cookies(req)[SESSION]; if (t && hasDb()) await q(`delete from sessions where id = $1`, [tokenId(t)]);
    sendJson(res, 200, { ok: true }, { "set-cookie": cookie(req, SESSION, "", { maxAge: 0 }) });
  }],
  // Password reset: the same answer whether or not the email has an account.
  ["POST", "/api/auth/forgot", async (req, res) => {
    needDb();
    if (limited("forgot:" + clientIp(req), 5, 3600e3)) fail(429, "Too many requests from here. Try again later.");
    const b = await readJson(req, 5000); const email = normEmail(b.email);
    if (!emailOk(email)) fail(400, "Enter a valid email address.");
    const u = await one(`select id, email from users where email = $1`, [email]);
    // Not awaited, so the answer takes the same time whether or not the account exists.
    if (u && !limited("forgot:" + email, 3, 3600e3)) emailLink(req, u, "reset").catch((e) => console.warn("[reset]", e.message));
    sendJson(res, 200, { ok: true });
  }],
  ["POST", "/api/auth/reset", async (req, res) => {
    needDb();
    if (limited("reset:" + clientIp(req), 10)) fail(429, "Too many attempts. Wait a minute and try again.");
    const b = await readJson(req, 5000);
    if (String(b.password || "").length < 8) fail(400, "Use a password of at least 8 characters.");
    const userId = await useToken(b.token, "reset");
    if (!userId) fail(400, "This reset link has expired or was already used. Ask for a new one.");
    // The emailed link also proves the address.
    await q(`update users set pw_hash = $2, last_login_at = now(), email_verified_at = coalesce(email_verified_at, now()) where id = $1`, [userId, await hashPassword(b.password)]);
    await q(`delete from sessions where user_id = $1`, [userId]); // signed out everywhere else
    const u = await one(`select id, email, name, email_verified_at from users where id = $1`, [userId]);
    sendJson(res, 200, { user: publicUser(u) }, { "set-cookie": await startSession(req, u.id) });
  }],
  // Email verification: a link is sent at sign-up; it can be sent again while signed in.
  ["POST", "/api/auth/verify", async (req, res) => {
    needDb();
    if (limited("verify:" + clientIp(req), 20)) fail(429, "Too many attempts. Wait a minute and try again.");
    const b = await readJson(req, 5000);
    const userId = await useToken(b.token, "verify");
    if (!userId) fail(400, "This verification link has expired or was already used. Send a new one from Team & keys.");
    await q(`update users set email_verified_at = coalesce(email_verified_at, now()) where id = $1`, [userId]);
    sendJson(res, 200, { ok: true });
  }],
  ["POST", "/api/auth/verify/send", async (req, res) => {
    const u = await needUser(req);
    if (u.email_verified_at) return sendJson(res, 200, { ok: true, already: true });
    if (limited("verify-send:" + u.id, 3, 3600e3)) fail(429, "We've sent a few already. Check your inbox (and spam), or try again in an hour.");
    const r = await emailLink(req, u, "verify");
    sendJson(res, 200, { ok: true, emailed: r.sent });
  }],
  // Sign in with Google (identity only). The state lives in a short-lived cookie with the invite token, if any.
  ["GET", "/api/auth/google/start", async (req, res, p, url) => {
    needDb();
    if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_CLIENT_SECRET) fail(400, "Google sign-in isn't set up on this server.");
    const state = randomId(18), inv = String(url.searchParams.get("invite") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100);
    redirect(res, google.loginUrl({ clientId: process.env.GOOGLE_OAUTH_CLIENT_ID, redirectUri: `${origin(req)}/api/auth/google/callback`, state }),
      { "set-cookie": cookie(req, GSTATE, `${state}.${inv}`, { maxAge: 600 }) });
  }],
  ["GET", "/api/auth/google/callback", async (req, res, p, url) => {
    needDb();
    const clear = cookie(req, GSTATE, "", { maxAge: 0 });
    const back = (msg) => redirect(res, `/#auth-error=${encodeURIComponent(msg)}`, { "set-cookie": clear });
    const [state, invToken] = String(cookies(req)[GSTATE] || "").split(".");
    if (!state || !safeEqual(state, url.searchParams.get("state"))) return back("That Google sign-in expired. Try again.");
    if (url.searchParams.get("error")) return back("Google sign-in was cancelled.");
    let g;
    try { g = await google.exchangeLogin({ clientId: process.env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri: `${origin(req)}/api/auth/google/callback`, code: url.searchParams.get("code") || "" }); }
    catch (e) { return back(e.message); }
    if (!g.emailVerified) return back("Google hasn't verified that email address.");
    const invite = invToken ? await O.findInvite(invToken) : null;
    let u = await one(`select id, email, name, google_sub, email_verified_at from users where google_sub = $1`, [g.sub]);
    if (!u) {
      u = await one(`select id, email, name, google_sub, email_verified_at from users where email = $1`, [g.email]);
      // Same address, different Google account (say, a mailbox deleted and recreated): not the same person.
      if (u?.google_sub && u.google_sub !== g.sub) return back("This email is linked to a different Google account. Sign in with that one, or with your password.");
      // A password account nobody ever proved owns this address may have been registered by someone else first.
      // Google has now proved it: the address owner takes the account over, and the unproven password and sessions go.
      if (u && !u.email_verified_at) { await q(`update users set pw_hash = null where id = $1`, [u.id]); await q(`delete from sessions where user_id = $1`, [u.id]); }
    }
    let orgId = null;
    if (u) await q(`update users set google_sub = coalesce(google_sub, $2), email_verified_at = coalesce(email_verified_at, now()), last_login_at = now() where id = $1`, [u.id, g.sub]);
    else {
      if (invite && normEmail(invite.email) !== g.email) return back(`This invite is for ${invite.email}, but you signed in to Google as ${g.email}.`);
      if (!invite && process.env.ACCESS_CODE) return back(`New accounts need an invite. Ask your admin to invite ${g.email}.`);
      if (invite) {
        try { ({ u, orgId } = await tx(async (c) => { const u = (await c.query(`insert into users (email, name, google_sub, email_verified_at, last_login_at) values ($1, $2, $3, now(), now()) returning id, email, name`, [g.email, g.name, g.sub])).rows[0]; return { u, orgId: (await O.acceptInvite(invite, u, c)).orgId }; })); }
        catch (e) { return back(e.message); }
      } else {
        u = await one(`insert into users (email, name, google_sub, email_verified_at, last_login_at) values ($1, $2, $3, now(), now()) returning id, email, name`, [g.email, g.name, g.sub]);
        orgId = (await O.createOrg({ name: personalOrgName(u), by: u.id, allowPlatformKeys: platformKeysForSignups() })).id;
      }
    }
    if (invite && !orgId) { try { orgId = (await O.acceptInvite(invite, u)).orgId; } catch (e) { return back(e.message); } }
    const sc = await startSession(req, u.id, orgId);
    res.writeHead(302, { location: "/", "cache-control": "no-store", "set-cookie": [sc, clear] }); res.end();
  }],
  ["GET", "/api/me", async (req, res) => {
    const u = await currentUser(req); if (!u) return sendJson(res, 200, { user: null });
    sendJson(res, 200, await meOut(u));
  }],

  // ── organisations ──
  ["GET", "/api/orgs", async (req, res) => { sendJson(res, 200, await meOut(await needUser(req))); }],
  // New organisations: platform operators (for clients), or anyone when ORG_CREATION=open. With ownerEmail, the
  // operator becomes an admin and the client's owner gets an invite.
  ["POST", "/api/orgs", async (req, res) => {
    const u = await needUser(req); const b = await readJson(req, 20000);
    const operator = O.isOperator(u);
    if (!operator && process.env.ORG_CREATION !== "open") fail(403, "Only the White Petal team can create organisations. Ask for an invite instead.");
    const name = String(b.name || "").trim(); if (name.length < 2) fail(400, "Give the organisation a name.");
    const ownerEmail = b.ownerEmail ? normEmail(b.ownerEmail) : null;
    if (ownerEmail && !emailOk(ownerEmail)) fail(400, "Enter a valid email for the owner.");
    const selfOwner = !ownerEmail || ownerEmail === normEmail(u.email);
    const org = await O.createOrg({ name, by: u.id, role: selfOwner ? "owner" : "admin", allowPlatformKeys: operator && !!b.allowPlatformKeys });
    await O.audit(org.id, u.id, "org.created", org.name, { owner: ownerEmail || u.email });
    const invite = selfOwner ? null : await sendInvite(req, u, org, ownerEmail, "owner");
    await setSessionOrg(u, org.id);
    sendJson(res, 200, { created: { slug: org.slug, name: org.name }, invite, ...(await meOut({ ...u, session_org: org.id })) });
  }],
  ["POST", "/api/orgs/:org/switch", async (req, res, p) => {
    const u = await needUser(req);
    const o = await one(`select id from organizations where slug = $1`, [p.org]);
    const m = o && (await one(`select role from memberships where org_id = $1 and user_id = $2`, [o.id, u.id]));
    if (!o || (!m && !O.isOperator(u))) fail(404, "That organisation doesn't exist, or you're not in it.");
    await setSessionOrg(u, o.id);
    if (!m) await O.audit(o.id, u.id, "operator.visit", u.email);
    sendJson(res, 200, await meOut({ ...u, session_org: o.id }));
  }],
  ["GET", "/api/admin/orgs", async (req, res) => {
    const u = await needUser(req); if (!O.isOperator(u)) fail(404, "Not found");
    const orgs = await q(`select o.slug, o.name, o.allow_platform_keys, o.monthly_cap_usd, o.created_at,
        (select count(*)::int from memberships m where m.org_id = o.id) as members,
        (select count(*)::int from workspaces w where w.org_id = o.id) as brands,
        (select u.email from memberships m join users u on u.id = m.user_id where m.org_id = o.id and m.role = 'owner') as owner,
        (select round(coalesce(sum(cost_usd), 0)::numeric, 2)::float from usage x where x.org_id = o.id and x.at >= date_trunc('month', now())) as spent
      from organizations o order by o.created_at desc limit 500`);
    sendJson(res, 200, { orgs });
  }],

  // The current organisation: people, invites, keys, budget and usage.
  ["GET", "/api/org", async (req, res) => {
    const ctx = await needCtx(req, "viewer"); const id = ctx.org.id, admin = O.can(ctx.role, "admin");
    const o = await one(`select slug, name, monthly_cap_usd, allow_platform_keys, created_at from organizations where id = $1`, [id]);
    sendJson(res, 200, {
      org: { slug: o.slug, name: o.name, role: ctx.role, operatorVisit: ctx.operatorVisit, monthlyCapUsd: o.monthly_cap_usd == null ? null : Number(o.monthly_cap_usd), allowPlatformKeys: o.allow_platform_keys, createdAt: o.created_at },
      me: ctx.user.id, operator: ctx.operator,
      members: await O.members(id),
      invites: admin ? await O.pendingInvites(id) : [],
      keys: admin ? O.keyStatus(await O.orgKeys(id)) : null,
      usage: admin ? await O.usageSummary(id) : { cap: await O.capState(id) },
    });
  }],
  ["PATCH", "/api/org", async (req, res) => {
    const ctx = await needCtx(req, "admin"); const b = await readJson(req, 20000); const changes = {};
    if (b.name != null) { const n = String(b.name).trim(); if (n.length < 2) fail(400, "Give the organisation a name."); changes.name = n.slice(0, 80); }
    if ("monthlyCapUsd" in b) { const v = b.monthlyCapUsd === null || b.monthlyCapUsd === "" ? null : Number(b.monthlyCapUsd); if (v != null && (!Number.isFinite(v) || v < 0 || v > 100000)) fail(400, "Enter a monthly budget in dollars, or leave it empty for no limit."); changes.monthly_cap_usd = v; }
    if ("allowPlatformKeys" in b) { if (!ctx.operator) fail(403, "Only the White Petal team can change this."); changes.allow_platform_keys = !!b.allowPlatformKeys; }
    const keys = Object.keys(changes);
    if (keys.length) {
      await q(`update organizations set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() where id = $1`, [ctx.org.id, ...keys.map((k) => changes[k])]);
      await O.audit(ctx.org.id, ctx.user.id, "org.updated", null, changes);
    }
    sendJson(res, 200, { ok: true });
  }],
  ["PUT", "/api/org/keys", async (req, res) => {
    const ctx = await needCtx(req, "admin"); const b = await readJson(req, 20000);
    const changed = await O.setKeys(ctx.org.id, b.keys || {});
    if (changed.length) await O.audit(ctx.org.id, ctx.user.id, "keys.changed", changed.join(", "));
    sendJson(res, 200, { keys: O.keyStatus(await O.orgKeys(ctx.org.id)), changed });
  }],
  ["POST", "/api/org/invitations", async (req, res) => {
    const ctx = await needCtx(req, "admin"); const b = await readJson(req, 20000);
    const email = normEmail(b.email), role = String(b.role || "viewer");
    if (!emailOk(email)) fail(400, "Enter a valid email address.");
    if (!roleOk(role)) fail(400, "Pick a role: admin, editor or viewer.");
    if (role === "owner") {
      const hasOwner = await one(`select 1 from memberships where org_id = $1 and role = 'owner'`, [ctx.org.id]);
      if (hasOwner || !ctx.operator) fail(403, "An organisation has one owner. The owner can hand over ownership from the member list.");
    }
    if (await one(`select 1 from memberships m join users u on u.id = m.user_id where m.org_id = $1 and u.email = $2`, [ctx.org.id, email])) fail(409, `${email} is already in this organisation.`);
    if (limited("invite:" + ctx.org.id, 30, 3600e3)) fail(429, "That's a lot of invites in an hour. Try again later.");
    sendJson(res, 200, { invite: await sendInvite(req, ctx.user, ctx.org, email, role), invites: await O.pendingInvites(ctx.org.id) });
  }],
  ["DELETE", "/api/org/invitations/:id", async (req, res, p) => {
    const ctx = await needCtx(req, "admin");
    const r = await one(`update invitations set revoked_at = now() where id::text = $2 and org_id = $1 and accepted_at is null and revoked_at is null returning email`, [ctx.org.id, p.id]);
    if (r) await O.audit(ctx.org.id, ctx.user.id, "invite.revoked", r.email);
    sendJson(res, 200, { invites: await O.pendingInvites(ctx.org.id) });
  }],
  ["PATCH", "/api/org/members/:id", async (req, res, p) => {
    const ctx = await needCtx(req, "admin"); const b = await readJson(req, 5000); const role = String(b.role || "");
    if (!roleOk(role)) fail(400, "Unknown role.");
    // In one transaction with both memberships locked, so a removal racing a hand-over can't leave no owner.
    await tx(async (c) => {
      const m = (await c.query(`select m.role, u.email from memberships m join users u on u.id = m.user_id where m.org_id = $1 and m.user_id::text = $2 for update of m`, [ctx.org.id, p.id])).rows[0];
      if (!m) fail(404, "That person isn't in this organisation.");
      if (m.role === role) return;
      if (role === "owner") {
        // Handing over ownership: only the owner, and they stay on as an admin.
        if (ctx.role !== "owner" || ctx.operatorVisit) fail(403, "Only the owner can hand over ownership.");
        const me = (await c.query(`select role from memberships where org_id = $1 and user_id = $2 for update`, [ctx.org.id, ctx.user.id])).rows[0];
        if (me?.role !== "owner") fail(403, "Only the owner can hand over ownership.");
        await c.query(`update memberships set role = 'admin' where org_id = $1 and user_id = $2`, [ctx.org.id, ctx.user.id]);
        await c.query(`update memberships set role = 'owner' where org_id = $1 and user_id::text = $2`, [ctx.org.id, p.id]);
        await c.query(`insert into audit_log (org_id, user_id, action, target) values ($1, $2, 'owner.transferred', $3)`, [ctx.org.id, ctx.user.id, m.email]);
      } else {
        if (m.role === "owner") fail(403, "The owner's role can't be changed. The owner can hand over ownership first.");
        if (p.id === ctx.user.id) fail(403, "Ask another admin to change your role.");
        await c.query(`update memberships set role = $3 where org_id = $1 and user_id::text = $2`, [ctx.org.id, p.id, role]);
        await c.query(`insert into audit_log (org_id, user_id, action, target, detail) values ($1, $2, 'role.changed', $3, $4)`, [ctx.org.id, ctx.user.id, m.email, { from: m.role, to: role }]);
      }
    });
    sendJson(res, 200, { members: await O.members(ctx.org.id) });
  }],
  // Remove someone (admin), or leave (anyone but the owner). Their sessions stop working in this organisation at once.
  ["DELETE", "/api/org/members/:id", async (req, res, p) => {
    const self = (await needUser(req)).id === p.id;
    const ctx = await needCtx(req, self ? "viewer" : "admin");
    // Deleted only if they are not the owner at that moment (a hand-over may have just happened).
    const m = await one(`delete from memberships m using users u where u.id = m.user_id and m.org_id = $1 and m.user_id::text = $2 and m.role <> 'owner' returning m.role, u.email`, [ctx.org.id, p.id]);
    if (!m) {
      const still = await one(`select role from memberships where org_id = $1 and user_id::text = $2`, [ctx.org.id, p.id]);
      fail(still ? 403 : 404, still ? "The owner can't be removed. Hand over ownership first." : "That person isn't in this organisation.");
    }
    await q(`update sessions set org_id = null where org_id = $1 and user_id::text = $2`, [ctx.org.id, p.id]);
    await O.audit(ctx.org.id, ctx.user.id, self ? "member.left" : "member.removed", m.email, { role: m.role });
    sendJson(res, 200, self ? { left: true } : { members: await O.members(ctx.org.id) });
  }],
  ["GET", "/api/org/audit", async (req, res) => {
    const ctx = await needCtx(req, "admin");
    sendJson(res, 200, { log: await O.auditLog(ctx.org.id) });
  }],
  // Invite links: what it is (public, so the page can say who invited you), and accepting it once signed in.
  ["GET", "/api/invitations/:token", async (req, res, p) => {
    needDb();
    if (limited("invlook:" + clientIp(req), 30)) fail(429, "Too many requests.");
    const inv = await O.findInvite(p.token);
    if (!inv) fail(404, "This invite link has expired or was already used. Ask for a new one.");
    const account = !!(await one(`select 1 from users where email = $1`, [normEmail(inv.email)]));
    sendJson(res, 200, { org: inv.org_name, email: inv.email, role: inv.role, inviter: inv.inviter_name || inv.inviter_email, account, expiresAt: inv.expires_at });
  }],
  ["POST", "/api/invitations/:token/accept", async (req, res, p) => {
    const u = await needUser(req);
    const inv = await O.findInvite(p.token);
    if (!inv) fail(404, "This invite link has expired or was already used. Ask for a new one.");
    const r = await O.acceptInvite(inv, u);
    await setSessionOrg(u, r.orgId);
    sendJson(res, 200, await meOut({ ...u, session_org: r.orgId }));
  }],

  // ── brands ──
  // Brands in the current organisation, with their recent trend, for the switcher and the brand list.
  ["GET", "/api/workspaces", async (req, res) => {
    const ctx = await needCtx(req, "viewer");
    const rows = await q(`select w.*, (select coalesce(json_agg(t order by t.started_at), '[]') from (select id, started_at, source, summary from runs r where r.workspace_id = w.id and r.status = 'done' order by r.started_at desc limit 12) t) as trend
                           from workspaces w where org_id = $1 order by updated_at desc`, [ctx.org.id]);
    sendJson(res, 200, { workspaces: rows.map((w) => wsOut(w, { trend: w.trend, setup: w.setup })), org: O.orgOut(ctx) });
  }],
  ["PUT", "/api/workspaces/:slug", async (req, res, p) => {
    const ctx = await needCtx(req, "editor"); const b = await readJson(req);
    const slug = slugify(p.slug), name = String(b.name || b.setup?.profile?.name || slug).slice(0, 120);
    const setup = b.setup || {};
    const w = await one(`insert into workspaces (org_id, owner_id, slug, name, site, setup) values ($1, $2, $3, $4, $5, $6)
      on conflict (org_id, slug) do update set name = excluded.name, site = excluded.site, setup = excluded.setup, updated_at = now() returning *`, [ctx.org.id, ctx.user.id, slug, name, b.site || setup.profile?.site || null, setup]);
    sendJson(res, 200, { workspace: wsOut(w, { setup: w.setup }) });
  }],
  ["PATCH", "/api/workspaces/:slug", async (req, res, p) => {
    const ctx = await needCtx(req, "editor"); const w = await needWorkspace(ctx, p.slug); const b = await readJson(req, 200000);
    // Move a brand to another organisation (for example from your own into a client's): admin on both sides.
    if (b.moveTo) {
      O.needRole(ctx, "admin");
      const to = await one(`select id, slug, name from organizations where slug = $1`, [String(b.moveTo)]);
      const mine = to && (await one(`select role from memberships where org_id = $1 and user_id = $2`, [to.id, ctx.user.id]));
      if (!to || !((mine && O.can(mine.role, "admin")) || ctx.operator)) fail(403, "You need to be an admin in the organisation you're moving it to.");
      if (await one(`select 1 from workspaces where org_id = $1 and slug = $2`, [to.id, w.slug])) fail(409, `${to.name} already has a brand called ${w.slug}.`);
      await q(`update workspaces set org_id = $2, updated_at = now() where id = $1`, [w.id, to.id]);
      await O.audit(ctx.org.id, ctx.user.id, "brand.moved_out", w.name, { to: to.slug });
      await O.audit(to.id, ctx.user.id, "brand.moved_in", w.name, { from: ctx.org.slug });
      return sendJson(res, 200, { moved: { slug: w.slug, to: to.slug } });
    }
    const schedule = ["off", "daily", "weekly"].includes(b.schedule) ? b.schedule : w.schedule;
    const samples = b.samples != null ? Math.max(1, Math.min(5, Number(b.samples) || 1)) : w.samples;
    const setup = b.setup ? { ...w.setup, ...b.setup } : w.setup;
    // A new or changed schedule starts from now: the next run is one period away, or "soon" if asked (runNow).
    const next = b.runNow ? new Date() : schedule === w.schedule && w.next_run_at ? w.next_run_at : nextRun(schedule);
    const out = await one(`update workspaces set schedule = $2, samples = $3, setup = $4, next_run_at = $5, name = coalesce($6, name), updated_at = now() where id = $1 returning *`,
      [w.id, schedule, samples, setup, schedule === "off" && !b.runNow ? null : next, b.name || null]);
    if (b.runNow) await O.audit(ctx.org.id, ctx.user.id, "check.queued", w.name);
    sendJson(res, 200, { workspace: wsOut(out, { setup: out.setup }) });
  }],
  ["DELETE", "/api/workspaces/:slug", async (req, res, p) => {
    const ctx = await needCtx(req, "admin"); const w = await needWorkspace(ctx, p.slug, "admin");
    await q(`delete from workspaces where id = $1`, [w.id]);
    await O.audit(ctx.org.id, ctx.user.id, "brand.deleted", w.name);
    sendJson(res, 200, { ok: true });
  }],

  // Runs: the browser saves its live run as it goes; scheduled runs arrive from the tick.
  ["GET", "/api/workspaces/:slug/runs", async (req, res, p) => {
    const ctx = await needCtx(req, "viewer"); const w = await needWorkspace(ctx, p.slug);
    const runs = await q(`select id, source, status, started_at, finished_at, summary, error from runs where workspace_id = $1 order by started_at desc limit 60`, [w.id]);
    sendJson(res, 200, { runs });
  }],
  ["GET", "/api/workspaces/:slug/runs/latest", async (req, res, p) => {
    const ctx = await needCtx(req, "viewer"); const w = await needWorkspace(ctx, p.slug);
    const r = await one(`select id, source, status, data from runs where workspace_id = $1 and data is not null order by (status = 'done') desc, started_at desc limit 1`, [w.id]);
    const prev = r ? await one(`select data from runs where workspace_id = $1 and status = 'done' and id <> $2 and data is not null order by started_at desc limit 1`, [w.id, r.id]) : null;
    sendJson(res, 200, { run: r?.data || null, status: r?.status || null, prev: prev?.data || null });
  }],
  ["GET", "/api/runs/:id", async (req, res, p) => {
    const ctx = await needCtx(req, "viewer");
    const r = await one(`select r.data, r.status from runs r join workspaces w on w.id = r.workspace_id where r.id = $1 and w.org_id = $2`, [p.id, ctx.org.id]);
    if (!r) fail(404, "Run not found."); sendJson(res, 200, { run: r.data, status: r.status });
  }],
  ["PUT", "/api/runs/:id", async (req, res, p) => {
    const ctx = await needCtx(req, "editor"); const b = await readJson(req, 12 * 1024 * 1024);
    const w = await needWorkspace(ctx, slugify(b.slug || b.data?.slug), "editor");
    const data = b.data || {}; const status = data.finishedAt ? "done" : b.status === "stopped" ? "stopped" : "running";
    const owner = await one(`select workspace_id from runs where id = $1`, [p.id]);
    if (owner && owner.workspace_id !== w.id) fail(409, "That run id belongs to another brand.");
    await q(`insert into runs (id, workspace_id, source, status, started_at, finished_at, summary, data, started_by, updated_at)
             values ($1, $2, 'live', $3, to_timestamp($4 / 1000.0), $5, $6, $7, $8, now())
             on conflict (id) do update set status = excluded.status, finished_at = excluded.finished_at, summary = excluded.summary, data = excluded.data, updated_at = now()`,
      [p.id, w.id, status, data.startedAt || Date.now(), data.finishedAt ? new Date(data.finishedAt) : null, status === "done" ? summarize(data) : null, data, ctx.user.id]);
    if (status === "done") await q(`update workspaces set last_run_at = now(), updated_at = now(), next_run_at = case when schedule <> 'off' then now() + case schedule when 'daily' then interval '1 day' else interval '7 days' end else null end where id = $1`, [w.id]);
    sendJson(res, 200, { ok: true, status });
  }],

  // Integrations, per brand. Connecting and disconnecting is for admins; refreshing and submitting for editors.
  ["GET", "/api/workspaces/:slug/integrations", async (req, res, p) => {
    const ctx = await needCtx(req, "viewer"); const w = await needWorkspace(ctx, p.slug);
    sendJson(res, 200, { integrations: await integrationsFor(w), platform: { serp: !!(await O.withOrgKeys(ctx.org.id, () => serpConfig())), googleOAuth: !!process.env.GOOGLE_OAUTH_CLIENT_ID } });
  }],
  ["PUT", "/api/workspaces/:slug/integrations/:provider", async (req, res, p) => {
    const ctx = await needCtx(req, "admin"); const w = await needWorkspace(ctx, p.slug, "admin"); const mod = getProvider(p.provider);
    if (!mod || p.provider === "serp") fail(404, "Unknown integration.");
    const b = await readJson(req, 50000);
    const prev = (await integrationCfg(w, p.provider))?.cfg || {};
    const cfg = { ...prev };
    for (const f of mod.meta.fields) if (b[f.key] != null && String(b[f.key]).trim() !== "") cfg[f.key] = String(b[f.key]).trim();
    if (p.provider === "indexnow") { const { ensureKey } = await import("./integrations/indexnow.mjs"); ensureKey(cfg); }
    const t = await mod.test(cfg, ctxFor(w));
    if (t.key && !cfg.key) cfg.key = t.key;
    await saveIntegration(w, p.provider, cfg, { status: t.ok ? "connected" : "error", detail: t.detail });
    await O.audit(ctx.org.id, ctx.user.id, "integration.saved", `${w.name}: ${p.provider}`, { ok: t.ok });
    let data = null; if (t.ok && p.provider !== "slack") data = await collectOne(w, p.provider).catch(() => null);
    sendJson(res, 200, { ok: t.ok, detail: t.detail, data, integrations: await integrationsFor(w) });
  }],
  ["DELETE", "/api/workspaces/:slug/integrations/:provider", async (req, res, p) => {
    const ctx = await needCtx(req, "admin"); const w = await needWorkspace(ctx, p.slug, "admin");
    await q(`delete from integrations where workspace_id = $1 and provider = $2`, [w.id, p.provider]);
    await O.audit(ctx.org.id, ctx.user.id, "integration.removed", `${w.name}: ${p.provider}`);
    sendJson(res, 200, { integrations: await integrationsFor(w) });
  }],
  ["POST", "/api/workspaces/:slug/integrations/:provider/collect", async (req, res, p) => {
    const ctx = await needCtx(req, "editor"); const w = await needWorkspace(ctx, p.slug, "editor");
    sendJson(res, 200, { data: await collectOne(w, p.provider), integrations: await integrationsFor(w) });
  }],
  // Push changed pages to Bing (and so ChatGPT search) right away: IndexNow and/or Bing's URL submission.
  ["POST", "/api/workspaces/:slug/integrations/:provider/submit", async (req, res, p) => {
    const ctx = await needCtx(req, "editor"); const w = await needWorkspace(ctx, p.slug, "editor"); const b = await readJson(req, 200000);
    if (!["indexnow", "bing"].includes(p.provider)) fail(400, "This tool can't submit URLs.");
    const got = await integrationCfg(w, p.provider); if (!got) fail(404, "Not connected.");
    const urls = (b.urls || []).map(String).filter((x) => /^https?:\/\//.test(x)).slice(0, 500);
    if (!urls.length) fail(400, "No URLs to submit.");
    const r = await getProvider(p.provider).submitUrls(got.cfg, urls, ctxFor(w));
    if (p.provider === "indexnow") { got.cfg.lastSubmit = r; await saveIntegration(w, "indexnow", got.cfg); }
    sendJson(res, 200, r);
  }],
  ["POST", "/api/workspaces/:slug/integrations/google/properties", async (req, res, p) => {
    const ctx = await needCtx(req, "admin"); const w = await needWorkspace(ctx, p.slug, "admin");
    const got = await integrationCfg(w, "google"); if (!got) fail(404, "Connect Google first.");
    const props = await google.listProperties(got.cfg, ctxFor(w, { onToken: async (t) => { Object.assign(got.cfg, t); await saveIntegration(w, "google", got.cfg); } }));
    sendJson(res, 200, props);
  }],

  // Google OAuth (Search Console + GA4). The state row ties the callback to this user and brand, once.
  ["GET", "/api/oauth/google/start", async (req, res, p, url) => {
    const ctx = await needCtx(req, "admin"); const w = await needWorkspace(ctx, url.searchParams.get("ws") || "", "admin");
    if (!process.env.GOOGLE_OAUTH_CLIENT_ID) fail(400, "Google sign-in isn't configured on this server (GOOGLE_OAUTH_CLIENT_ID).");
    const state = randomId(18);
    await q(`insert into oauth_states (state, user_id, workspace_id) values ($1, $2, $3)`, [state, ctx.user.id, w.id]);
    await q(`delete from oauth_states where created_at < now() - interval '1 hour'`);
    redirect(res, google.oauthUrl({ clientId: process.env.GOOGLE_OAUTH_CLIENT_ID, redirectUri: `${origin(req)}/api/oauth/google/callback`, state }));
  }],
  ["GET", "/api/oauth/google/callback", async (req, res, p, url) => {
    const u = await needUser(req);
    const st = await one(`delete from oauth_states where state = $1 and user_id = $2 and created_at > now() - interval '1 hour' returning workspace_id`, [url.searchParams.get("state") || "", u.id]);
    if (!st) fail(400, "This Google sign-in link expired. Start again from Settings.");
    const w = await one(`select * from workspaces where id = $1`, [st.workspace_id]);
    // Still an admin of that brand's organisation? (Someone removed while the Google screen was open is not.)
    const m = w && (await one(`select role from memberships where org_id = $1 and user_id = $2`, [w.org_id, u.id]));
    if (!w || !((m && O.can(m.role, "admin")) || O.isOperator(u))) fail(403, "Only an admin of this brand's organisation can connect Google.");
    if (url.searchParams.get("error")) return redirect(res, `/#settings/${w.slug}?google=denied`);
    const tok = await google.exchangeCode({ clientId: process.env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri: `${origin(req)}/api/oauth/google/callback`, code: url.searchParams.get("code") || "" });
    await saveIntegration(w, "google", tok, { status: "connected", detail: `Signed in as ${tok.email || "Google user"}. Choose your properties.` });
    await O.audit(w.org_id, u.id, "integration.saved", `${w.name}: google`, { ok: true });
    redirect(res, `/#settings/${w.slug}?google=connected`);
  }],

  // Live checks the browser pipeline needs from the server (keys stay server-side, the organisation's own).
  ["POST", "/api/serp/organic", async (req, res) => {
    const ctx = await aiContext(req, "editor");
    const run = async () => {
      const cfg = serpConfig(); if (!cfg) fail(400, "Google rank checks need a DataForSEO login or a SerpApi key (Team & keys).");
      const b = await readJson(req, 20000);
      const query = String(b.query || "").slice(0, 300); if (!query) fail(400, "No query.");
      const r = await serp.organic({ ...cfg, locationName: b.market && !/global/i.test(b.market) ? b.market : undefined }, query);
      if (ctx) await O.meter({ orgId: ctx.org.id, workspaceId: ctx.workspaceId, userId: ctx.user.id, kind: "serp" });
      sendJson(res, 200, { query, results: r.results || [] });
    };
    return ctx ? O.withOrgKeys(ctx.org.id, run) : run();
  }],
  ["POST", "/api/entity", async (req, res) => {
    const ctx = await aiContext(req, "editor");
    const b = await readJson(req, 100000);
    const run = async () => sendJson(res, 200, await entity.collect({ googleApiKey: env("GOOGLE_API_KEY") }, { brand: String(b.name || ""), host: hostOf(b.site || ""), site: b.site, orgSchema: b.orgSchema }));
    return ctx ? O.withOrgKeys(ctx.org.id, run) : run();
  }],

  // Cloud Scheduler → here, every 10 minutes, with the shared secret. Runs due brands before answering (see tick()).
  ["POST", "/api/cron/tick", async (req, res) => {
    if (!process.env.CRON_SECRET || !safeEqual(req.headers["x-cron-secret"], process.env.CRON_SECRET)) fail(401, "Bad cron secret.");
    if (!hasDb()) fail(400, "No database.");
    sendJson(res, 200, { ran: await tick() });
  }],
];
