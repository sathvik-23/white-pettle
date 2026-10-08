// Postgres. Optional: without DATABASE_URL the app still runs, keeping data in the visitor's browser like before.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { ROOT } from "./env.mjs";

export const SCHEMA = "whitepetal";
let pool = null;
export const hasDb = () => !!pool;

export function connect(url = process.env.DATABASE_URL) {
  if (!url) return null;
  // max 3: perfstaq-pg (db-f1-micro) allows 25 connections in total, shared with PerfStaq, and Cloud Run may run
  // up to 3 White Petal instances. 3 × 3 = 9 leaves PerfStaq its headroom.
  // search_path as a startup option, so every pooled connection has it from the first query (no racing `set`).
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${SCHEMA},public`, max: Number(process.env.PG_POOL_MAX || 3), idleTimeoutMillis: 10000, connectionTimeoutMillis: 8000 });
  pool.on("error", (e) => console.error("[db] idle client error:", e.message));
  return pool;
}
export async function q(text, params = []) { if (!pool) throw new Error("No database configured"); return (await pool.query(text, params)).rows; }
export async function one(text, params = []) { return (await q(text, params))[0] || null; }
export async function tx(fn) {
  const c = await pool.connect();
  try { await c.query("begin"); const out = await fn(c); await c.query("commit"); return out; }
  catch (e) { await c.query("rollback").catch(() => {}); throw e; }
  finally { c.release(); }
}
export async function ping() { if (!pool) return false; try { await pool.query("select 1"); return true; } catch { return false; } }
export async function close() { if (pool) await pool.end().catch(() => {}); pool = null; }

// Migrations run at boot, under an advisory lock, so two instances starting together cannot both apply one.
// Plain numbered SQL files; each runs once, in a transaction, recorded in schema_migrations.
export async function migrate() {
  const dir = path.join(ROOT, "server", "migrations");
  const files = fs.readdirSync(dir).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
  const c = await pool.connect();
  try {
    await c.query("select pg_advisory_lock(hashtext('whitepetal_migrate'))");
    await c.query(`create schema if not exists ${SCHEMA}`);
    await c.query(`set search_path to ${SCHEMA}, public`);
    await c.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const done = new Set((await c.query("select name from schema_migrations")).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), "utf8");
      await c.query("begin");
      try { await c.query(sql); await c.query("insert into schema_migrations(name) values ($1)", [f]); await c.query("commit"); console.log(`[db] applied ${f}`); }
      catch (e) { await c.query("rollback"); throw new Error(`Migration ${f} failed: ${e.message}`); }
    }
  } finally { await c.query("select pg_advisory_unlock(hashtext('whitepetal_migrate'))").catch(() => {}); c.release(); }
}
