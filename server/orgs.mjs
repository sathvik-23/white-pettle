// Organisations, roles, invitations, per-organisation AI keys, usage metering and the audit log.
//
// Roles, lowest to highest: viewer (reads and comments), editor (runs checks, edits prompts, writes drafts),
// admin (people, keys, integrations, deleting brands), owner (all of that, plus ownership). A platform
// operator (PLATFORM_OPERATORS, comma-separated emails) can create organisations for clients and open any
// organisation as an admin; every such visit is written to that organisation's audit log.
import { AsyncLocalStorage } from "node:async_hooks";
import { q, one, tx } from "./db.mjs";
import { seal, unseal, newToken, tokenId } from "./security.mjs";
import { fail } from "./http.mjs";
import { slugify, normEmail } from "./util.mjs";

export const ROLES = ["viewer", "editor", "admin", "owner"];
export const rank = (r) => ROLES.indexOf(r);
export const can = (role, min) => rank(role) >= rank(min);
const ROLE_NEED = { viewer: "You need to be a member of this organisation.", editor: "Viewers can look but not change anything. Ask an admin to make you an editor.", admin: "Only an admin or the owner can do that.", owner: "Only the owner can do that." };
export const needRole = (ctx, min) => { if (!can(ctx.role, min)) fail(403, ROLE_NEED[min], { code: "role", need: min }); };

export const operators = () => String(process.env.PLATFORM_OPERATORS || "").toLowerCase().split(/[\s,]+/).filter(Boolean);
// Only for an address the person has proved they own (an emailed link or a verified Google sign-in): otherwise
// anyone could sign up with an operator's email before the operator does.
export const isOperator = (u) => !!u?.email && !!u.email_verified_at && operators().includes(normEmail(u.email));

// ── organisation context ──────────────────────────────────────────────────────
export async function orgsOf(userId) {
  return q(`select o.id, o.slug, o.name, m.role from memberships m join organizations o on o.id = m.org_id
            where m.user_id = $1 order by m.created_at, o.name`, [userId]);
}
// The organisation this request works in: the session's choice if still allowed, else the first membership.
export async function context(user) {
  const orgs = await orgsOf(user.id);
  const operator = isOperator(user);
  let org = null, role = null, operatorVisit = false;
  if (user.session_org) {
    const m = orgs.find((o) => o.id === user.session_org);
    if (m) { org = m; role = m.role; }
    else if (operator) { org = await one(`select id, slug, name from organizations where id = $1`, [user.session_org]); if (org) { role = "admin"; operatorVisit = true; } }
  }
  if (!org && orgs.length) { org = orgs[0]; role = orgs[0].role; }
  return { user, org, role, orgs, operator, operatorVisit };
}
export const orgOut = (ctx) => ctx.org ? { id: ctx.org.id, slug: ctx.org.slug, name: ctx.org.name, role: ctx.role, operatorVisit: ctx.operatorVisit } : null;

export async function uniqueOrgSlug(name) {
  const base = slugify(name).slice(0, 40) || "org";
  for (let i = 1; i < 50; i++) { const s = i === 1 ? base : `${base}-${i}`; if (!(await one(`select 1 from organizations where slug = $1`, [s]))) return s; }
  return `${base}-${Date.now().toString(36)}`;
}
export async function createOrg({ name, by, role = "owner", allowPlatformKeys = false }) {
  const slug = await uniqueOrgSlug(name);
  return tx(async (c) => {
    const o = (await c.query(`insert into organizations (slug, name, created_by, allow_platform_keys) values ($1, $2, $3, $4) returning *`, [slug, String(name).trim().slice(0, 80), by || null, !!allowPlatformKeys])).rows[0];
    if (by) await c.query(`insert into memberships (org_id, user_id, role) values ($1, $2, $3)`, [o.id, by, role]);
    return o;
  });
}

