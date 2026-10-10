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
