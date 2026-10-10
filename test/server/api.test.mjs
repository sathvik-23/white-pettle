// The real HTTP app against a real Postgres. Skipped unless TEST_DATABASE_URL is set (CI sets it; see ci.yml).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { fakes, WS } from "./_fake.mjs";

const DB = process.env.TEST_DATABASE_URL;
let app, base;
const jar = {};
const mails = [];
async function call(who, method, path, body, headers = {}) {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(jar[who] ? { cookie: jar[who] } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  const set = r.headers.get("set-cookie"); if (set) jar[who] = set.split(";")[0];
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

before(async () => {
  if (!DB) return;
  const c = new pg.Client({ connectionString: DB }); await c.connect(); await c.query("drop schema if exists whitepetal cascade"); await c.end();
  Object.assign(process.env, { DATABASE_URL: DB, CRON_SECRET: "tick-secret", APP_SECRET: "test", OPENAI_API_KEY: "fake", GEMINI_API_KEY: "fake", ACCESS_CODE: "", PLATFORM_OPERATORS: "op@x.co, boss@x.co", RESEND_API_KEY: "" });
  (await import("../../server/mail.mjs")).setSender(async (m) => { mails.push(m); return { sent: true }; });
  (await import("../../server/runner.mjs")).setHandlers(fakes);
  app = await (await import("../../server/app.mjs")).start({ port: 0, quiet: true });
  base = `http://127.0.0.1:${app.port}`;
});
after(async () => { if (app) await app.stop(); });

test("accounts, brands, runs, schedules and isolation", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  assert.equal((await call("a", "GET", "/api/health")).data.db, true);
  assert.equal((await call("a", "POST", "/api/auth/signup", { email: "a@x.co", password: "short" })).status, 400);
  assert.equal((await call("a", "POST", "/api/auth/signup", { email: "a@x.co", password: "longenough1" })).status, 200);
  assert.equal((await call("a", "POST", "/api/auth/signup", { email: "A@x.co", password: "longenough1" })).status, 409);
  assert.equal((await call("a", "GET", "/api/me")).data.user.email, "a@x.co");
  // billing migration: existing and new organisations stay on unrestricted legacy access until deliberately moved
  const [billingOrg] = await sql(`select plan_code, billing_status from organizations where slug = $1`, [(await call("a", "GET", "/api/me")).data.org.slug]);
  assert.deepEqual(billingOrg, { plan_code: "legacy", billing_status: "internal" });

  assert.equal((await call("a", "PUT", "/api/workspaces/acme", { name: WS.name, site: WS.site, setup: WS.setup })).status, 200);
  const pat = await call("a", "PATCH", "/api/workspaces/acme", { schedule: "weekly", samples: 2, runNow: true });
  assert.equal(pat.data.workspace.schedule, "weekly"); assert.equal(pat.data.workspace.samples, 2);

  // someone else cannot see or touch it
  await call("b", "POST", "/api/auth/signup", { email: "b@x.co", password: "longenough2" });
  assert.equal((await call("b", "GET", "/api/workspaces/acme/runs")).status, 404);
  assert.equal((await call("b", "GET", "/api/workspaces")).data.workspaces.length, 0);

  // the scheduler: wrong secret refused, right secret runs the due brand end to end
  assert.equal((await call("x", "POST", "/api/cron/tick", null, { "x-cron-secret": "nope" })).status, 401);
  const t = await call("x", "POST", "/api/cron/tick", null, { "x-cron-secret": "tick-secret" });
  assert.equal(t.status, 200); assert.equal(t.data.ran.length, 1); assert.equal(t.data.ran[0].slug, "acme");
  const runs = (await call("a", "GET", "/api/workspaces/acme/runs")).data.runs;
  assert.equal(runs[0].source, "scheduled"); assert.equal(runs[0].status, "done"); assert.ok(runs[0].summary.n > 0);
  const latest = (await call("a", "GET", "/api/workspaces/acme/runs/latest")).data;
  assert.equal(Object.keys(latest.run.answers).length, 2 * 2 * 2);
  const ws = (await call("a", "GET", "/api/workspaces")).data.workspaces[0];
  assert.ok(new Date(ws.nextRunAt) > Date.now() + 6 * 864e5); // next week
  assert.equal(ws.trend.length, 1);
  // nothing due now, so a second tick does nothing
  assert.equal((await call("x", "POST", "/api/cron/tick", null, { "x-cron-secret": "tick-secret" })).data.ran.length, 0);

  // a live run saved by the browser
  const live = { id: "live1", slug: "acme", startedAt: Date.now(), finishedAt: Date.now(), profile: WS.setup.profile, answers: { "q1|chatgpt": { status: "yes", named: true, rank: 1, engine: "chatgpt", brands: ["Acme AI"] } } };
  assert.equal((await call("a", "PUT", "/api/runs/live1", { slug: "acme", data: live })).data.status, "done");
  assert.equal((await call("b", "GET", "/api/runs/live1")).status, 404);
  assert.equal((await call("b", "PUT", "/api/runs/live1", { slug: "acme", data: live })).status, 404);

  // integrations listing hides the platform-level SERP account and marks Google unavailable without OAuth keys
  const ints = (await call("a", "GET", "/api/workspaces/acme/integrations")).data.integrations;
  assert.ok(ints.find((i) => i.id === "bing")); assert.ok(!ints.find((i) => i.id === "serp"));
  assert.equal(ints.find((i) => i.id === "google").available, false);

  // AI routes need a session
  assert.equal((await call("nobody", "POST", "/api/ask", { engine: "chatgpt", question: "x" })).status, 401);
  assert.equal((await call("a", "POST", "/api/auth/logout")).status, 200);
  assert.equal((await call("a", "GET", "/api/me")).data.user, null);
  assert.equal((await call("a", "DELETE", "/api/workspaces/acme")).status, 401);
});

// ── organisations: a client organisation run by the operator, with an owner, editors and viewers ──
const tokenFrom = (link) => decodeURIComponent(String(link).split("#invite=")[1] || String(link).split("#reset=")[1] || "");
async function sql(text, params) { const c = new pg.Client({ connectionString: DB }); await c.connect(); try { await c.query("set search_path to whitepetal, public"); return (await c.query(text, params)).rows; } finally { await c.end(); } }

test("organisations: invites, roles, own keys, budget, scheduler, audit", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  // The operator signs up (gets a personal organisation on the platform keys) and creates a client organisation for Rahul.
  // Typing an operator's address at sign-up gives nothing until the address is proved.
  assert.equal((await call("evil", "POST", "/api/auth/signup", { email: "boss@x.co", password: "evil-pass-123" })).status, 200);
  assert.equal((await call("evil", "GET", "/api/config")).data.operator, false);
  assert.equal((await call("evil", "GET", "/api/admin/orgs")).status, 404);
  assert.equal((await call("evil", "POST", "/api/orgs", { name: "Grab" })).status, 403);
  assert.equal((await call("op", "POST", "/api/auth/signup", { email: "op@x.co", password: "operator-pass1", name: "Sathvik" })).status, 200);
  assert.equal((await call("op", "GET", "/api/config")).data.operator, false);
  const verify = mails.filter((m) => m.to === "op@x.co").at(-1);
  assert.match(verify.text, /#verify=/);
  assert.equal((await call("op", "POST", "/api/auth/verify", { token: verify.text.match(/#verify=([\w-]+)/)[1] })).status, 200);
  assert.equal((await call("op", "POST", "/api/auth/verify", { token: verify.text.match(/#verify=([\w-]+)/)[1] })).status, 400); // once
  let cfg = (await call("op", "GET", "/api/config")).data;
  assert.equal(cfg.user.verified, true);
  assert.equal(cfg.operator, true); assert.deepEqual(cfg.engines.sort(), ["chatgpt", "gemini"]); // platform keys
  const made = await call("op", "POST", "/api/orgs", { name: "AI Xccelerate", ownerEmail: "rahul@ax.co" });
  assert.equal(made.status, 200); assert.equal(made.data.org.slug, "ai-xccelerate"); assert.equal(made.data.org.role, "admin");
  assert.ok(made.data.invite.link.includes("#invite=")); assert.equal(mails.at(-1).to, "rahul@ax.co");
  cfg = (await call("op", "GET", "/api/config")).data;
  assert.deepEqual(cfg.engines, []); // a client organisation brings its own keys; the platform's are not used
  // Nobody else may create organisations
  await call("b2", "POST", "/api/auth/signup", { email: "b2@x.co", password: "longenough3" });
  assert.equal((await call("b2", "POST", "/api/orgs", { name: "Mine" })).status, 403);

  // Rahul opens the link, sees what it is, signs up with it and is the owner.
  const rToken = tokenFrom(made.data.invite.link);
  const look = await call("anon", "GET", "/api/invitations/" + rToken);
  assert.equal(look.data.org, "AI Xccelerate"); assert.equal(look.data.role, "owner"); assert.equal(look.data.account, false);
  assert.equal((await call("rahul", "POST", "/api/auth/signup", { email: "someone@else.co", password: "rahul-pass-1", invite: rToken })).status, 403); // wrong email
  assert.equal((await call("rahul", "POST", "/api/auth/signup", { email: "rahul@ax.co", password: "rahul-pass-1", name: "Rahul", invite: rToken })).status, 200);
  let me = (await call("rahul", "GET", "/api/me")).data;
  assert.equal(me.org.slug, "ai-xccelerate"); assert.equal(me.org.role, "owner"); assert.equal(me.orgs.length, 1);
  assert.equal((await call("anon", "GET", "/api/invitations/" + rToken)).status, 404); // used once

  // Rahul invites two marketers (editors) and a viewer.
  for (const [who, role] of [["m1", "editor"], ["m2", "editor"], ["v1", "viewer"]]) {
    const inv = await call("rahul", "POST", "/api/org/invitations", { email: `${who}@ax.co`, role });
    assert.equal(inv.status, 200); assert.equal(inv.data.invite.role, role);
    assert.equal((await call(who, "POST", "/api/auth/signup", { email: `${who}@ax.co`, password: "member-pass-1", invite: tokenFrom(inv.data.invite.link) })).status, 200);
  }
  assert.equal((await call("rahul", "POST", "/api/org/invitations", { email: "m1@ax.co", role: "viewer" })).status, 409); // already in
  assert.equal((await call("m1", "POST", "/api/org/invitations", { email: "z@ax.co", role: "viewer" })).status, 403); // editors can't invite
  const team = (await call("v1", "GET", "/api/org")).data;
  assert.equal(team.members.length, 5); assert.equal(team.keys, null); assert.deepEqual(team.invites, []); // viewers don't see keys or invites

  // Brands: editors create and change, viewers only read, deleting is for admins.
  assert.equal((await call("m1", "PUT", "/api/workspaces/aix", { name: "AI Xccelerate", site: "https://aixccelerate.com", setup: WS.setup })).status, 200);
  assert.equal((await call("v1", "GET", "/api/workspaces")).data.workspaces.length, 1);
  assert.equal((await call("v1", "PUT", "/api/workspaces/aix", { name: "x", setup: WS.setup })).status, 403);
  assert.equal((await call("v1", "PATCH", "/api/workspaces/aix", { runNow: true })).data.code, "role");
  assert.equal((await call("m2", "DELETE", "/api/workspaces/aix")).status, 403);
  assert.equal((await call("m1", "PUT", "/api/workspaces/aix/integrations/bing", { apiKey: "x" })).status, 403);
  assert.equal((await call("v1", "POST", "/api/ask", { engine: "chatgpt", question: "x" })).data.code, "role");
  // ...but a viewer can ask the agent about a run; this organisation has no keys yet, so the stream says so.
  const chat = await call("v1", "POST", "/api/write", { kind: "chat", data: { question: "hi" } });
  assert.equal(chat.status, 200); assert.match(String(chat.data), /No AI key configured/);
  // Other accounts can't see the brand.
  assert.equal((await call("b2", "GET", "/api/workspaces/aix/runs")).status, 404);

  // Keys: owner adds Gemini; status shows only the last 4 characters; engines follow the organisation's keys.
  assert.equal((await call("m1", "PUT", "/api/org/keys", { keys: { GEMINI_API_KEY: "gem-123456" } })).status, 403);
  const k = await call("rahul", "PUT", "/api/org/keys", { keys: { GEMINI_API_KEY: "gem-123456" } });
  const gem = k.data.keys.find((x) => x.name === "GEMINI_API_KEY");
  assert.equal(gem.set, true); assert.equal(gem.hint, "••••3456"); assert.ok(!JSON.stringify(k.data).includes("gem-123456"));
  assert.deepEqual((await call("m1", "GET", "/api/config")).data.engines, ["gemini"]);
  assert.deepEqual((await call("op", "GET", "/api/config")).data.engines, ["gemini"]); // the operator is in AI Xccelerate right now

  // Budget: over the cap, AI calls and scheduled checks stop.
  assert.equal((await call("rahul", "PATCH", "/api/org", { monthlyCapUsd: 1 })).status, 200);
  const [org] = await sql(`select id from organizations where slug = 'ai-xccelerate'`);
  await sql(`insert into usage (org_id, kind, engine, cost_usd) values ($1, 'ask', 'chatgpt', 1.5)`, [org.id]);
  const capped = await call("m1", "POST", "/api/ask", { engine: "gemini", question: "x" });
  assert.equal(capped.status, 402); assert.equal(capped.data.code, "cap");
  assert.equal((await call("m1", "GET", "/api/config")).data.budget.over, true);
  assert.equal((await call("m1", "PATCH", "/api/workspaces/aix", { schedule: "weekly", runNow: true })).status, 200);
  assert.equal((await call("x", "POST", "/api/cron/tick", null, { "x-cron-secret": "tick-secret" })).data.ran.length, 0);
  // Raise the cap: the next tick runs the brand on the organisation's own keys (Gemini only, not the platform's OpenAI).
  assert.equal((await call("rahul", "PATCH", "/api/org", { monthlyCapUsd: null })).status, 200);
  await sql(`update workspaces set next_run_at = now() where slug = 'aix'`);
  const t = await call("x", "POST", "/api/cron/tick", null, { "x-cron-secret": "tick-secret" });
  assert.equal(t.data.ran.length, 1); assert.equal(t.data.ran[0].slug, "aix");
  const run = (await call("v1", "GET", "/api/workspaces/aix/runs/latest")).data.run;
  assert.deepEqual(run.engines, ["gemini"]);
  const usage = (await call("rahul", "GET", "/api/org")).data.usage;
  assert.ok(usage.byEngine.find((x) => x.name === "gemini" && x.calls >= 2));

  // Roles: admins can't touch the owner; the owner can hand over ownership and stays an admin.
  const ids = Object.fromEntries((await call("rahul", "GET", "/api/org")).data.members.map((m) => [m.email.split("@")[0], m.id]));
  assert.equal((await call("op", "PATCH", "/api/org/members/" + ids.rahul, { role: "viewer" })).status, 403);
  assert.equal((await call("op", "PATCH", "/api/org/members/" + ids.op, { role: "owner" })).status, 403);
  assert.equal((await call("rahul", "PATCH", "/api/org/members/" + ids.m2, { role: "viewer" })).status, 200);
  assert.equal((await call("m2", "PUT", "/api/workspaces/aix", { name: "x", setup: WS.setup })).status, 403);
  assert.equal((await call("rahul", "PATCH", "/api/org/members/" + ids.op, { role: "owner" })).status, 200);
  assert.equal((await call("rahul", "GET", "/api/me")).data.org.role, "admin");
  assert.equal((await call("op", "PATCH", "/api/org/members/" + ids.rahul, { role: "owner" })).status, 200); // and back

  // Removing someone cuts them off at once.
  assert.equal((await call("rahul", "DELETE", "/api/org/members/" + ids.v1)).status, 200);
  assert.equal((await call("v1", "GET", "/api/workspaces")).data.code, "no_org");
  assert.equal((await call("rahul", "DELETE", "/api/org/members/" + ids.rahul)).status, 403); // the owner can't leave

  // Revoked invites stop working; the audit log has the story.
  const inv = await call("rahul", "POST", "/api/org/invitations", { email: "late@ax.co", role: "viewer" });
  assert.equal((await call("rahul", "DELETE", "/api/org/invitations/" + inv.data.invite.id)).status, 200);
  assert.equal((await call("anon", "GET", "/api/invitations/" + tokenFrom(inv.data.invite.link))).status, 404);
  const log = (await call("rahul", "GET", "/api/org/audit")).data.log.map((x) => x.action);
  for (const a of ["org.created", "invite.sent", "invite.accepted", "keys.changed", "org.updated", "check.skipped", "role.changed", "owner.transferred", "member.removed", "invite.revoked"]) assert.ok(log.includes(a), a);
  assert.equal((await call("m1", "GET", "/api/org/audit")).status, 403);

  // Operators can open any organisation (logged); others can't switch into one they're not in.
  assert.equal((await call("b2", "POST", "/api/orgs/ai-xccelerate/switch")).status, 404);
  const bOrg = (await call("b2", "GET", "/api/me")).data.org.slug;
  assert.equal((await call("op", "POST", `/api/orgs/${bOrg}/switch`)).data.org.operatorVisit, true);
  assert.ok((await sql(`select 1 from audit_log where action = 'operator.visit'`)).length);
  assert.equal((await call("op", "POST", "/api/orgs/ai-xccelerate/switch")).data.org.role, "admin");

  // Moving a brand from the operator's own organisation into the client's.
  const own = (await call("op", "GET", "/api/me")).data.orgs.find((o) => o.slug !== "ai-xccelerate").slug;
  await call("op", "POST", `/api/orgs/${own}/switch`);
  assert.equal((await call("op", "PUT", "/api/workspaces/pilot", { name: "Pilot", setup: WS.setup })).status, 200);
  assert.equal((await call("op", "PATCH", "/api/workspaces/pilot", { moveTo: "ai-xccelerate" })).data.moved.to, "ai-xccelerate");
  assert.equal((await call("m1", "GET", "/api/workspaces")).data.workspaces.length, 2);

  // AI routes check who is asking before reading the body, and cap its size.
  const big = "x".repeat(3 * 1024 * 1024);
  assert.equal((await call("nobody2", "POST", "/api/ask", { pad: big })).status, 401);
  assert.equal((await call("m1", "POST", "/api/write", { kind: "chat", data: { question: big } })).status, 413);
});

test("passwords: forgot and reset by email", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  mails.length = 0;
  assert.equal((await call("anon", "POST", "/api/auth/forgot", { email: "nobody@x.co" })).status, 200); // same answer, no email
  await new Promise((r) => setTimeout(r, 100)); assert.equal(mails.length, 0);
  assert.equal((await call("anon", "POST", "/api/auth/forgot", { email: "m1@ax.co" })).status, 200);
  for (let i = 0; i < 50 && !mails.length; i++) await new Promise((r) => setTimeout(r, 20)); // sent after the answer
  assert.equal(mails.length, 1); assert.match(mails[0].text, /#reset=/);
  const token = tokenFrom(mails[0].text.match(/https?:\S+/)[0]);
  assert.equal((await call("m1r", "POST", "/api/auth/reset", { token, password: "short" })).status, 400);
  assert.equal((await call("m1r", "POST", "/api/auth/reset", { token, password: "brand-new-pass" })).status, 200);
  assert.equal((await call("m1r", "POST", "/api/auth/reset", { token, password: "brand-new-pass" })).status, 400); // once
  assert.equal((await call("m1", "GET", "/api/me")).data.user, null); // old sessions ended
  assert.equal((await call("m1x", "POST", "/api/auth/login", { email: "m1@ax.co", password: "member-pass-1" })).status, 401);
  assert.equal((await call("m1x", "POST", "/api/auth/login", { email: "m1@ax.co", password: "brand-new-pass" })).status, 200);
});

// ── paid plans: catalogue, checkout authorisation, signed idempotent webhooks ──
const crypto = await import("node:crypto");
const WHSEC = "whsec_test_only";
async function hook(evt, id, { secret = WHSEC, sig } = {}) {
  const raw = JSON.stringify(evt);
  const s = sig ?? crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const r = await fetch(base + "/api/webhooks/razorpay", { method: "POST", headers: { "content-type": "application/json", "x-razorpay-signature": s, ...(id ? { "x-razorpay-event-id": id } : {}) }, body: raw });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const unix = (d) => Math.floor(new Date(d).getTime() / 1000);
const subEvt = (event, sub, at = Date.now()) => ({ entity: "event", event, created_at: unix(at), payload: { subscription: { entity: { id: "sub_test_1", plan_id: "plan_growth_inr", status: "active", current_start: unix(Date.now()), current_end: unix(Date.now() + 30 * 864e5), notes: {}, ...sub } } } });
export const fakeRzp = { calls: [], createSubscription: async (a) => { fakeRzp.calls.push(["create", a]); return { id: "sub_test_1", status: "created", short_url: "https://rzp.io/x" }; },
  cancelSubscription: async (id) => { fakeRzp.calls.push(["cancel", id]); return { id, status: "active" }; },
  updateSubscription: async (id, a) => { fakeRzp.calls.push(["update", id, a]); return { id, status: "active" }; },
  fetchSubscription: async (id) => { fakeRzp.calls.push(["fetch", id]); return { id, status: "active" }; } };

test("billing: catalogue, checkout authorisation and idempotent webhooks", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  (await import("../../server/razorpay.mjs")).setClient(fakeRzp);
  const plans = await call("anon", "GET", "/api/billing/plans");
  assert.equal(plans.status, 200); assert.equal(plans.data.monthlyOnly, true);
  assert.equal(plans.data.plans.find((p) => p.code === "growth").prices.USD, 9900);
  assert.doesNotMatch(JSON.stringify(plans.data), /razorpay|plan_id|secret/i);

  // An owner with an editor, both fresh.
  assert.equal((await call("pay", "POST", "/api/auth/signup", { email: "pay@x.co", password: "pay-pass-123" }, { "x-forwarded-for": "10.9.0.1" })).status, 200);
  const inv = await call("pay", "POST", "/api/org/invitations", { email: "ed@x.co", role: "editor" });
  assert.equal((await call("ed", "POST", "/api/auth/signup", { email: "ed@x.co", password: "ed-pass-1234", invite: tokenFrom(inv.data.invite.link) }, { "x-forwarded-for": "10.9.0.2" })).status, 200);
  const slug = (await call("pay", "GET", "/api/me")).data.org.slug;
  const [org] = await sql(`select id from organizations where slug = $1`, [slug]);
  let bill = (await call("pay", "GET", "/api/billing")).data;
  assert.equal(bill.plan.code, "legacy"); assert.equal(bill.mode, "write"); assert.equal(bill.canCheckout, false); // billing is off by default
  assert.equal((await call("anon", "GET", "/api/billing")).status, 401);

  // Who and what may start checkout.
  assert.equal((await call("ed", "POST", "/api/billing/checkout", { plan: "growth", currency: "INR" })).status, 403);
  assert.equal((await call("pay", "POST", "/api/billing/checkout", { plan: "made-up", currency: "USD" })).status, 400);
  assert.equal((await call("pay", "POST", "/api/billing/checkout", { plan: "enterprise", currency: "USD" })).status, 400);
  assert.equal((await call("pay", "POST", "/api/billing/checkout", { plan: "growth", currency: "EUR" })).status, 400);
  assert.equal((await call("pay", "POST", "/api/billing/checkout", { plan: "growth", currency: "INR" })).data.code, "billing_disabled");
  process.env.BILLING_ENABLED = "operators";
  assert.equal((await call("pay", "POST", "/api/billing/checkout", { plan: "growth", currency: "INR" })).data.code, "billing_operators_only");
  Object.assign(process.env, { BILLING_ENABLED: "1", RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "rzp_secret_x", RAZORPAY_WEBHOOK_SECRET: WHSEC });
  assert.equal((await call("pay", "POST", "/api/billing/checkout", { plan: "growth", currency: "INR" })).data.code, "plan_unavailable"); // no plan id configured
  Object.assign(process.env, { RAZORPAY_PLAN_GROWTH_INR: "plan_growth_inr", RAZORPAY_PLAN_STARTER_INR: "plan_starter_inr", RAZORPAY_PLAN_AGENCY_INR: "plan_agency_inr" });
  const co = await call("pay", "POST", "/api/billing/checkout", { plan: "growth", currency: "INR", planId: "plan_evil", amount: 1 });
  assert.equal(co.status, 200);
  assert.deepEqual({ ...co.data, name: undefined }, { subscriptionId: "sub_test_1", keyId: "rzp_test_key", plan: "growth", currency: "INR", amount: 999900, name: undefined, testMode: true });
  assert.equal(fakeRzp.calls.at(-1)[1].planId, "plan_growth_inr"); assert.equal(fakeRzp.calls.at(-1)[1].orgId, org.id);
  assert.ok(!JSON.stringify(co.data).includes("rzp_secret_x"));
  // Checking out changes nothing until Razorpay says so.
  assert.equal((await call("pay", "GET", "/api/billing")).data.plan.code, "legacy");

  // Webhooks: signature on the raw body, required.
  assert.equal((await hook(subEvt("subscription.activated"), "evt_1", { sig: "" })).status, 400);
  assert.equal((await hook(subEvt("subscription.activated"), "evt_1", { secret: "wrong" })).status, 400);
  assert.equal((await sql(`select count(*)::int as n from billing_events`))[0].n, 0);
  const act = subEvt("subscription.activated");
  assert.equal((await hook(act, "evt_1")).status, 200);
  bill = (await call("ed", "GET", "/api/billing")).data;
  assert.equal(bill.plan.code, "growth"); assert.equal(bill.plan.status, "active"); assert.equal(bill.plan.currency, "INR");
  assert.equal(bill.entitlements.questions, 30); assert.equal(bill.plan.subscriptionId, undefined); // payment ids are for admins
  // The same event again (Razorpay retries) changes nothing and is recorded once.
  const dup = await hook(act, "evt_1"); assert.equal(dup.status, 200); assert.equal(dup.data.duplicate, true);
  assert.equal((await sql(`select count(*)::int as n from billing_events where event_id = 'evt_1'`))[0].n, 1);
  assert.equal((await sql(`select count(*)::int as n from audit_log where org_id = $1 and action = 'billing.subscription.activated'`, [org.id]))[0].n, 1);
  const [stored] = await sql(`select payload, org_id, status from billing_events where event_id = 'evt_1'`);
  assert.equal(stored.org_id, org.id); assert.equal(stored.status, "processed"); assert.equal(stored.payload.subscription.id, "sub_test_1");
  // An event nobody owns is recorded and ignored.
  assert.equal((await hook(subEvt("subscription.activated", { id: "sub_other" }), "evt_x")).status, 200);
  assert.equal((await sql(`select status from billing_events where event_id = 'evt_x'`))[0].status, "ignored");
  // Another organisation is untouched and cannot see this one's billing.
  assert.equal((await call("b2", "GET", "/api/billing")).data.plan.code, "legacy");

  // Plan changes: a downgrade waits for the period end; an upgrade waits for Razorpay to charge.
  assert.equal((await call("ed", "POST", "/api/billing/change-plan", { plan: "starter" })).status, 403);
  const down = await call("pay", "POST", "/api/billing/change-plan", { plan: "starter" });
  assert.equal(down.status, 200); assert.equal(down.data.plan.pendingPlan, "starter"); assert.equal(down.data.plan.code, "growth");
  assert.deepEqual(fakeRzp.calls.at(-1), ["update", "sub_test_1", { planId: "plan_starter_inr", at: "cycle_end" }]);
  const up = await call("pay", "POST", "/api/billing/change-plan", { plan: "agency" });
  assert.equal(up.data.plan.code, "growth"); assert.equal(up.data.plan.pendingPlan, null);
  assert.deepEqual(fakeRzp.calls.at(-1), ["update", "sub_test_1", { planId: "plan_agency_inr", at: "now" }]);
  assert.equal((await hook(subEvt("subscription.charged", { plan_id: "plan_agency_inr" }), "evt_2")).status, 200);
  assert.equal((await call("pay", "GET", "/api/billing")).data.plan.code, "agency");

  // Failed renewal: three days of grace, then read-only. Reports stay readable.
  assert.equal((await hook(subEvt("subscription.pending", { status: "pending" }), "evt_3")).status, 200);
  bill = (await call("pay", "GET", "/api/billing")).data;
  assert.equal(bill.plan.status, "past_due"); assert.equal(bill.mode, "manual");
  assert.ok(new Date(bill.period.graceEndsAt) > Date.now() + 2.9 * 864e5);
  // An older event arriving late is ignored.
  assert.equal((await hook(subEvt("subscription.charged", {}, Date.now() - 864e5), "evt_old")).status, 200);
  assert.equal((await sql(`select status from billing_events where event_id = 'evt_old'`))[0].status, "ignored");
  assert.equal((await call("pay", "GET", "/api/billing")).data.plan.status, "past_due");
  assert.equal((await hook(subEvt("subscription.charged", { plan_id: "plan_agency_inr" }), "evt_4")).status, 200);
  assert.equal((await call("pay", "GET", "/api/billing")).data.plan.status, "active");

  // Cancellation: owner only; access continues to the end of the paid period.
  assert.equal((await call("ed", "POST", "/api/billing/cancel")).status, 403);
  const cancel = await call("pay", "POST", "/api/billing/cancel");
  assert.equal(cancel.status, 200); assert.equal(cancel.data.plan.cancelAtPeriodEnd, true); assert.equal(cancel.data.plan.status, "active");
  assert.equal((await hook(subEvt("subscription.cancelled", { status: "cancelled" }), "evt_5")).status, 200);
  bill = (await call("pay", "GET", "/api/billing")).data;
  assert.equal(bill.plan.status, "canceled"); assert.equal(bill.mode, "write");
  await sql(`update organizations set current_period_end = now() - interval '1 minute' where id = $1`, [org.id]);
  assert.equal((await call("pay", "GET", "/api/billing")).data.mode, "read");

  for (const k of ["BILLING_ENABLED", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "RAZORPAY_PLAN_GROWTH_INR", "RAZORPAY_PLAN_STARTER_INR", "RAZORPAY_PLAN_AGENCY_INR"]) delete process.env[k];
});

// ── plan limits at every cost boundary ──
test("billing: plan limits are enforced on the server", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  assert.equal((await call("st", "POST", "/api/auth/signup", { email: "st@x.co", password: "starter-pass1" }, { "x-forwarded-for": "10.9.0.3" })).status, 200);
  const slug = (await call("st", "GET", "/api/me")).data.org.slug;
  const [org] = await sql(`update organizations set plan_code = 'starter', billing_status = 'active', current_period_start = now(), current_period_end = now() + interval '30 days' where slug = $1 returning id`, [slug]);
  const S = WS.setup, qs = (n) => Array.from({ length: n }, (_, i) => ({ text: "q" + i, on: true }));

  // Brands, questions, competitors, engines.
  assert.equal((await call("st", "PUT", "/api/workspaces/first", { name: "First", site: "https://first.example", setup: S })).status, 200);
  const second = await call("st", "PUT", "/api/workspaces/second", { name: "Second", site: "https://second.example", setup: S });
  assert.equal(second.status, 402); assert.equal(second.data.code, "plan_limit"); assert.equal(second.data.capability, "brands");
  assert.equal(second.data.recommendedPlan, "growth"); assert.equal(second.data.error, "Starter includes 1 brand. Upgrade to Growth to continue.");
  assert.equal((await call("st", "PUT", "/api/workspaces/first", { name: "First", setup: { ...S, questions: qs(16) } })).data.capability, "questions");
  assert.equal((await call("st", "PUT", "/api/workspaces/first", { name: "First", setup: { ...S, questions: qs(15) } })).status, 200);
  assert.equal((await call("st", "PUT", "/api/workspaces/first", { name: "First", setup: { ...S, profile: { ...S.profile, competitors: ["a", "b", "c", "d"] } } })).data.capability, "competitors");
  assert.equal((await call("st", "PUT", "/api/workspaces/first", { name: "First", setup: { ...S, engines: ["chatgpt", "aio"] } })).data.capability, "engines");
  assert.equal((await call("st", "PATCH", "/api/workspaces/first", { setup: { questions: qs(20) } })).data.capability, "questions");
  assert.equal((await call("st", "PUT", "/api/workspaces/first", { name: "First", setup: S })).status, 200);

  // Schedule, samples, seats, integrations.
  assert.equal((await call("st", "PATCH", "/api/workspaces/first", { schedule: "daily" })).data.capability, "schedule");
  assert.equal((await call("st", "PATCH", "/api/workspaces/first", { schedule: "rotating" })).data.capability, "schedule");
  assert.equal((await call("st", "PATCH", "/api/workspaces/first", { samples: 2 })).data.capability, "samples");
  assert.equal((await call("st", "PATCH", "/api/workspaces/first", { schedule: "weekly" })).status, 200);
  assert.equal((await call("st", "POST", "/api/org/invitations", { email: "seat2@x.co", role: "viewer" })).data.capability, "seats");
  assert.equal((await call("st", "PUT", "/api/workspaces/first/integrations/google", { property: "x" })).data.capability, "integrations");
  assert.equal((await call("st", "GET", "/api/oauth/google/start?ws=first")).data.capability, "integrations");

  // AI: engines outside the plan and action drafts past the monthly allowance are refused before any call.
  const askAio = await call("st", "POST", "/api/ask", { engine: "aio", question: "x" }, { "x-wp-brand": "first" });
  assert.equal(askAio.status, 402); assert.equal(askAio.data.capability, "engines");
  await sql(`insert into usage (org_id, kind, n, cost_usd) values ($1, 'draft', 10, 0.02)`, [org.id]);
  const pitch = await call("st", "POST", "/api/write", { kind: "pitch", data: {} });
  assert.equal(pitch.data.capability, "actionDrafts"); assert.equal(pitch.data.used, 10); assert.equal(pitch.data.limit, 10);
  const bill = (await call("st", "GET", "/api/billing")).data;
  assert.equal(bill.usage.actionDrafts, 10); assert.equal(bill.usage.brands, 1); assert.equal(bill.entitlements.brands, 1);
  assert.equal((await call("st", "GET", "/api/config")).data.billing.plan.code, "starter");

  // Grace: people may still work, but the scheduler does not spend.
  await sql(`update organizations set billing_status = 'past_due', grace_ends_at = now() + interval '2 days' where id = $1`, [org.id]);
  assert.equal((await call("st", "PATCH", "/api/workspaces/first", { runNow: true })).status, 200);
  const before = (await sql(`select count(*)::int as n from runs r join workspaces w on w.id = r.workspace_id where w.org_id = $1`, [org.id]))[0].n;
  assert.ok(!(await call("x", "POST", "/api/cron/tick", null, { "x-cron-secret": "tick-secret" })).data.ran.find((r) => r.slug === "first"));
  assert.equal((await sql(`select count(*)::int as n from runs r join workspaces w on w.id = r.workspace_id where w.org_id = $1`, [org.id]))[0].n, before);
  assert.ok((await sql(`select 1 from audit_log where org_id = $1 and action = 'check.skipped' and detail->>'reason' = 'billing_read_only'`, [org.id])).length);

  // After grace: read-only. New AI work stops; reports stay readable.
  await sql(`update organizations set grace_ends_at = now() - interval '1 minute' where id = $1`, [org.id]);
  const ro = await call("st", "POST", "/api/ask", { engine: "chatgpt", question: "x" });
  assert.equal(ro.status, 402); assert.equal(ro.data.code, "billing_read_only");
  assert.equal((await call("st", "PATCH", "/api/workspaces/first", { runNow: true })).data.code, "billing_read_only");
  assert.equal((await call("st", "GET", "/api/workspaces/first/runs")).status, 200);
  assert.equal((await call("st", "GET", "/api/workspaces")).status, 200);

  // Trend window: Starter shows six months; older evidence is kept but not shown.
  await sql(`update organizations set billing_status = 'active' where id = $1`, [org.id]);
  const [w] = await sql(`select id from workspaces where org_id = $1 and slug = 'first'`, [org.id]);
  await sql(`insert into runs (id, workspace_id, status, started_at, summary) values ('old1', $1, 'done', now() - interval '8 months', '{}'), ('new1', $1, 'done', now() - interval '1 month', '{}')`, [w.id]);
  const ids = (await call("st", "GET", "/api/workspaces/first/runs")).data.runs.map((r) => r.id);
  assert.ok(ids.includes("new1") && !ids.includes("old1"));
  assert.equal((await sql(`select count(*)::int as n from runs where id = 'old1'`))[0].n, 1);

  // Legacy organisations are untouched by any of this (the earlier tests ran on legacy).
  assert.equal((await sql(`select plan_code from organizations where slug = 'ai-xccelerate'`))[0].plan_code, "legacy");
});

test("billing: new self-serve organisations get a capped trial once billing is on", { skip: !DB && "set TEST_DATABASE_URL" }, async () => {
  process.env.BILLING_ENABLED = "1";
  try {
    mails.length = 0;
    assert.equal((await call("tr", "POST", "/api/auth/signup", { email: "tr@x.co", password: "trial-pass-1" }, { "x-forwarded-for": "10.9.0.4" })).status, 200);
    const slug = (await call("tr", "GET", "/api/me")).data.org.slug;
    let [o] = await sql(`select plan_code, billing_status, trial_ends_at from organizations where slug = $1`, [slug]);
    assert.deepEqual(o, { plan_code: "trial", billing_status: "trialing", trial_ends_at: null });
    // Nothing spends until the email is verified.
    assert.equal((await call("tr", "POST", "/api/write", { kind: "pitch", data: {} })).data.code, "email_verification_required");
    assert.equal((await call("tr", "PUT", "/api/workspaces/t1", { name: "T", setup: WS.setup })).data.code, "email_verification_required");
    for (let i = 0; i < 50 && !mails.length; i++) await new Promise((r) => setTimeout(r, 20));
    const token = mails.find((m) => m.to === "tr@x.co").text.match(/#verify=([\w-]+)/)[1];
    assert.equal((await call("tr", "POST", "/api/auth/verify", { token })).status, 200);
    [o] = await sql(`select trial_started_at, trial_ends_at from organizations where slug = $1`, [slug]);
    const days = (new Date(o.trial_ends_at) - new Date(o.trial_started_at)) / 864e5;
    assert.ok(Math.abs(days - 7) < 0.01, String(days));
    assert.equal((await call("tr", "PUT", "/api/workspaces/t1", { name: "T", setup: WS.setup })).status, 200);
    assert.equal((await call("tr", "PATCH", "/api/workspaces/t1", { schedule: "weekly" })).data.capability, "schedule");
    // Two trial checks, then the trial is used up.
    for (const id of ["tr1", "tr2"]) assert.equal((await call("tr", "PUT", "/api/runs/" + id, { slug: "t1", data: { startedAt: Date.now() } })).status, 200);
    assert.equal((await call("tr", "PUT", "/api/runs/tr2", { slug: "t1", data: { startedAt: Date.now(), finishedAt: Date.now() } })).status, 200); // saving an existing run is fine
    assert.equal((await call("tr", "PUT", "/api/runs/tr3", { slug: "t1", data: { startedAt: Date.now() } })).data.capability, "baselineRuns");
  } finally { delete process.env.BILLING_ENABLED; }
});