// ── people ────────────────────────────────────────────────────────────────────
export async function members(orgId) {
  return q(`select u.id, u.email, u.name, m.role, m.created_at as joined_at, u.last_login_at from memberships m join users u on u.id = m.user_id
            where m.org_id = $1 order by case m.role when 'owner' then 0 when 'admin' then 1 when 'editor' then 2 else 3 end, u.email`, [orgId]);
}
export async function pendingInvites(orgId) {
  return q(`select i.id, i.email, i.role, i.created_at, i.expires_at, u.email as invited_by from invitations i left join users u on u.id = i.invited_by
            where i.org_id = $1 and i.accepted_at is null and i.revoked_at is null and i.expires_at > now() order by i.created_at desc`, [orgId]);
}
export const INVITE_DAYS = 7;
export async function createInvite({ orgId, email, role, by }) {
  const token = newToken();
  await q(`update invitations set revoked_at = now() where org_id = $1 and lower(email) = $2 and accepted_at is null and revoked_at is null`, [orgId, normEmail(email)]);
  const inv = await one(`insert into invitations (org_id, email, role, token_hash, invited_by, expires_at) values ($1, $2, $3, $4, $5, now() + interval '${INVITE_DAYS} days') returning id, email, role, expires_at`,
    [orgId, normEmail(email), role, tokenId(token), by || null]);
  return { invite: inv, token };
}
export async function findInvite(token) {
  if (!token) return null;
  return one(`select i.*, o.name as org_name, o.slug as org_slug, u.name as inviter_name, u.email as inviter_email
              from invitations i join organizations o on o.id = i.org_id left join users u on u.id = i.invited_by
              where i.token_hash = $1 and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()`, [tokenId(token)]);
}
// Accept atomically: the invite must still be open at the moment of accepting (not just when it was looked up).
// Pass `c` (a transaction client) to make it part of a larger transaction, such as creating the account.
export async function acceptInvite(inv, user, c = null) {
  if (normEmail(inv.email) !== normEmail(user.email)) fail(403, `This invite is for ${inv.email}. Sign in with that email to accept it.`, { code: "invite_email" });
  const run = async (c) => {
    const open = (await c.query(`update invitations set accepted_at = now() where id = $1 and accepted_at is null and revoked_at is null and expires_at > now() returning org_id, role`, [inv.id])).rows[0];
    if (!open) fail(400, "This invite link has expired or was already used. Ask for a new one.", { code: "invite_gone" });
    if (open.role === "owner") {
      const cur = (await c.query(`select user_id from memberships where org_id = $1 and role = 'owner' for update`, [open.org_id])).rows[0];
      if (cur && cur.user_id !== user.id) fail(409, "This organisation already has an owner. Ask them to hand over ownership instead.");
    }
    const have = (await c.query(`select role from memberships where org_id = $1 and user_id = $2 for update`, [open.org_id, user.id])).rows[0];
    if (!have) await c.query(`insert into memberships (org_id, user_id, role) values ($1, $2, $3)`, [open.org_id, user.id, open.role]);
    else if (rank(open.role) > rank(have.role)) await c.query(`update memberships set role = $3 where org_id = $1 and user_id = $2`, [open.org_id, user.id, open.role]);
    // Opening the emailed link proves the address.
    await c.query(`update users set email_verified_at = coalesce(email_verified_at, now()) where id = $1`, [user.id]);
    await c.query(`insert into audit_log (org_id, user_id, action, target, detail) values ($1, $2, 'invite.accepted', $3, $4)`, [open.org_id, user.id, user.email, { role: open.role }]);
    return { orgId: open.org_id, role: have && rank(have.role) >= rank(open.role) ? have.role : open.role };
  };
  return c ? run(c) : tx(run);
}

