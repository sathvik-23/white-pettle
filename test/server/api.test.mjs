// The real HTTP app against a real Postgres. Skipped unless TEST_DATABASE_URL is set (CI sets it; see ci.yml).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { fakes, WS } from "./_fake.mjs";

const DB = process.env.TEST_DATABASE_URL;
let app, base;
const jar = {};
async function call(who, method, path, body, headers = {}) {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(jar[who] ? { cookie: jar[who] } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  const set = r.headers.get("set-cookie"); if (set) jar[who] = set.split(";")[0];
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

before(async () => {
  if (!DB) return;
  const c = new pg.Client({ connectionString: DB }); await c.connect(); await c.query("drop schema if exists whitepetal cascade"); await c.end();
  Object.assign(process.env, { DATABASE_URL: DB, CRON_SECRET: "tick-secret", APP_SECRET: "test", OPENAI_API_KEY: "fake", GEMINI_API_KEY: "fake", ACCESS_CODE: "" });
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