// ── AI keys per organisation ──────────────────────────────────────────────────
// The engines read their keys through env() in api/_lib.js. Inside withEnv() that returns the organisation's keys
// (and, only where the organisation allows it, the platform's), so one server can serve many organisations.
export const KEY_NAMES = ["OPENAI_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "ANTHROPIC_API_KEY", "DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD", "SERPAPI_KEY", "GOOGLE_API_KEY"];
export const KEY_LABELS = { OPENAI_API_KEY: "OpenAI (ChatGPT)", PERPLEXITY_API_KEY: "Perplexity", GEMINI_API_KEY: "Google Gemini", GROQ_API_KEY: "Groq", ANTHROPIC_API_KEY: "Anthropic (Claude)", DATAFORSEO_LOGIN: "DataForSEO login", DATAFORSEO_PASSWORD: "DataForSEO password", SERPAPI_KEY: "SerpApi", GOOGLE_API_KEY: "Google API key (Knowledge Graph, free)" };
const als = new AsyncLocalStorage();
globalThis.__wpEnvOverride = () => als.getStore();
export const withEnv = (env, fn) => als.run(env, fn);
export async function orgKeys(orgId) {
  const r = await one(`select keys, allow_platform_keys from organizations where id = $1`, [orgId]);
  return { keys: unseal(r?.keys), allowPlatform: !!r?.allow_platform_keys };
}
export function envFor({ keys, allowPlatform }) {
  const o = {};
  for (const k of KEY_NAMES) o[k] = keys?.[k] || (allowPlatform ? process.env[k] || "" : "");
  return o;
}
export async function withOrgKeys(orgId, fn) { return withEnv(envFor(await orgKeys(orgId)), fn); }
export async function setKeys(orgId, patch) {
  const { keys } = await orgKeys(orgId);
  const changed = [];
  for (const k of KEY_NAMES) {
    if (!(k in patch)) continue;
    const v = patch[k] == null ? "" : String(patch[k]).trim();
    if (v.length > 400) fail(400, `${KEY_LABELS[k]} key looks too long.`);
    if (v) { if (keys[k] !== v) { keys[k] = v; changed.push(k); } } else if (keys[k]) { delete keys[k]; changed.push(k); }
  }
  await q(`update organizations set keys = $2, updated_at = now() where id = $1`, [orgId, seal(keys)]);
  return changed;
}
export function keyStatus({ keys, allowPlatform }) {
  return KEY_NAMES.map((k) => ({ name: k, label: KEY_LABELS[k], set: !!keys[k], hint: keys[k] ? "••••" + String(keys[k]).slice(-4) : null, platform: !keys[k] && allowPlatform && !!process.env[k] }));
}

// ── usage and the monthly cap ─────────────────────────────────────────────────
// Estimated list prices per call (USD), from docs/gcp-cost-plan.md. Real bills come from each provider; these
// exist to show the trend and stop runaway spend, so they err high.
export const COST = { ask: { chatgpt: 0.0145, perplexity: 0.0065, gemini: 0.004, groq: 0, aio: 0.003, aimode: 0.003, claude: 0.012 }, write: 0.002, draft: 0.002, inspect: 0.0005, site: 0.001, serp: 0.002, entity: 0 };
// Writing is priced by the size of what was sent too (about $1 per million input tokens, ~4 characters a token),
// so a huge prompt counts for what it costs rather than as one flat call.
export const costOf = (kind, engine, bytes = 0) => { const c = COST[kind]; const base = typeof c === "number" ? c : c?.[engine] ?? 0.01; return kind === "write" || kind === "draft" ? base + (bytes / 4) * 1e-6 : base; };
export async function meter({ orgId, workspaceId = null, userId = null, kind, engine = null, n = 1, bytes = 0 }) {
  if (!orgId || !n) return;
  await q(`insert into usage (org_id, workspace_id, user_id, kind, engine, n, cost_usd) values ($1, $2, $3, $4, $5, $6, $7)`,
    [orgId, workspaceId, userId, kind, engine, n, +(costOf(kind, engine, bytes) * n).toFixed(5)]).catch((e) => console.warn("[usage]", e.message));
}
export async function capState(orgId) {
  const r = await one(`select o.monthly_cap_usd as cap, (select coalesce(sum(cost_usd), 0) from usage u where u.org_id = o.id and u.at >= date_trunc('month', now())) as spent
                       from organizations o where o.id = $1`, [orgId]);
  const cap = r?.cap == null ? null : Number(r.cap), spent = Number(r?.spent || 0);
  return { cap, spent: +spent.toFixed(2), pct: cap ? Math.min(1, spent / cap) : null, warn: cap != null && spent >= 0.8 * cap, over: cap != null && spent >= cap };
}
export async function needBudget(orgId) {
  const s = await capState(orgId);
  if (s.over) fail(402, `This organisation has used its monthly AI budget ($${s.spent} of $${s.cap}). An admin can raise it in Team & keys.`, { code: "cap" });
  return s;
}
export async function usageSummary(orgId) {
  const month = `u.org_id = $1 and u.at >= date_trunc('month', now())`;
  const [byEngine, byPerson, byBrand, months] = await Promise.all([
    q(`select coalesce(engine, kind) as name, sum(n)::int as calls, round(sum(cost_usd)::numeric, 2)::float as usd from usage u where ${month} group by 1 order by usd desc`, [orgId]),
    q(`select coalesce(us.email, 'Scheduled checks') as name, sum(u.n)::int as calls, round(sum(u.cost_usd)::numeric, 2)::float as usd from usage u left join users us on us.id = u.user_id where ${month} group by 1 order by usd desc`, [orgId]),
    q(`select coalesce(w.name, '—') as name, sum(u.n)::int as calls, round(sum(u.cost_usd)::numeric, 2)::float as usd from usage u left join workspaces w on w.id = u.workspace_id where ${month} group by 1 order by usd desc`, [orgId]),
    q(`select to_char(date_trunc('month', at), 'YYYY-MM') as month, round(sum(cost_usd)::numeric, 2)::float as usd from usage where org_id = $1 and at >= date_trunc('month', now()) - interval '5 months' group by 1 order by 1`, [orgId]),
  ]);
  return { byEngine, byPerson, byBrand, months, cap: await capState(orgId) };
}

// ── audit log ─────────────────────────────────────────────────────────────────
export async function audit(orgId, userId, action, target = null, detail = {}) {
  await q(`insert into audit_log (org_id, user_id, action, target, detail) values ($1, $2, $3, $4, $5)`, [orgId || null, userId || null, action, target, detail || {}]).catch((e) => console.warn("[audit]", e.message));
}
export async function auditLog(orgId, limit = 200) {
  return q(`select a.at, a.action, a.target, a.detail, u.email as who from audit_log a left join users u on u.id = a.user_id where a.org_id = $1 order by a.at desc limit $2`, [orgId, limit]);
}
